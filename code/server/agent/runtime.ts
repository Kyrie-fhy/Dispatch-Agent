import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Question } from '../../miniprogram/core/agent';
import { isObject, nullablePrice } from '../../miniprogram/core/orders';
import { textOrderQuestions } from '../../miniprogram/core/text-order';
import { latest, previewTrip, resolveCustomerChoices } from '../../miniprogram/core/trips';
import { readAccount, readParties, readWorkspace, workspaceDraft, writeAccount } from '../account-workspace';
import { readSaveDraft } from '../draft-input';
import { HttpError } from '../http-error';
import type { ModelTrace } from '../text-model';
import { isPlaceholder, normalized, readImageOrder, readable, targetRows, TextOrders } from '../text-orders';
import { TripStore } from '../trips';
import { invalidTool, prepareEdits, PreviousQuestions } from './edit';
import { AgentMessage, AgentModel, AgentModelTrace, agentPrompt, agentPromptVersion, agentTools } from './model';
import { AgentStore, checkDraft, Input, saveChange, TurnKey } from './store';

type Run = { key: TurnKey; input: Input; revision: number; signal: AbortSignal; previous?: PreviousQuestions;
  checkSession: () => Promise<unknown>; images: Set<string>; shownPreview: boolean; readRevision?: number; };
