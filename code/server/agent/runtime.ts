import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PlanStep, Question, StepState } from '../../miniprogram/core/agent';
import { isObject, nullablePrice } from '../../miniprogram/core/orders';
import { spokenNumbers } from '../../miniprogram/core/spoken-numbers';
import { textOrderQuestions } from '../../miniprogram/core/text-order';
import { previewTrip, resolveCustomerChoices } from '../../miniprogram/core/trips';
import { readAccount, readParties, readWorkspace, workspaceDraft, writeAccount } from '../account-workspace';
import { readSaveDraft } from '../draft-input';
import { HttpError } from '../http-error';
import type { ModelTrace } from '../text-model';
import { isPlaceholder, normalized, readImageOrder, readable, targetRows, TextOrders } from '../text-orders';
import { TripStore } from '../trips';
import { invalidTool, prepareEdits, PreviousQuestions } from './edit';
import { AgentMessage, AgentModel, AgentModelTrace, agentPrompt, agentPromptVersion, otherPrompt } from './model';
import { AgentStore, checkDraft, Input, saveChange, TurnKey } from './store';
import type { Intent, IntentModel } from './intent';

type RecognizedImage = Awaited<ReturnType<TextOrders['recognizeImage']>>;
type Run = { key: TurnKey; input: Input; revision: number; signal: AbortSignal; previous?: PreviousQuestions;
  checkSession: () => Promise<unknown>; readRevision?: number; used: number; lines: string[]; questions: Question[] };

const emptyIntent: Intent = { draft: false, query: false, preview: false };
const draftTools = ['edit_draft', 'ask_user'] as const;
const previewClause = /^(?:然后|接着|接下来|之后|再|顺便|并)?\s*(?:帮我|给我)?\s*(?:预览|(?:出|开|打|生成|打印|看)(?:一下|一?[张份个])?(?:这趟|本趟|本次)?(?:配送|送货)?(?:单子?|预览))$/;

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

export class AgentRuntime {
  readonly store: AgentStore;
  private readonly running = new Set<string>();

