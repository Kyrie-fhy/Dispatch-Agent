import type { DeliveryProposal, PlanStep, Question, StepState } from '../../miniprogram/core/agent';
import { deliveryLines, deliverySummary, type DeliveryLine } from '../../miniprogram/core/delivery-execution';
import { isObject, money, unitPrice } from '../../miniprogram/core/orders';
import { hasSpokenNumber, spokenNumbers } from '../../miniprogram/core/spoken-numbers';
import { latest } from '../../miniprogram/core/trips';
import { HttpError } from '../http-error';
import type { TripStore } from '../trips';
import { deliveryPromptVersion, type DeliveryModel } from './delivery-model';
import { clipDecisions, type ControlDecision } from './decisions';
import type { PreviousQuestions } from './edit';
import type { AgentModelTrace } from './model';
import type { AgentStore, Input, TurnKey } from './store';

type Trip = Awaited<ReturnType<TripStore['trip']>>;
type Intent = { adjust: boolean; query: boolean; answering: boolean; lookup?: unknown; shop?: unknown };
type Sheet = ReturnType<typeof sheetsFor>[number];
type Candidate = { proposal?: DeliveryProposal; question?: Question; text?: string; decisions?: ControlDecision[] };
const intentError = () => new HttpError(502, 'delivery_invalid_model_output', '没能核对这条消息，请重试或去送货单修改。');
const label = (line: Pick<DeliveryLine, 'brand' | 'product' | 'specification' | 'unit'>) =>
  [line.brand, line.product, line.specification, line.unit].filter(Boolean).join(' / ');
const lineOption = (line: DeliveryLine, number: number) => `第 ${number} 行（${label(line)}）`;
const locked = (sheet: Sheet) => sheet.deliveryCompleted || sheet.reviewed;
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const mentions = (text: string, name: string) => Boolean(name && normalized(text).includes(normalized(name)));

function sheetsFor({ trip, sheets, deliveryEdits }: Trip) {
  return latest(trip).customers.flatMap(customer => {
    const sheet = sheets.find(item => item.sheetId === customer.id);
    return sheet ? [{ ...sheet, customer: customer.customer, lines: deliveryLines(customer, deliveryEdits), order: customer }] : [];
  });
}

function question(text: string, options: string[] = [], customer = '', decisions?: ControlDecision[]): Candidate {
  return { question: { customer, text, options }, ...(decisions?.length ? { decisions } : {}) };
}

function traceInputSummary(phase: 'intent' | 'candidate', body: object) {
  const fields = body as Record<string, unknown>;
  if (phase === 'intent') {
    return { shopCount: Array.isArray(fields.shops) ? fields.shops.length : 0,
      questionCount: Array.isArray(fields.previous) ? fields.previous.length : 0 };
  }
  const sheets = Array.isArray(fields.sheets) ? fields.sheets : [];
  return {
    shopCount: sheets.length,
    lineCount: sheets.reduce((sum: number, sheet) => sum + (isObject(sheet) && Array.isArray(sheet.lines) ? sheet.lines.length : 0), 0),
    spokenNumbers: Array.isArray(fields.numbers) ? fields.numbers : [],
    hasPreviousQuestions: isObject(fields.previous) && Array.isArray(fields.previous.questions) && fields.previous.questions.length > 0,
  };
}

function traceArguments(output: unknown) {
  if (!isObject(output) || !('args' in output)) return {};
  const text = JSON.stringify(output.args);
  return text.length <= 2_000 ? output.args : { truncated: true, json: text.slice(0, 2_000) };
}

function traceResult(candidate: Candidate) {
  const decisions = candidate.decisions?.length ? { decisions: clipDecisions(candidate.decisions) } : {};
  if (candidate.proposal) {
    return { outcome: 'proposal', customer: candidate.proposal.customer, editCount: candidate.proposal.edits.length,
      canComplete: candidate.proposal.canComplete, pendingPriceNames: candidate.proposal.pendingPriceNames, ...decisions };
  }
  if (candidate.question) return { outcome: 'question', question: candidate.question.text, ...decisions };
  return { outcome: 'blocked_or_noop', text: candidate.text ?? '', ...decisions };
}

