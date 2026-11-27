import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { CustomerLink, PlanStep, Question, StepState } from '../../miniprogram/core/agent';
import { isObject, nullablePrice } from '../../miniprogram/core/orders';
import { resolveCustomerMention, type CustomerDirectory } from '../../miniprogram/core/memory';
import { spokenNumbers } from '../../miniprogram/core/spoken-numbers';
import { textOrderQuestions } from '../../miniprogram/core/text-order';
import { previewTrip, resolveCustomerChoices, type TripDraft } from '../../miniprogram/core/trips';
import { readAccount, readParties, readWorkspace, workspaceDraft, writeAccount } from '../account-workspace';
import { applyCatalogToDraft, loadCatalog } from '../catalog';
import { readSaveDraft } from '../draft-input';
import { HttpError } from '../http-error';
import { overlappingItems, readDirectory } from '../memory';
import type { ModelTrace } from '../text-model';
import { isPlaceholder, normalized, readImageOrder, readable, targetRows, TextOrders } from '../text-orders';
import { TripStore } from '../trips';
import { clipDecisions, type ControlDecision } from './decisions';
import { invalidTool, prepareEdits, PreviousQuestions } from './edit';
import { AgentMessage, AgentModel, AgentModelTrace, AgentReply, agentPrompt, agentPromptVersion, otherPrompt, summarizeToolCalls } from './model';
import { AgentStore, checkDraft, event, Input, saveChange, TurnKey } from './store';
import type { Intent, IntentModel } from './intent';
import { runDelivery } from './delivery';
import type { DeliveryModel } from './delivery-model';

type RecognizedImage = Awaited<ReturnType<TextOrders['recognizeImage']>>;
type Run = { key: TurnKey; input: Input; revision: number; signal: AbortSignal; previous?: PreviousQuestions;
  checkSession: () => Promise<unknown>; readRevision?: number; used: number; lines: string[]; questions: Question[];
  customerLinks: CustomerLink[] };

const emptyIntent: Intent = { draft: false, query: false, preview: false, answering: false };
const draftTools = ['edit_draft', 'ask_user'] as const;

function customerOption(number: number, name: string) {
  return `客户 ${number}（${name}）`;
}

function matchesConfirmation(question: Question, confirmation: NonNullable<PreviousQuestions['confirmation']>) {
  return question.options.length === 2 && question.options.includes(confirmation.accept) &&
    question.options.includes(confirmation.accept === '改' ? '不改' : '保留');
}

function plan(intent: Intent, imageCount: number, answering: boolean, received: string): PlanStep[] {
  const steps = [{ id: 'intent', text: received }];
  const add = (id: string, text: string) => { steps.push({ id, text }); };
  if (intent.draft && !answering) add('read', '读当前草稿');
  for (let i = 0; i < imageCount; i++) add(`image-${i}`, `识别第 ${i + 1} 张图`);
  if (imageCount) add('merge', '合并进草稿');
  if (intent.draft) add('edit', answering ? '按你的回答改草稿' : '整理进草稿');
  if (intent.draft || imageCount) add('check', answering ? '核对剩下的问题' : '核对缺项');
  if (intent.draft) add('summary', '汇报');
  if (intent.query) {
    add('query', '查取货清单');
    add('answer', '回答');
  }
  if (intent.preview) {
    add('verify', '核对必填项');
    add('preview', '算金额生成预览');
    add('confirm', '等你确认出单');
    add('issued', '出单完成');
  }
  if (steps.length === 1) add('other', '回答或请你说清楚');
  return steps;
}

function issueQuestions(issues: unknown[] = []): Question[] {
  return issues.flatMap(issue => typeof issue === 'string' ? [{ customer: '', text: issue, options: [] }]
    : isObject(issue) && typeof issue.message === 'string' ? [{ customer: '', text: issue.message, options: [] }] : []);
}

function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = () => reject(signal.reason);
    signal.addEventListener('abort', timeout, { once: true });
    if (signal.aborted) timeout();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', timeout));
  });
}

function readQuestions(args: Record<string, unknown>): Question[] {
  if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 64) invalidTool();
  return args.questions.map((value: unknown) => {
    if (!isObject(value) || !readable(value.customer, 200) || !readable(value.text, 300) || !value.text.trim()
        || !Array.isArray(value.options) || value.options.length > 12 ||
        value.options.some(option => !readable(option, 100) || !option.trim())) invalidTool();
    return { customer: value.customer.trim(), text: value.text.trim(), options: [...new Set<string>(value.options)] };
  });
}