  constructor(private readonly pool: Pool, private readonly trips: TripStore, private readonly orders: TextOrders,
    private readonly model?: AgentModel, private readonly intentModel?: IntentModel) {
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
            checkSession, used: 0, lines: [], questions: [] })
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
      const context = await this.store.context(key, run.revision);
      run.previous = context.previous;
      const selected = input.direct?.intent === 'draft' ? input.direct.answer : input.text;
      const confirmation = run.previous?.confirmation;
      const selectedConfirmation = confirmation && run.previous?.payload.questions.some(q => q.options.includes(selected));
      const intent = input.direct ? { ...emptyIntent, [input.direct.intent]: true }
        : !input.text ? emptyIntent : await this.identify(run, context);
      steps = plan(intent, input.materialIds.length, Boolean(run.previous), title);
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
        if (selectedConfirmation && confirmation) {
          if (selected === confirmation.accept) {
            await this.applyEdit(run, confirmation.operations, run.previous!.text, true);
          }
        } else {
          const draft = await this.readDraft(run);
          const derived = this.deriveEdit(run, draft, intent);
          if (derived && derived.questions) run.questions.push(...derived.questions);
          else if (derived) await this.applyEdit(run, [derived]);
          else await this.organize(run, draft);

        }
        const needsInput = run.questions.length > 0 && beforeEdit === run.revision;
        await step('edit', needsInput ? 'needs_input' : 'done',
          needsInput ? `${run.questions.length} 处需要你确认` : run.lines.length ? run.lines.join('；') : '草稿没有变化');
      }

      if (intent.draft || input.materialIds.length) {
        await begin('check');
        if (!run.questions.length && run.revision !== input.revision) run.questions.push(...await this.requiredQuestions(run));
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
      if (run.questions.length) await this.store.append(key, 'questions', { questions: run.questions });
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

  private deriveEdit(run: Run, draft: Awaited<ReturnType<AgentRuntime['readDraft']>>, intent: Intent) {
    const text = normalized(run.input.text);
    const rows = draft.customers.flatMap(customer => customer.items.map(item => ({ customer: customer.customer, ...item })));
    const quantityChange = (source: string, canPreview: boolean) => {
      const [clause, ...tail] = source.split(/[，,。；;]+/).map(part => part.trim()).filter(Boolean);
      const match = clause?.match(/^(.*?)(再要|再来|再加|加上|追加|加|这次|这趟|本趟|本次|要)\s*(.+)$/);
      if (!match || tail.some(part => !canPreview || !previewClause.test(part))) return;
      const [, prefix, verb, suffix] = match;
      const [amount] = spokenNumbers(suffix);
      if (!amount || amount.start !== 0 || !amount.value || !Number.isInteger(amount.value)) return;
      const unit = suffix.slice(amount.end).trim().replace(/(?:了)?[哈啊呀呢哦]?$/, '');
      const matches = rows.filter(row => unit === row.unit && (prefix === row.customer || prefix === row.product ||
        prefix === row.customer + row.product || prefix === row.customer + '的' + row.product || prefix === row.product + row.customer));
      if (matches.length !== 1) return;
      return { row: matches[0], amount: amount.value, ambiguous: verb === '再要' || verb === '再来', increment: /加/.test(verb) };
    };
    if (run.previous) {
      const [question] = run.previous.payload.questions;
      const party = text.match(/^(?:选择已有)?客户\s*(\d+)(?:[（(].*[）)])?$/)?.[1];
      const matching = draft.customers.filter(customer => customer.customerChoice === 'unresolved' &&
        customer.customer === question?.customer && (party === undefined ||
          customer.customerOptions.some(option => option.partyNumber === Number(party))));
      if (matching.length === 1 && (party || text === '新建客户')) {
        return { action: 'set_customer', customerNumber: matching[0].customerNumber, partyId: party ? undefined : null };
      }
      const prior = quantityChange(normalized(run.previous.text), false);
      const option = question?.options.find(answer => normalized(answer) === text ||
        (text === '追加' && answer.startsWith('追加')) || (text === '改成' && answer.startsWith('改成')));
      if (prior?.ambiguous && option) {
        const quantity = (option.startsWith('追加') ? Number(prior.row.quantity) : 0) + prior.amount;
        return { action: 'update', target: prior.row.target, quantity: String(quantity) };
      }
      return;
    }
    const quantity = quantityChange(text, intent.preview);
    if (quantity?.ambiguous) {
      const { row, amount } = quantity;
      return { questions: [{ customer: row.customer, text: `${row.product} 是改成 ${amount} ${row.unit}，还是再加 ${amount} ${row.unit}？`,
        options: [`改成 ${amount} ${row.unit}`, `追加 ${amount} ${row.unit}`] }] };
    }
    if (quantity) return { action: 'update', target: quantity.row.target,
      quantity: String((quantity.increment ? Number(quantity.row.quantity) : 0) + quantity.amount) };
    const amounts = spokenNumbers(text);
    const missing = rows.filter(item => !item.price);
    if (amounts.length === 1 && amounts[0].start === 0 && amounts[0].end === text.length &&
        amounts[0].value !== null && amounts[0].value > 0 && missing.length === 1) {
      return { action: 'fill', target: missing[0].target, price: String(amounts[0].value) };
    }
  }

  private async organize(run: Run, draft: Awaited<ReturnType<AgentRuntime['readDraft']>>) {
    const { key, input } = run;
    const customers = draft.customers.filter(customer => customer.customer || customer.items.length);
    const text = input.text.normalize('NFKC');
    const numbers = spokenNumbers(text).map(({ start, end, value }) => ({ original: text.slice(start, end), value, after: text.slice(end, end + 4) }));
    const reply = await this.complete(run, agentPrompt, { text: input.text, numbers, customers,
      previous: run.previous ? { text: run.previous.text, questions: run.previous.payload.questions } : null }, draftTools);
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
        run.questions.push(...readQuestions(args));
        await this.store.append(key, 'tool', { name });
      }
    }
    if (!reply.tool_calls?.length) {
      run.questions.push({ customer: '', text: '请说清楚客户、货品和要录入或修改的内容。', options: [] });
    }
  }

  private async identify(run: Run, context: Awaited<ReturnType<AgentStore['context']>>) {
    const started = Date.now();
    let trace: AgentModelTrace | undefined;
    let intents: Intent | undefined;
    try {
      if (!this.intentModel) throw new HttpError(503, 'agent_model_unavailable', '助手暂未开启，可以手动填写。');
      const customers = context.draft.customers.flatMap(customer => {
        const items = customer.items.filter(item => !isPlaceholder(item));
        return customer.customer || items.length ? [{ customer: customer.customer, items }] : [];
      });
      intents = await withDeadline(this.intentModel(run.input.text, {
        customers, questions: context.previous?.payload.questions ?? [], lastSummary: context.lastSummary,
      }, run.signal, value => { trace = value; }), run.signal);
      return intents;
    } finally {
      await this.recordModel(run, started, trace, { phase: 'intent', intents });
    }
  }

  private async complete(run: Run, prompt: string, input: object, allowed: readonly string[]) {
    const started = Date.now();
    let trace: AgentModelTrace | undefined;
    try {
      if (!this.model) throw new HttpError(503, 'agent_model_unavailable', '助手暂未开启，可以手动填写。');
      const messages: AgentMessage[] = [{ role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify(input) }];
      return await withDeadline(this.model(messages, run.signal, value => { trace = value; }, allowed), run.signal);
    } finally {
      await this.recordModel(run, started, trace, { phase: allowed.length ? 'edit' : 'other' });
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
    else if ('lines' in result && result.lines) run.lines.push(...result.lines);
  }

  private requiredQuestions(run: Run): Promise<Question[]> {
    const { account, draftId } = run.key;
    return readAccount(this.pool, account, async client => {
      const workspace = await readWorkspace(client, account);
      checkDraft(workspace, draftId, run.revision);
      const draft = workspaceDraft(workspace);
      const parties = await readParties(client, account);
      return textOrderQuestions(draft).map(({ id, name, issues }) => {
        const customer = draft.customers.find(entry => entry.id === id);
        const options = customer?.customer.trim() && customer.partyId === undefined
          ? [...parties.flatMap((party, i) => normalized(party.name) === normalized(name) ? [`客户 ${i + 1}（${party.name}）`] : []), '新建客户']
          : [];
        return { customer: name, text: issues.join('；'), options };
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

  private async tool(run: Run, name: 'preview_trip' | 'edit_draft' | 'import_image',
    args: Record<string, unknown>, recognized?: RecognizedImage) {
    const { key, input, signal } = run;
    const { account, draftId } = key;
    this.reserveTool(run);
    await this.store.append(key, 'tool', { name, promptVersion: agentPromptVersion });
    await run.checkSession();
    if (name === 'preview_trip') {
      if (run.readRevision !== run.revision) return { issues: ['请先读取当前修订的草稿并核对必填项。'] };
      const requestId = randomUUID();
      try {
        const preview = await this.trips.preview(account, { draftId, revision: run.revision, requestId }, signal);
        await this.store.append(key, 'preview', { preview });
        return { ready: true, pendingPrices: preview.customers.flatMap(customer => customer.items).filter(item => item.price === null).length };
      } catch (error) {
        if (error instanceof HttpError && error.code === 'invalid_draft') return { issues: [error.message] };
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
          const parties = await readParties(client, account);
          const prepared = prepareEdits(workspaceDraft(workspace), args, parties, String(args.source), run.previous, args.confirmed === true);
          if (!('draft' in prepared) || !prepared.draft) return prepared;
          const { draft } = readSaveDraft(draftId, { ...prepared.draft, revision: run.revision, requestId });
          const revision = run.revision + 1;
          await client.query('UPDATE dispatch.workspaces SET draft_revision = $2, draft_customers = $3 WHERE account_id = $1',
            [account, revision, JSON.stringify(draft.customers)]);
          await saveChange(client, key, revision, prepared.lines!, signal);
          return { added: prepared.added, lines: prepared.lines, revision };
        });
      if ('revision' in result && result.revision !== undefined) run.revision = result.revision;
      return result;
    }
    const materialId = args.materialId;
    if (typeof materialId !== 'string' || !input.materialIds.includes(materialId)) invalidTool();
    const before = await readAccount(this.pool, account, async client => workspaceDraft(await readWorkspace(client, account)));
    const lineCount = (draft: typeof before) => targetRows(draft).filter(({ item }) => !isPlaceholder(item)).length;
    try {
      const image = readImageOrder({ draftId, revision: run.revision, materialId, requestId: randomUUID() });
      const result = await withDeadline(this.orders.importImage(account, image, run.checkSession, {
        signal, trace: () => {}, recognized,
        saved: (client, draft, digest) => saveChange(client, key, draft.revision,
          [`图片新增 ${lineCount(draft) - lineCount(before)} 行`], signal, digest),
      }), signal);
      if ('issues' in result) return result;
      run.revision = result.draft.revision;
      return { added: lineCount(result.draft) - lineCount(before) };
    } catch (error) {
      if (error instanceof HttpError && ['duplicate_order_image', 'unsupported_order_image'].includes(error.code)) {
          return { issues: [{ code: error.code, message: error.message }] };
      }
      throw error;
    }
  }
}