function quantityFrom(source: string, line: DeliveryLine, quantity: number) {
  const relative = [...source.matchAll(/(?:少收|少要|退回|退掉|退了|少拿|少给|短收|少签收)\s*(?:了|掉)?\s*([^，。；,;\n]{1,20})/g)];
  const deltas = relative.flatMap(match => {
    const number = spokenNumbers(match[1])[0];
    return number?.start === 0 && number.value !== null && number.value > 0 && Number.isSafeInteger(number.value) ? [number.value] : [];
  });
  if (deltas.some(delta => [Number(line.originalQuantity), line.receivedQuantity].some(base => base - delta === quantity))) return true;
  const directSource = source.replace(/第\s*[\d零一二两三四五六七八九十百]+\s*行/g, '')
    .replace(/(?:少收|少要|退回|退掉|退了|少拿|少给|短收|少签收)\s*(?:了|掉)?\s*[\d零一二两三四五六七八九十百]+/g, '')
    .replace(/(?:按|单价[是为]?|每[^，。；,;\n]{1,4})\s*[\d零一二两三四五六七八九十百千点块元角毛分.]+/g, '');
  if (hasSpokenNumber(directSource, String(quantity))) return true;
  return quantity === 0 && !deltas.length && /拒收|退回|不收|不要|退掉|退了|退货/.test(source);
}