function summarizeQuestions(questions: readonly Question[]) {
  return questions.map(({ customer, text, options }) => ({
    customer: customer.slice(0, 200), text: text.slice(0, 300),
    options: options.slice(0, 12).map(option => option.slice(0, 100)),
  }));
}

function summarizeOperations(value: unknown) {
  if (!Array.isArray(value)) return value;
  const text = JSON.stringify(value);
  return text.length <= 2_000 ? value : { truncated: true, count: value.length, json: text.slice(0, 2_000) };
}

function summarizeEditResult(result: Record<string, unknown>) {
  const decisions = Array.isArray(result.decisions) && result.decisions.length
    ? { decisions: result.decisions } : {};
  if ('confirmation' in result) {
    const confirmation = isObject(result.confirmation) ? result.confirmation : {};
    return { outcome: 'confirmation', accept: confirmation.accept,
      question: isObject(result.question) ? String(result.question.text ?? '') : '', ...decisions };
  }
  if (!('revision' in result) && Array.isArray(result.questions)) {
    return { outcome: 'questions', questions: summarizeQuestions(result.questions as Question[]), ...decisions };
  }
  if ('issues' in result) return { outcome: 'issues', issues: result.issues, ...decisions };
  return { outcome: 'applied', added: result.added, revision: result.revision, lines: result.lines,
    ...(Array.isArray(result.questions) ? { questions: summarizeQuestions(result.questions as Question[]), conflicts: result.conflicts } : {}),
    ...(result.catalog ? { catalog: result.catalog } : {}),
    ...decisions,
    customerLinks: Array.isArray(result.links) ? result.links.filter(isObject).map(link => ({
      spoken: link.spoken, canonicalName: link.canonicalName, matchedBy: link.matchedBy, merged: Boolean(link.merged),
    })) : [] };
}

export class AgentRuntime {
  readonly store: AgentStore;
  private readonly running = new Set<string>();

  constructor(private readonly pool: Pool, private readonly trips: TripStore, private readonly orders: TextOrders,
    private readonly model?: AgentModel, private readonly intentModel?: IntentModel, private readonly deliveryModel?: DeliveryModel) {
    this.store = new AgentStore(pool);
  }

  async submit(account: string, input: Input, checkSession: () => Promise<unknown>) {
    let reserved = false;
    try {
      const result = await this.store.start(account, input, () => {
        if (this.running.has(account) || this.running.size >= 4) {
          throw new HttpError(429, 'agent_busy', '助手正在处理订单，请稍后重试。');
        }
        this.running.add(account);
        reserved = true;
      });
      if (reserved) {
        const key = { id: result.turnId, account, draftId: input.draftId };
        setImmediate(() => {
          void this.run({ key, input, revision: input.revision, signal: AbortSignal.timeout(60_000),
            checkSession, used: 0, lines: [], questions: [], customerLinks: [] })
            .catch(() => console.error('录单助手无法写入回合状态'))
            .finally(() => this.running.delete(account));
        });
      }
      return result;
    } catch (error) {
      if (reserved) this.running.delete(account);
      throw error;
    }
  }