const steps: Record<string, string> = {
  read_draft: '核对这趟草稿', list_customers: '查找已有客户', read_current_trip: '查看取货清单',
  edit_draft: '整理订单草稿', import_image: '识别订单图片', ask_user: '整理要确认的问题', preview_trip: '生成送货单预览',
};
const toolNames = new Set(agentTools.map(tool => tool.function.name));

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
    private readonly model?: AgentModel) {
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
            checkSession, images: new Set(), shownPreview: false })
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
    try {
      if (!this.model) throw new HttpError(503, 'agent_model_unavailable', '助手暂未开启，可以手动填写。');
      const commandLike = /(?:忽略|无视|覆盖|绕过|忘记).{0,30}(?:规则|指令|提示|限制|权限)|(?:系统提示|system prompt|confirm_trip|\/v1\/trips\/confirm)/i;
      if (commandLike.test(input.text)) {
        throw new HttpError(400, 'unsupported_agent_message', '这段内容无法用于录单，请只发客户、货品或录单要求。');
      }
      const context = await this.store.context(key);
      run.previous = context.previous;
      const messages: AgentMessage[] = [
        { role: 'system', content: agentPrompt },
        ...context.messages,
        { role: 'user', content: JSON.stringify({ text: input.text, materialIds: input.materialIds }) },
      ];
      let stepsUsed = 0;
      while (true) {
        signal.throwIfAborted();
        await run.checkSession();
        const reply = await this.complete(run, messages);
        if (!reply.tool_calls?.length) {
          if (input.materialIds.some(id => !run.images.has(id))) {
            throw new HttpError(502, 'images_not_imported', '还有图片没处理完，请重试。');
          }
          if (!run.shownPreview && run.revision !== input.revision) {
            const questions = await this.requiredQuestions(run);
            if (questions.length) {
              await this.ask(run.key, questions);
              return;
            }
          }
          const message = run.shownPreview ? '预览已生成，核对后点确认出单。' :
            readable(reply.content, 1000) && (reply.content ?? '').trim() ? (reply.content ?? '').trim() : '这条消息已处理。';
          await this.store.finish(key, 'completed', message);
          return;
        }
        messages.push(reply);
        for (const call of reply.tool_calls) {
          if (++stepsUsed > 8) throw new HttpError(409, 'agent_tool_limit', '这一轮要处理的内容较多，可以分开再发。');
          const result = await this.execute(run, call, stepsUsed);
          if (result === null) return;
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
    } catch (error) {
      const code = signal.aborted ? 'agent_timeout' : error instanceof HttpError ? error.code : 'agent_failed';
      const message = signal.aborted ? '这轮处理超时，可以重试。' :
        error instanceof HttpError ? error.message : '这一轮没有处理完，可以重试。';
      await this.store.finish(key, 'failed', message, code);
    }
  }

  private async complete(run: Run, messages: AgentMessage[]) {
    const trace: { value?: AgentModelTrace } = {};
    const started = Date.now();
    try {
      return await withDeadline(this.model!(messages, run.signal, value => { trace.value = value; }), run.signal);
    } finally {
      await this.store.append(run.key, 'model', trace.value ?? {
        model: 'fixture', promptVersion: agentPromptVersion, elapsedMs: Date.now() - started,
        outcome: run.signal.aborted ? 'timeout' : 'no_provider_trace',
      });
    }
  }

  private async execute(run: Run, call: NonNullable<Awaited<ReturnType<AgentModel>>['tool_calls']>[number], step: number) {
    const name = call?.function?.name;
    if (typeof name !== 'string' || !toolNames.has(name) || typeof call.id !== 'string') {
      await this.store.append(run.key, 'tool', { name: 'unknown', errorCode: 'tool_not_allowed', promptVersion: agentPromptVersion });
      invalidTool();
    }
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); } catch { invalidTool(); }
    if (!isObject(args)) invalidTool();
    const { key, signal, input } = run;
    const text = name === 'import_image' ? `识别第 ${input.materialIds.indexOf(String(args.materialId)) + 1} 张图` : steps[name];
    await this.store.append(key, 'progress', { text, step, done: false });
    const started = Date.now();
    let result: object | null;
    try {
      signal.throwIfAborted();
      result = await this.tool(run, name, args);
      await this.store.append(key, 'tool', { name, elapsedMs: Date.now() - started, promptVersion: agentPromptVersion,
        arguments: Object.keys(args), operations: Array.isArray(args.operations) ? args.operations.map(op => op?.action) : undefined,
        result: result && Object.keys(result),
        ...(result && 'issues' in result ? { errorCode: 'needs_review' } : {}) });
      await this.store.append(key, 'progress', { text, step, done: true });
      if (result === null) {
        await this.ask(key, readQuestions(args));
      }
      return result;
    } catch (error) {
      await this.store.append(key, 'tool', { name, elapsedMs: Date.now() - started, promptVersion: agentPromptVersion,
        errorCode: error instanceof HttpError ? error.code : 'tool_failed' });
      throw error;
    }
  }

  private async ask(key: TurnKey, questions: Question[]) {
    await this.store.append(key, 'questions', { questions });
    await this.store.finish(key, 'completed', questions.map(q =>
      `${q.customer ? q.customer + '：' : ''}${q.text}${q.options.length ? ' 选项：' + q.options.join(' / ') : ''}`).join('\n'));
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

  private async tool(run: Run, name: string, args: Record<string, unknown>) {
    const { key, input, signal } = run;
    const { account, draftId } = key;
    if (name === 'read_draft' || name === 'list_customers') {
      return readAccount(this.pool, account, async client => {
        const current = await readWorkspace(client, account);
        if (current.id !== draftId || current.revision !== run.revision) checkDraft(current, draftId, run.revision);
        const parties = await readParties(client, account);
        if (name === 'list_customers') return { customers: parties.map((party, index) => ({ ...party, label: `客户 ${index + 1}` })) };
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
    if (name === 'read_current_trip') {
      const { currentTrip } = await this.trips.workspace(account);
      if (!currentTrip?.id) return { picking: [], customers: [] };
      const { trip, picking } = await this.trips.trip(account, currentTrip.id);
      return { picking, customers: latest(trip).customers.map(customer => customer.customer) };
    }
    if (name === 'ask_user') {
      readQuestions(args);
      if (input.materialIds.some(id => !run.images.has(id))) {
        throw new HttpError(502, 'images_not_imported', '还有图片没处理完，请重试。');
      }
      return null;
    }
    await run.checkSession();
    if (name === 'preview_trip') {
      if (run.readRevision !== run.revision) return { issues: ['请先读取当前修订的草稿并核对必填项。'] };
      const requestId = randomUUID();
      try {
        const preview = await this.trips.preview(account, { draftId, revision: run.revision, requestId }, signal);
        await this.store.append(key, 'preview', { preview });
        run.shownPreview = true;
        return { ready: true, pendingPrices: preview.customers.flatMap(customer => customer.items).filter(item => item.price === null).length };
      } catch (error) {
        if (error instanceof HttpError && error.code === 'invalid_draft') return { issues: [error.message] };
        throw error;
      }
    }
    if (name === 'edit_draft') {
      if (!input.text) return { issues: ['请先发文字说明需要添加或修改的明细。'] };
      const requestId = randomUUID();
      const result = await writeAccount(this.pool, account, requestId,
        { action: 'agent-edit', turnId: key.id, revision: run.revision }, async (client, workspace) => {
          signal.throwIfAborted();
          checkDraft(workspace, draftId, run.revision, true);
          const parties = await readParties(client, account);
          const prepared = prepareEdits(workspaceDraft(workspace), args, parties, input.text, run.previous);
          if (!('draft' in prepared)) return prepared;
          const { draft } = readSaveDraft(draftId, { ...prepared.draft, revision: run.revision, requestId });
          const revision = run.revision + 1;
          await client.query('UPDATE dispatch.workspaces SET draft_revision = $2, draft_customers = $3 WHERE account_id = $1',
            [account, revision, JSON.stringify(draft.customers)]);
          await saveChange(client, key, revision, prepared.lines, signal);
          return { added: prepared.added, lines: prepared.lines, revision };
        });
      if ('revision' in result && result.revision !== undefined) run.revision = result.revision;
      return result;
    }
    const materialId = args.materialId;
    if (typeof materialId !== 'string' || !input.materialIds.includes(materialId)) invalidTool();
    if (run.images.has(materialId)) return { issues: ['这张图已处理，请核对草稿。'] };
    const traces: ModelTrace[] = [];
    const before = await readAccount(this.pool, account, async client => workspaceDraft(await readWorkspace(client, account)));
    const lineCount = (draft: typeof before) => targetRows(draft).filter(({ item }) => !isPlaceholder(item)).length;
    try {
      const image = readImageOrder({ draftId, revision: run.revision, materialId, requestId: randomUUID() });
      const result = await withDeadline(this.orders.importImage(account, image, run.checkSession, {
        signal, trace: trace => traces.push(trace),
        saved: (client, draft, digest) => saveChange(client, key, draft.revision,
          [`图片新增 ${lineCount(draft) - lineCount(before)} 行`], signal, digest),
      }), signal);
      run.images.add(materialId);
      if ('issues' in result) return result;
      run.revision = result.draft.revision;
      return { added: lineCount(result.draft) - lineCount(before), issues: textOrderQuestions(result.draft) };
    } catch (error) {
      if (error instanceof HttpError && ['duplicate_order_image', 'unsupported_order_image'].includes(error.code)) {
        run.images.add(materialId);
        return { issues: [{ code: error.code, message: error.message }] };
      }
      throw error;
    } finally {
      for (const trace of traces) await this.store.append(key, 'model', trace);
    }
  }
}