function resolve(trip: Trip, sheets: Sheet[], output: unknown, source: string): Candidate {
  if (!isObject(output) || !isObject(output.args)) throw intentError();
  const { args } = output;
  if (output.tool === 'ask_delivery_user') {
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 300 || !Array.isArray(args.options) ||
        args.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 100)) throw intentError();
    const options: string[] = args.options;
    if (options.length >= 2) {
      const unlocked = sheets.filter(item => !locked(item));
      const customers = options.map(option => {
        const matches = unlocked.filter(item => mentions(option, item.customer));
        return matches.length === 1 ? matches[0].customer : undefined;
      });
      if (customers.every(customer => customer !== undefined) && new Set(customers).size === options.length) {
        return question(args.text, customers.slice(0, 20));
      }
    }
    return question(args.text, [...new Set(options)].slice(0, 20));
  }
  if (output.tool !== 'propose_delivery' || !Array.isArray(args.edits) || args.edits.length > 200 || typeof args.readyToComplete !== 'boolean') throw intentError();
  const named = sheets.filter(item => mentions(source, item.customer));
  const sheet = args.sheetNumber === undefined && named.length === 1 ? named[0] :
    typeof args.sheetNumber === 'number' && Number.isSafeInteger(args.sheetNumber) ? sheets[args.sheetNumber - 1] : undefined;
  if (sheet && (named.includes(sheet) || !named.length) && locked(sheet)) {
    return { text: `「${sheet.customer}」已确认送达，应收已锁定，不能再改。`, decisions: [{
      ruleId: 'delivery.locked_sheet', decision: 'block', layer: 'delivery',
      reason: '目标门店已确认送达或核对锁定，禁止修改', target: sheet.customer,
    }] };
  }
  if (args.blockedReason === 'new_item_after_issue') {
    return { text: '本趟已出单，不能直接新增原单没有的货品；请先核对原单明细，新订货品可在开始下一趟后录入。', decisions: [{
      ruleId: 'delivery.new_item_after_issue', decision: 'block', layer: 'delivery',
      reason: '本趟已出单，禁止直接新增原单没有的货品', ...(sheet ? { target: sheet.customer } : {}),
    }] };
  }
  if (args.blockedReason === 'next_trip_order') {
    return { text: '当前正在本趟送货中，如需录下一趟订单，请先到「送货」页底部点「开始下一趟」。', decisions: [{
      ruleId: 'delivery.next_trip_order', decision: 'block', layer: 'delivery',
      reason: '送货中拦截下趟新单，引导先点开始下一趟',
    }] };
  }
  if (args.blockedReason !== undefined || !sheet || (named.length && !named.includes(sheet))) {
    return question('请说清楚要核对哪家门店。', sheets.filter(item => !locked(item)).map(item => item.customer), '', [{
      ruleId: 'delivery.ambiguous_shop_or_line', decision: 'confirm', layer: 'delivery',
      reason: '未能唯一定位要核对的门店，需配送员确认',
    }]);
  }
  if (!args.edits.length && !args.readyToComplete) return question('请说清楚要修改的货品、实收数量或单价。');
  if (!args.edits.length && named.length !== 1) {
    const eligible = named.length ? named : sheets.filter(item => !locked(item));
    if (eligible.length > 1) {
      return question('请问是哪家店已送到？', eligible.map(item => item.customer), '', [{
        ruleId: 'delivery.ambiguous_shop_or_line', decision: 'confirm', layer: 'delivery',
        reason: '多家未送达门店存在歧义，需确认是哪家店',
      }]);
    }
  }
  const edits: DeliveryProposal['edits'] = [];
  const combined = { ...trip.deliveryEdits };
  const seen = new Set<string>();
  for (const change of args.edits) {
    if (!isObject(change) || typeof change.lineNumber !== 'number' || !Number.isSafeInteger(change.lineNumber)) throw intentError();
    const line = sheet.lines[change.lineNumber - 1];
    if (!line || seen.has(line.id)) throw intentError();
    seen.add(line.id);
    const peers = sheets.filter(item => !locked(item) && item.lines.some(row => normalized(row.product) === normalized(line.product)));
    if ((named.length !== 1 && peers.length > 1) || named.length > 1) {
      return question(`请问是哪家店的${line.product}？`, (named.length ? named : peers).map(item => item.customer), '', [{
        ruleId: 'delivery.ambiguous_shop_or_line', decision: 'confirm', layer: 'delivery',
        reason: '多家门店存在同款货品，需确认具体门店', target: line.product,
      }]);
    }
    const same = sheet.lines.flatMap((row, index) => normalized(row.product) === normalized(line.product) ? [{ row, index: index + 1 }] : []);
    if (!mentions(source, line.product) && !mentions(line.product, source.trim()) && !mentions(source, lineOption(line, change.lineNumber)) &&
        ![...source.matchAll(/第\s*(\d+|[一二两三四五六七八九十]+)\s*行/g)].some(match => hasSpokenNumber(match[1], String(change.lineNumber)))) {
      return question(`请指出「${sheet.customer}」要修改的货品或行号。`, sheet.lines.map((row, index) => lineOption(row, index + 1)), sheet.customer, [{
        ruleId: 'delivery.ambiguous_shop_or_line', decision: 'confirm', layer: 'delivery',
        reason: '原话未指明要修改的货品或行号，需确认', target: sheet.customer,
      }]);
    }
    if (same.length > 1) {
      const rowMatches = [...source.matchAll(/第\s*(\d+|[一二两三四五六七八九十]+)\s*行/g)];
      const numbered = same.filter(({ index }) => rowMatches.some(match => hasSpokenNumber(match[1], String(index))));
      const explicit = numbered.length ? numbered : same.filter(({ row }) => [row.unit, row.specification, row.brand].some(value =>
        mentions(source, value) && same.filter(peer => [peer.row.unit, peer.row.specification, peer.row.brand].includes(value)).length === 1));
      if (explicit.length !== 1 || explicit[0].row.id !== line.id) {
        return question(`请问改哪一行${line.product}？`, same.map(({ row, index }) => lineOption(row, index)), sheet.customer, [{
          ruleId: 'delivery.ambiguous_shop_or_line', decision: 'confirm', layer: 'delivery',
          reason: '同门店存在多行同款货品，需确认具体行号', target: `${sheet.customer} ${line.product}`.trim(),
        }]);
      }
    }
    const receivedQuantity = change.receivedQuantity === undefined ? line.receivedQuantity : change.receivedQuantity;
    if (typeof receivedQuantity !== 'number' || !Number.isSafeInteger(receivedQuantity) || receivedQuantity < 0 ||
        (receivedQuantity !== line.receivedQuantity && !quantityFrom(source, line, receivedQuantity))) {
      return question(`请说清楚${line.product}实际收了多少${line.unit}。`, [], sheet.customer, [{
        ruleId: 'delivery.ungrounded_quantity_or_price', decision: 'block', layer: 'delivery',
        reason: '实收数量缺少原话出处或非法，已拦截并转追问', target: `${sheet.customer} ${line.product}`.trim(),
      }]);
    }
    let unitPriceCents = line.unitPriceCents;
    if (change.price !== undefined && !(change.price === null && line.unitPriceCents === null)) {
      const raw = typeof change.price === 'number' ? String(change.price) : change.price;
      try {
        if (typeof raw !== 'string') throw intentError();
        unitPriceCents = unitPrice(raw);
        if (unitPriceCents === null || (unitPriceCents !== line.unitPriceCents &&
            !hasSpokenNumber(source.replace(/第\s*[\d一二两三四五六七八九十]+\s*行/g, ''), raw))) throw intentError();
      } catch {
        return question(`请说清楚${line.product}每${line.unit}的单价。`, [], sheet.customer, [{
          ruleId: 'delivery.ungrounded_quantity_or_price', decision: 'block', layer: 'delivery',
          reason: '单价缺少原话出处或非法，已拦截并转追问', target: `${sheet.customer} ${line.product}`.trim(),
        }]);
      }
    }
    if (line.receivedQuantity === receivedQuantity && line.unitPriceCents === unitPriceCents) continue;
    combined[line.id] = { receivedQuantity, unitPriceCents };
    edits.push({ lineId: line.id, name: label(line), originalQuantity: line.originalQuantity, beforeQuantity: line.receivedQuantity,
      beforePrice: line.unitPriceCents === null ? null : money(line.unitPriceCents), receivedQuantity,
      price: unitPriceCents === null ? null : money(unitPriceCents) });
  }
  if (!edits.length && !args.readyToComplete) return { text: '送货单已经是这个数量和单价，没有需要保存的改动。' };
  try {
    const lines = deliveryLines(sheet.order, combined);
    const { totalCents } = deliverySummary(lines);
    const pendingPriceNames = lines.filter(line => line.amountCents === null).map(label);
    return { proposal: { tripId: trip.trip.id, sheetId: sheet.sheetId, customer: sheet.customer, version: latest(trip.trip).version,
      statusRevision: trip.trip.statusRevision, edits, totalCents, pendingPriceNames, canComplete: !pendingPriceNames.length } };
  } catch {
    return question('预计应收超出可计算范围，请检查实收数量和单价。', [], sheet.customer);
  }
}