  private async run(run: Run) {
    const { key, input, signal } = run;
    const title = input.direct ? '已收到你的选择' : '看懂你的意思';
    let steps = [{ id: 'intent', text: title }];
    let planned = false;
    let active = 'intent';
    const terminal = new Set<string>();
    const step = async (id: string, state: StepState, result?: string) => {
      if (state === 'running') active = id;
      else {
        terminal.add(id);
        if (active === id) active = '';
      }
      await this.store.append(key, 'step', { id, state, result });
    };
    const begin = async (id: string) => {
      signal.throwIfAborted();
      await run.checkSession();
      await step(id, 'running');
    };
    const skipPreview = async (reason: string, afterVerify = false) => {
      for (const id of afterVerify ? ['preview', 'confirm', 'issued'] : ['verify', 'preview', 'confirm', 'issued']) {
        await step(id, 'skipped', id === 'preview' ? reason : undefined);
      }
    };
    try {
      await run.checkSession();
      if (input.voiceMeta && (input.voiceMeta.rawText !== input.text || input.voiceMeta.corrections.length)) {
        await this.store.append(key, 'voice_correction', { ...input.voiceMeta, text: input.text });
      }
      const context = await this.store.context(key, run.revision);
      if (context.delivery) {
        await runDelivery(this.store, this.trips, this.deliveryModel, key, input, context.previous, signal, run.checkSession);
        return;
      }
      const previous = context.previous;
      const directAnswer = input.direct?.intent === 'draft' ? input.direct.answer : undefined;
      const confirmation = previous?.confirmation;
      const selectedConfirmation = directAnswer && confirmation && previous.payload.questions.some(
        question => matchesConfirmation(question, confirmation) && question.options.includes(directAnswer));
      const intent = input.direct ? { ...emptyIntent, [input.direct.intent]: true }
        : !input.text ? emptyIntent : await this.identify(run, context);
      const answering = Boolean(directAnswer || (intent.answering && intent.draft && previous?.payload.questions.length));
      if (answering) run.previous = previous;
      steps = plan(intent, input.materialIds.length, answering, title);
      await this.store.append(key, 'plan', { steps });
      planned = true;
      await step('intent', 'running');

      await step('intent', 'done');
      let replyText = '';
      if (steps.some(item => item.id === 'other')) {
        await begin('other');
        const reply = await this.complete(run, otherPrompt, { text: input.text }, []);
        if (reply.tool_calls?.length) invalidTool();
        replyText = readable(reply.content, 400) && reply.content.trim() ? reply.content.trim() : '请说清楚这次要做什么。';
        const unclear = /^(?:请(?:你)?(?:说清楚|说具体|说明|补充)|(?:我)?没(?:听|看)懂|不太明白)/.test(replyText);
        if (unclear) await step('intent', 'needs_input', '需要你说清楚。');
        await step('other', unclear ? 'needs_input' : 'done');
      }

      if (steps.some(item => item.id === 'read')) {
        await begin('read');
        const draft = await this.readDraft(run);
        await step('read', 'done', `${draft.customers.reduce((sum, customer) => sum + customer.items.length, 0)} 行明细`);
      }

      const images: { id: string; recognized: RecognizedImage }[] = [];
      for (const [index, id] of input.materialIds.entries()) {
        const stepId = `image-${index}`;
        await begin(stepId);
        const image = readImageOrder({ draftId: key.draftId, revision: run.revision, materialId: id, requestId: randomUUID() });
        const traces: ModelTrace[] = [];
        try {
          const recognized = await withDeadline(this.orders.recognizeImage(key.account, image,
            { signal, trace: value => traces.push(value) }), signal);
          images.push({ id, recognized });
          await step(stepId, 'done');
        } catch (error) {
          if (!(error instanceof HttpError) || !['duplicate_order_image', 'unsupported_order_image'].includes(error.code)) throw error;
          run.questions.push({ customer: '', text: error.message, options: [] });
          await step(stepId, 'needs_input', error.message);
        } finally {
          for (const trace of traces) await this.store.append(key, 'model', trace);
        }
      }
      if (input.materialIds.length) {
        await begin('merge');
        for (const image of images) {
          const result = await this.tool(run, 'import_image', { materialId: image.id }, image.recognized);
          if ('added' in result && typeof result.added === 'number') run.lines.push(`图片新增 ${result.added} 行`);
          else if ('issues' in result) run.questions.push(...issueQuestions(result.issues));
        }
        await step('merge', run.questions.length ? 'needs_input' : 'done', run.lines.join('；') || '没有新增明细');
      }

      if (intent.draft) {
        await begin('edit');
        const beforeEdit = run.revision;
        if (selectedConfirmation && confirmation && previous) {
          if (directAnswer === confirmation.accept) {
            await this.applyEdit(run, confirmation.operations, previous.text, true);
          }
        } else {
          const draft = await this.readDraft(run);
          if (!directAnswer || !await this.selectCustomer(run, draft, directAnswer)) {
            await this.organize(run, draft);
          }
        }
        const needsInput = run.questions.length > 0 && beforeEdit === run.revision;
        await step('edit', needsInput ? 'needs_input' : 'done',
          needsInput ? `${run.questions.length} 处需要你确认` : run.lines.length ? run.lines.join('；') : '草稿没有变化');
      }

      let questionSource: string | undefined;
      if (intent.draft || input.materialIds.length) {
        await begin('check');
        if (run.customerLinks.length) {
          const recognized = new Set(run.customerLinks.flatMap(link => [link.spoken, link.canonicalName]));
          run.questions = run.questions.filter(question =>
            !(recognized.has(question.customer) && question.options.includes('新建客户')));
        }
        if (run.revision !== input.revision) run.questions.push(...await this.requiredQuestions(run));
        if (!answering && previous) {
          const carried = previous.payload.questions.filter(question => !confirmation || !matchesConfirmation(question, confirmation));
          if (carried.length) {
            const original = previous.payload.sourceText ?? previous.text;
            questionSource = run.questions.length && input.text ? `${original}\n${input.text}` : original;
            run.questions.push(...carried);
          }
        }
        run.questions = [...new Map(run.questions.map(question => [JSON.stringify(question), question])).values()];
        const draft = await this.readDraft(run);
        await step('check', run.questions.length ? 'needs_input' : 'done',
          [run.questions.length ? `${run.questions.length} 处待确认` : '', `${draft.pendingPrices} 处待补价`].filter(Boolean).join(' · '));
      }
      if (intent.draft) {
        await begin('summary');
        await step('summary', 'done', run.lines.length ? run.lines.join('；') : '草稿没有变化');
      }
      if (intent.query) {
        await begin('query');
        const trip = await this.trips.workspace(key.account);
        const picking = trip.draftConfirmed && trip.currentTrip?.id ?
          (await this.trips.trip(key.account, trip.currentTrip.id)).picking : [];
        await step('query', 'done', picking.length ? `找到 ${picking.length} 种货品` : '这趟还没出单');
        await begin('answer');
        replyText = picking.length ? picking.map(line => `${[line.brand, line.product, line.specification].filter(Boolean).join(' ')} · ${line.quantity} ${line.unit}`).join('\n')
          : '这趟还没出单，确认出单后会生成取货清单。';
        await step('answer', 'done');
      }
      if (intent.preview) {
        if (run.questions.length) await skipPreview('先确认上面的问题');
        else {
          await begin('verify');
          const draft = await this.readDraft(run);
          if (draft.confirmed) run.questions.push({ customer: '', text: '本趟已出单，请去取货或送货。', options: [] });
          else if (draft.questions.length) {
            run.questions.push(...await this.requiredQuestions(run));
            if (!run.questions.length) run.questions.push(...draft.questions.flatMap(q =>
              q.issues.map(text => ({ customer: q.name, text, options: [] }))));
          }
          await step('verify', run.questions.length ? 'needs_input' : 'done', run.questions.length ? '请先补齐必填项' : undefined);
          if (run.questions.length) await skipPreview('补齐后请重新生成预览', true);
          else {
            await begin('preview');
            const result = await this.tool(run, 'preview_trip', {});
            if ('issues' in result) run.questions.push(...issueQuestions(result.issues));
            await step('preview', run.questions.length ? 'needs_input' : 'done', 'pendingPrices' in result ?
              `${result.pendingPrices} 处待补价` : undefined);
            if (run.questions.length) {
              await step('confirm', 'skipped');
              await step('issued', 'skipped');
            } else {
              await step('confirm', 'needs_input', '请核对明细和金额。');
            }
          }
        }
      }
      if (run.questions.length) await this.store.append(key, 'questions', { questions: run.questions, sourceText: questionSource });
      const summary = run.lines.length ? '草稿已更新。' : '草稿没有变化。';
      await this.store.finish(key, 'completed', [replyText, summary].filter(Boolean).join('\n'));
    } catch (error) {
      const code = signal.aborted ? 'agent_timeout' : error instanceof HttpError ? error.code : 'agent_failed';
      const message = signal.aborted ? '这轮处理超时，可以重试。' :
        error instanceof HttpError ? error.message : '这一轮没有处理完，可以重试。';
      if (!planned) await this.store.append(key, 'plan', { steps });
      if (active) await step(active, 'failed', message);
      for (const item of steps) if (!terminal.has(item.id)) await step(item.id, 'skipped');
      await this.store.finish(key, 'failed', message, code);
    }
  }