function replyToQuery(trip: Trip, intent: Intent, source: string) {
  const sheets = sheetsFor(trip);
  if (intent.lookup === 'remaining') {
    const remaining = sheets.filter(sheet => !locked(sheet)).map(sheet => sheet.customer);
    return remaining.length ? `还有 ${remaining.length} 家未送达：${remaining.join('、')}。` : '本趟门店全部已送达。';
  }
  if (intent.lookup === 'picking') return `原订取货汇总：\n${trip.picking.map(line => `${label(line)}：${line.quantity}${line.unit}`).join('\n')}`;
  const matches = sheets.filter(sheet => mentions(source, sheet.customer) ||
    (typeof intent.shop === 'string' && intent.shop && mentions(source, intent.shop) && mentions(sheet.customer, intent.shop)));
  if (matches.length !== 1) return '请说清楚想查哪一家门店。';
  const sheet = matches[0];
  const total = deliverySummary(sheet.lines);
  return `${sheet.customer} · ${locked(sheet) ? '已确认送达，应收' : '未确认送达，预计应收'} ${money(total.totalCents)} 元${total.pendingPrices ? '（另有货品待补价）' : ''}\n` +
    sheet.lines.map(line => `${label(line)}：原订 ${line.originalQuantity}，实收 ${line.receivedQuantity}，单价 ${line.price ?? '待补价'}，小计 ${line.amountCents === null ? '待补价' : `${money(line.amountCents)} 元`}`).join('\n');
}