  private async linkCustomers(client: PoolClient, account: string, draft: TripDraft, start: TripDraft,
    directory?: CustomerDirectory) {
    const before = new Map(start.customers.map(customer => [customer.id, customer]));
    const changed = draft.customers.filter(customer => {
      const original = before.get(customer.id);
      return customer.partyId === undefined && customer.customer.trim()
        && (original?.customer !== customer.customer || original.partyId !== undefined);
    });
    const lines: string[] = [];
    const links: CustomerLink[] = [];
    const decisions: ControlDecision[] = [];
    if (!changed.length) return { lines, links };
    const resolved = directory ?? await readDirectory(client, account);
    for (const customer of changed) {
      const spoken = customer.customer.trim();
      const mention = resolveCustomerMention(resolved, spoken);
      if (mention.status !== 'resolved') {
        lines.push(`${spoken}：待选店`);
        decisions.push({
          ruleId: 'customer.unresolved_mention',
          decision: 'confirm',
          layer: 'customer_link',
          reason: '未能唯一匹配到熟客档案，需人工选店或新建客户',
          target: spoken,
        });
        continue;
      }
      const sibling = draft.customers.find(entry => entry !== customer && entry.partyId === mention.customerId);
      if (sibling && overlappingItems(sibling, customer).length) {
        lines.push(`${spoken} → ${mention.canonicalName}：有相似明细，待核对合并`);
        decisions.push({
          ruleId: 'customer.merge_overlap_blocked',
          decision: 'confirm',
          layer: 'customer_link',
          reason: '命中同一熟客但存在同款或相似明细，暂不静默合并',
          target: `${spoken} → ${mention.canonicalName}`,
        });
        continue;
      }
      if (sibling) {
        sibling.items.push(...customer.items);
        draft.customers = draft.customers.filter(entry => entry !== customer);
        lines.push(`${spoken} → ${mention.canonicalName}（并入同一家）`);
      } else {
        customer.customer = mention.canonicalName;
        customer.partyId = mention.customerId;
        lines.push(mention.matchedBy === 'alias'
          ? `${spoken} → ${mention.canonicalName}（记住的叫法）`
          : `${mention.canonicalName}：认出熟客`);
      }
      links.push({ draftCustomerId: sibling?.id ?? customer.id, spoken, customerId: mention.customerId,
        canonicalName: mention.canonicalName, matchedBy: mention.matchedBy, merged: Boolean(sibling) });
    }
    return { lines, links, ...(decisions.length ? { decisions: clipDecisions(decisions) } : {}) };
  }

  private async saveDraftChange(client: PoolClient, run: Run, revision: number, lines: string[], links: CustomerLink[], digest?: string) {
    await saveChange(client, run.key, revision, lines, run.signal, digest);
    if (links.length) await event(client, run.key, 'customer_links', { links });
    run.signal.throwIfAborted();
  }

  private async selectCustomer(run: Run, draft: Awaited<ReturnType<AgentRuntime['readDraft']>>, answer: string) {
    const matches = draft.customers.filter(customer => customer.customerChoice === 'unresolved' &&
      run.previous?.payload.questions.some(question => question.customer === customer.customer && question.options.includes(answer)) &&
      (answer === '新建客户' || customer.customerOptions.some(option => answer === customerOption(option.partyNumber, option.name))));
    if (matches.length !== 1) return false;
    await this.applyEdit(run, [{ action: 'set_customer', customerNumber: matches[0].customerNumber }], answer);
    return true;
  }

  private async organize(run: Run, draft: Awaited<ReturnType<AgentRuntime['readDraft']>>) {
    const { key, input } = run;
    const customers = draft.customers.filter(customer => customer.customer || customer.items.length);
    const text = input.text.normalize('NFKC');
    const numbers = spokenNumbers(text).map(({ start, end, value }) => ({ original: text.slice(start, end), value, after: text.slice(end, end + 4) }));
    const reply = await this.complete(run, agentPrompt, { text: input.text, numbers, customers, pendingPrices: draft.pendingPrices,
      previous: run.previous ? { text: run.previous.payload.sourceText ?? run.previous.text, questions: run.previous.payload.questions } : null }, draftTools);
    for (const call of reply.tool_calls ?? []) {
      const name = call?.function?.name;
      if (!draftTools.some(tool => tool === name) || typeof call.id !== 'string') invalidTool();
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); } catch { invalidTool(); }
      if (!isObject(args)) invalidTool();
      if (name === 'edit_draft') {
        await this.applyEdit(run, args.operations);
        if (Array.isArray(args.questions) && args.questions.length) run.questions.push(...readQuestions(args));
      } else {
        this.reserveTool(run);
        const questions = readQuestions(args);
        run.questions.push(...questions);
        await this.store.append(key, 'tool', { name: 'ask_user', promptVersion: agentPromptVersion,
          arguments: { questions: summarizeQuestions(questions) },
          result: { outcome: 'questions', questionCount: questions.length } });
      }
    }
    if (!reply.tool_calls?.length) {
      run.questions.push({ customer: '', text: '请说清楚客户、货品和要录入或修改的内容。', options: [] });
    }
  }

  private async identify(run: Run, context: Awaited<ReturnType<AgentStore['context']>>) {
    const started = Date.now();
    const traces: AgentModelTrace[] = [];
    let intents: Intent | undefined;
    const customers = context.draft.customers.flatMap(customer => {
      const items = customer.items.filter(item => !isPlaceholder(item));
      return customer.customer || items.length ? [{ customer: customer.customer, items }] : [];
    });
    const inputSummary = {
      customerCount: customers.length,
      itemCount: customers.reduce((sum, customer) => sum + customer.items.length, 0),
      questionCount: context.previous?.payload.questions.length ?? 0,
      hasLastSummary: Boolean(context.lastSummary),
    };
    try {
      if (!this.intentModel) throw new HttpError(503, 'agent_model_unavailable', '助手暂未开启，可以手动填写。');
      intents = await withDeadline(this.intentModel(run.input.text, {
        customers, questions: context.previous?.payload.questions ?? [], lastSummary: context.lastSummary,
      }, run.signal, value => { traces.push(value); }), run.signal);
      intents = { ...intents, answering: Boolean(intents.draft && intents.answering && context.previous?.payload.questions.length) };
      return intents;
    } finally {
      if (!traces.length) {
        await this.recordModel(run, started, undefined, { phase: 'intent', intents, inputSummary });
      } else {
        for (const [index, trace] of traces.entries()) {
          const last = index === traces.length - 1;
          await this.recordModel(run, started, trace, { phase: 'intent', ...(last ? { intents } : {}), inputSummary });
        }
      }
    }
  }

  private async complete(run: Run, prompt: string, input: object, allowed: readonly string[]) {
    const started = Date.now();
    const traces: AgentModelTrace[] = [];
    let reply: AgentReply | undefined;
    const fields = input as Record<string, unknown>;
    const summaryCustomers = Array.isArray(fields.customers) ? fields.customers : undefined;
    const inputSummary = summaryCustomers ? {
      customerCount: summaryCustomers.length,
      itemCount: summaryCustomers.reduce((sum: number, customer) => sum + (isObject(customer) && Array.isArray(customer.items) ? customer.items.length : 0), 0),
      pendingPrices: typeof fields.pendingPrices === 'number' ? fields.pendingPrices : 0,
      spokenNumbers: Array.isArray(fields.numbers) ? fields.numbers : [],
      hasPreviousQuestions: isObject(fields.previous) && Array.isArray(fields.previous.questions) && fields.previous.questions.length > 0,
    } : undefined;
    try {
      if (!this.model) throw new HttpError(503, 'agent_model_unavailable', '助手暂未开启，可以手动填写。');
      const messages: AgentMessage[] = [{ role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify(input) }];
      reply = await withDeadline(this.model(messages, run.signal, value => { traces.push(value); }, allowed), run.signal);
      return reply;
    } finally {
      // 测试桩和部分模型实现不会回填 trace，这里用回复里的原始工具调用补齐内部记录。
      const phase = allowed.length ? 'edit' : 'other';
      if (!traces.length) {
        const toolCalls = reply?.tool_calls?.length ? summarizeToolCalls(reply.tool_calls) : undefined;
        await this.recordModel(run, started, undefined, { phase,
          ...(inputSummary ? { inputSummary } : {}), ...(toolCalls ? { toolCalls } : {}) });
      } else {
        for (const [index, trace] of traces.entries()) {
          const last = index === traces.length - 1;
          const toolCalls = trace.toolCalls?.length ? trace.toolCalls
            : last && reply?.tool_calls?.length ? summarizeToolCalls(reply.tool_calls) : undefined;
          await this.recordModel(run, started, trace, { phase,
            ...(inputSummary ? { inputSummary } : {}), ...(toolCalls ? { toolCalls } : {}) });
        }
      }
    }
  }

  private recordModel(run: Run, started: number, trace: AgentModelTrace | undefined, fields: object) {
    return this.store.append(run.key, 'model', { ...(trace ?? {
      model: 'fixture', promptVersion: agentPromptVersion, elapsedMs: Date.now() - started,
      outcome: run.signal.aborted ? 'timeout' : 'no_provider_trace',
    }), ...fields });
  }

  private reserveTool(run: Run) {
    run.signal.throwIfAborted();
    if (++run.used > 8) throw new HttpError(409, 'agent_tool_limit', '这一轮要处理的内容较多，可以分开再发。');
  }

  private async applyEdit(run: Run, operations: unknown, source = run.input.text, confirmed = false) {
    const result = await this.tool(run, 'edit_draft', { operations, source, confirmed });
    if ('confirmation' in result && result.confirmation && result.question) {
      await this.store.append(run.key, 'edit_confirmation', result.confirmation);
      run.questions.push(result.question);
    } else if ('issues' in result) run.questions.push(...issueQuestions(result.issues));
    else {
      if ('questions' in result && result.questions) run.questions.push(...result.questions);
      if ('lines' in result && result.lines) run.lines.push(...result.lines);
    }
  }

  private requiredQuestions(run: Run): Promise<Question[]> {
    const { account, draftId } = run.key;
    return readAccount(this.pool, account, async client => {
      const workspace = await readWorkspace(client, account);
      checkDraft(workspace, draftId, run.revision);
      const draft = workspaceDraft(workspace);
      return textOrderQuestions(draft).map(({ id, name, issues }) => {
        const customer = draft.customers.find(entry => entry.id === id);
        const choosing = Boolean(customer?.customer.trim() && customer.partyId === undefined);
        const text = issues.map(issue => choosing && issue === '请选择已有客户或明确新建'
          ? '是哪家熟客？请在下方选店，或新建客户。' : issue).join('；');
        return { customer: name, text, options: [] };
      });
    });
  }

  private readDraft(run: Run) {
    const { account, draftId } = run.key;
    return readAccount(this.pool, account, async client => {
      const current = await readWorkspace(client, account);
      if (current.id !== draftId || current.revision !== run.revision) checkDraft(current, draftId, run.revision);
      const parties = await readParties(client, account);
      const draft = workspaceDraft(current);
      run.readRevision = draft.revision;
      const numbered = new Map(targetRows(draft).map(({ item }, index) => [item.id, index + 1]));
      const questions = textOrderQuestions(draft);
      if (!questions.length) {
        try { previewTrip(draft, true); resolveCustomerChoices(draft, parties); }
        catch (error) { questions.push({ id: '', name: '', issues: [(error as Error).message] }); }
      }
      return { revision: draft.revision, confirmed: current.currentTripId === draftId, questions,
        pendingPrices: targetRows(draft).filter(({ item }) => !isPlaceholder(item) && !nullablePrice(item.price)).length,
        customers: draft.customers.map((customer, index) => ({
          customerNumber: index + 1, customer: customer.customer,
          customerChoice: !customer.customer.trim() ? 'blank' : customer.partyId === null ? 'new'
            : customer.partyId === undefined ? 'unresolved' : 'linked',
          customerOptions: customer.partyId === undefined
            ? parties.flatMap((party, i) => normalized(party.name) === normalized(customer.customer)
              ? [{ partyNumber: i + 1, name: party.name }] : [])
            : [],
          items: customer.items.filter(item => !isPlaceholder(item))
            .map(({ id, ...fields }) => ({ ...fields, target: numbered.get(id) })),
        })) };
    });
  }

  private traceTool(run: Run, name: 'preview_trip' | 'edit_draft' | 'import_image',
    args: Record<string, unknown>, result: Record<string, unknown>) {
    return this.store.append(run.key, 'tool', {
      name, promptVersion: agentPromptVersion,
      arguments: name === 'preview_trip' ? { draftId: run.key.draftId, revision: run.revision }
        : name === 'edit_draft' ? { confirmed: Boolean(args.confirmed), operations: summarizeOperations(args.operations) }
        : { materialId: args.materialId },
      result,
    });
  }

  private async tool(run: Run, name: 'preview_trip' | 'edit_draft' | 'import_image',
    args: Record<string, unknown>, recognized?: RecognizedImage) {
    const { key, input, signal } = run;
    const { account, draftId } = key;
    this.reserveTool(run);
    await run.checkSession();
    try {
      if (name === 'preview_trip') {
        if (run.readRevision !== run.revision) {
          const result = { issues: ['请先读取当前修订的草稿并核对必填项。'] };
          await this.traceTool(run, name, args, { outcome: 'issues', issues: result.issues });
          return result;
        }
        const requestId = randomUUID();
        try {
          const preview = await this.trips.preview(account, { draftId, revision: run.revision, requestId }, signal);
          await this.store.append(key, 'preview', { preview });
          const pendingPrices = preview.customers.flatMap(customer => customer.items).filter(item => item.price === null).length;
          const result = { ready: true, pendingPrices };
          await this.traceTool(run, name, args, {
            outcome: 'preview', previewId: preview.previewId, totalCents: preview.totalCents, pendingPrices,
          });
          return result;
        } catch (error) {
          if (error instanceof HttpError && error.code === 'invalid_draft') {
            const result = { issues: [error.message] };
            await this.traceTool(run, name, args, { outcome: 'issues', issues: result.issues });
            return result;
          }
          throw error;
        }
      }
      if (name === 'edit_draft') {
        if (typeof args.source !== 'string' || !args.source) invalidTool();
        const requestId = randomUUID();
        const result = await writeAccount(this.pool, account, requestId,
          { action: 'agent-edit', turnId: key.id, revision: run.revision }, async (client, workspace) => {
            signal.throwIfAborted();
            checkDraft(workspace, draftId, run.revision, true);
            const before = workspaceDraft(workspace);
            const directory = await readDirectory(client, account);
            const catalog = await loadCatalog(client, account);
            const prepared = prepareEdits(before, args, [...directory.customers], String(args.source), run.previous,
              args.confirmed === true, directory, Boolean(catalog.length));
            if (!('draft' in prepared) || !prepared.draft) return prepared;
            const linked = await this.linkCustomers(client, account, prepared.draft, before, directory);
            const priced = await applyCatalogToDraft(client, account, prepared.draft, before, catalog, String(args.source));
            const decisions = clipDecisions([
              ...(prepared.decisions ?? []),
              ...(linked.decisions ?? []),
              ...(priced.decisions ?? []),
            ]);
            if (JSON.stringify(prepared.draft.customers) === JSON.stringify(before.customers)) {
              return { issues: [{ code: 'edit_needs_review', message: '没有可写入的新内容，请核对货品或明确单价。' }],
                ...(decisions.length ? { decisions } : {}) };
            }
            const { draft } = readSaveDraft(draftId, { ...prepared.draft, revision: run.revision, requestId });
            const revision = run.revision + 1;
            const lines = [...prepared.lines!, ...linked.lines, ...priced.lines];
            await client.query('UPDATE dispatch.workspaces SET draft_revision = $2, draft_customers = $3 WHERE account_id = $1',
              [account, revision, JSON.stringify(draft.customers)]);
            await this.saveDraftChange(client, run, revision, lines, linked.links);
            return { added: prepared.added, lines, revision, links: linked.links,
              ...(prepared.questions?.length ? { questions: prepared.questions, conflicts: prepared.conflicts } : {}),
              ...(priced.changes.length ? { catalog: priced.changes } : {}),
              ...(decisions.length ? { decisions } : {}) };
          });
        if ('revision' in result && result.revision !== undefined) run.revision = result.revision;
        if ('links' in result && result.links) run.customerLinks.push(...result.links);
        await this.traceTool(run, name, args, summarizeEditResult(result as Record<string, unknown>));
        return result;
      }
      const materialId = args.materialId;
      if (typeof materialId !== 'string' || !input.materialIds.includes(materialId)) invalidTool();
      const before = await readAccount(this.pool, account, async client => workspaceDraft(await readWorkspace(client, account)));
      const lineCount = (draft: typeof before) => targetRows(draft).filter(({ item }) => !isPlaceholder(item)).length;
      try {
        const image = readImageOrder({ draftId, revision: run.revision, materialId, requestId: randomUUID() });
        let linked: Awaited<ReturnType<AgentRuntime['linkCustomers']>> = { lines: [], links: [] };
        let priced: Awaited<ReturnType<typeof applyCatalogToDraft>> | undefined;
        const result = await withDeadline(this.orders.importImage(account, image, run.checkSession, {
          signal, trace: () => {}, recognized,
          prepare: async (client, draft, previous) => {
            linked = await this.linkCustomers(client, account, draft, previous);
            priced = await applyCatalogToDraft(client, account, draft, previous);
            return draft;
          },
          saved: (client, draft, digest) => this.saveDraftChange(client, run, draft.revision,
            [`图片新增 ${lineCount(draft) - lineCount(before)} 行`, ...linked.lines, ...(priced?.lines ?? [])], linked.links, digest),
        }), signal);
        const decisions = clipDecisions([...(linked.decisions ?? []), ...(priced?.decisions ?? [])]);
        if ('issues' in result) {
          await this.traceTool(run, name, args, { outcome: 'issues', issues: result.issues,
            ...(decisions.length ? { decisions } : {}) });
          return result;
        }
        run.revision = result.draft.revision;
        run.customerLinks.push(...linked.links);
        const added = lineCount(result.draft) - lineCount(before);
        await this.traceTool(run, name, args, { outcome: 'applied', added, revision: run.revision,
          ...(priced?.changes.length ? { catalog: priced.changes } : {}),
          ...(decisions.length ? { decisions } : {}) });
        return { added };
      } catch (error) {
        if (error instanceof HttpError && ['duplicate_order_image', 'unsupported_order_image'].includes(error.code)) {
            const result = { issues: [{ code: error.code, message: error.message }] };
            await this.traceTool(run, name, args, { outcome: 'issues', issues: result.issues });
            return result;
        }
        throw error;
      }
    } catch (error) {
      try {
        await this.traceTool(run, name, args, {
          outcome: 'error', errorCode: error instanceof HttpError ? error.code : 'tool_failed',
        });
      } catch {
        // 诊断记录失败不能覆盖真正的业务异常。
      }
      throw error;
    }
  }
}