export async function runDelivery(store: AgentStore, trips: TripStore, model: DeliveryModel | undefined, key: TurnKey,
  input: Input, previous: PreviousQuestions | undefined, signal: AbortSignal, checkSession: () => Promise<unknown>) {
  const steps: PlanStep[] = [{ id: 'intent', text: input.direct?.intent === 'draft' ? '已收到你的选择' : '看懂你的意思' }];
  const terminal = new Set<string>();
  let active = 'intent';
  let planned = false;
  const step = async (id: string, state: StepState, result?: string) => {
    if (state === 'running') active = id;
    else terminal.add(id);
    await store.append(key, 'step', { id, state, result });
  };
  const call = async (phase: 'intent' | 'candidate', body: object) => {
    await checkSession();
    signal.throwIfAborted();
    if (!model) throw new HttpError(503, 'delivery_model_unavailable', '现场对话模型暂未开启，可以去送货单操作。');
    const traces: AgentModelTrace[] = [];
    let output: unknown;
    try {
      output = await model(phase, body, signal, trace => traces.push(trace));
      return output;
    } finally {
      for (const trace of traces) {
        const entry: Record<string, unknown> = { ...trace, phase, inputSummary: traceInputSummary(phase, body) };
        if (phase === 'candidate' && !(Array.isArray(entry.toolCalls) && entry.toolCalls.length)
            && isObject(output) && typeof output.tool === 'string' && isObject(output.args)) {
          entry.toolCalls = [{ name: output.tool, arguments: JSON.stringify(output.args).slice(0, 2_000) }];
        }
        await store.append(key, 'model', entry);
      }
    }
  };
  try {
    const trip = await trips.trip(key.account, key.draftId);
    const sheets = sheetsFor(trip);
    const text = input.text;
    const direct = input.direct?.intent === 'draft';
    const raw = input.direct ? { adjust: direct, query: false, answering: direct } : await call('intent', {
      text, previous: previous?.payload.questions ?? [], shops: sheets.map(sheet => sheet.customer),
    });
    if (!isObject(raw) || typeof raw.adjust !== 'boolean' || typeof raw.query !== 'boolean' || typeof raw.answering !== 'boolean') throw intentError();
    const intent: Intent = { adjust: raw.adjust, query: raw.query, answering: Boolean(previous && raw.adjust && raw.answering), lookup: raw.lookup, shop: raw.shop };
    await store.append(key, 'delivery_intent', { ...intent, direct });
    const add = (id: string, title: string) => steps.push({ id, text: title });
    if (intent.adjust) {
      add('delivery-read', intent.answering ? '按你的回答核对送货单' : '读本趟送货单');
      add('delivery-check', intent.answering ? '算预计应收' : '核对变更与预计应收');
      add('delivery-confirm', '等你确认保存或送达');
      add('delivery-updated', '已更新送货单');
    }
    if (intent.query) {
      add('delivery-query', '查本趟送货与取货进度');
      add('delivery-answer', '回答');
    }
    if (steps.length === 1) add('delivery-other', '回答或提醒操作方式');
    await store.append(key, 'plan', { steps });
    planned = true;
    await step('intent', 'done');
    const answers: string[] = [];
    if (intent.adjust) {
      await step('delivery-read', 'running');
      const earlier = intent.answering ? previous : undefined;
      const source = earlier ? `${earlier.text}\n${text}` : text;
      const summaries = sheets.map((sheet, index) => ({ sheetNumber: index + 1, customer: sheet.customer, deliveryCompleted: locked(sheet),
        lines: sheet.lines.map((line, index) => ({ lineNumber: index + 1, brand: line.brand, product: line.product, specification: line.specification,
          unit: line.unit, originalQuantity: line.originalQuantity, currentReceived: line.receivedQuantity, price: line.price ?? '待补价' })) }));
      await step('delivery-read', 'done');
      await step('delivery-check', 'running');
      const output = await call('candidate', { text, numbers: spokenNumbers(source), sheets: summaries,
        previous: earlier ? { text: earlier.text, questions: earlier.payload.questions } : null });
      const candidateName = isObject(output) && typeof output.tool === 'string' ? output.tool : 'unknown';
      let result: Candidate;
      try {
        result = resolve(trip, sheets, output, source);
      } catch (error) {
        try {
          await store.append(key, 'tool', { name: candidateName, promptVersion: deliveryPromptVersion,
            arguments: traceArguments(output),
            result: { outcome: 'error', errorCode: error instanceof HttpError ? error.code : 'delivery_failed' } });
        } catch {
          // 诊断记录失败不能覆盖真正的业务异常。
        }
        throw error;
      }
      await store.append(key, 'tool', { name: candidateName, promptVersion: deliveryPromptVersion,
        arguments: traceArguments(output), result: traceResult(result) });
      await checkSession();
      signal.throwIfAborted();
      await store.context(key, input.revision);
      if (result.proposal) {
        const card = result.proposal;
        await store.append(key, 'delivery_proposal', card);
        await step('delivery-check', 'done');
        const available = card.canComplete || card.edits.length > 0;
        await step('delivery-confirm', available ? 'needs_input' : 'skipped');
        if (!available) await step('delivery-updated', 'skipped');
      } else {
        if (result.question) await store.append(key, 'questions', { mode: 'delivery', questions: [result.question], context: source.slice(-2000) });
        if (result.text) answers.push(result.text);
        await step('delivery-check', result.question ? 'needs_input' : 'done');
        await step('delivery-confirm', 'skipped');
        await step('delivery-updated', 'skipped');
      }
    }
    if (intent.query) {
      await step('delivery-query', 'running');
      await checkSession();
      await store.context(key, input.revision);
      answers.push(replyToQuery(await trips.trip(key.account, key.draftId), intent, text));
      await step('delivery-query', 'done');
      await step('delivery-answer', 'done');
    }
    if (!intent.adjust && !intent.query) {
      answers.push('我可以核对本趟实收、单价或配送进度。保存与确认送达需要你亲自点核对卡。');
      await step('delivery-other', 'done');
    }
    await store.finish(key, 'completed', answers.join('\n'));
  } catch (error) {
    const text = error instanceof HttpError ? error.message : '现场助手没能处理这条消息，请重试或去送货单修改。';
    if (!planned) await store.append(key, 'plan', { steps });
    await step(active, 'failed', text);
    for (const item of steps) if (!terminal.has(item.id)) await step(item.id, 'skipped');
    await store.finish(key, 'failed', text, error instanceof HttpError ? error.code : 'delivery_failed');
  }
}
