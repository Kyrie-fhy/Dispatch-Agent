import { randomUUID } from 'node:crypto';
import { isObject } from '../../miniprogram/core/orders';
import { hasSpokenNumber, spokenNumbers } from '../../miniprogram/core/spoken-numbers';
import { textFields } from '../../miniprogram/core/text-order';
import { emptyCustomer, TripDraft } from '../../miniprogram/core/trips';
import type { Party } from '../../miniprogram/core/settlement';
import type { Question } from '../../miniprogram/core/agent';
import { HttpError } from '../http-error';
import { isPlaceholder, mergeOrder, normalized, safeFields, targetRows } from '../text-orders';

export function invalidTool(): never {
  throw new HttpError(502, 'invalid_agent_tool', '助手无法读取本次整理结果，可以重试或手动填写。');
}

export type EditConfirmation = { operations: unknown[]; accept: string };
export type PreviousQuestions = {
  turnId: string;
  text: string;
  payload: { questions: Question[]; sourceText?: string };
  confirmation?: EditConfirmation | null;
};

function includesValue(source: string, value: string) {
  return /^\d+(\.\d+)?$/.test(value) ? hasSpokenNumber(source, value) : source.includes(normalized(value));
}

const incrementVerb = /(?:追加|再加|加上|增加|多要|多来|多拿|加)\s*(.+)/;
const repeatVerb = /[再又还][要来拿订给带捎]\s*(.+)/;
const changeVerb = /改成|改为|改到|改一下|更正|换成|调整|重填|单价改|价格改/;

function statedQuantity(source: string, unit: string, verb: RegExp): number | undefined {
  const afterVerb = source.match(verb)?.[1];
  if (!afterVerb) return;
  const [token] = spokenNumbers(afterVerb);
  if (token?.start !== 0 || token.value === null || !Number.isSafeInteger(token.value) || token.value <= 0) return;
  const suffix = afterVerb.slice(token.end).trim();
  if (suffix && !suffix.startsWith(unit) && !/^[，,。；;！!]/.test(suffix)) return;
  return token.value;
}

function repeatedQuantity(source: string, unit: string) {
  if (!unit || changeVerb.test(source) || /追加|再加|加上|增加|多[要来拿]/.test(source) ||
      statedQuantity(source, unit, incrementVerb) !== undefined) return;
  return statedQuantity(source, unit, repeatVerb);
}

function compatibleDetail(fromDraft?: string | null, fromCandidate?: string) {
  const oldValue = normalized(fromDraft ?? '');
  const newValue = normalized(fromCandidate ?? '');
  return !oldValue || !newValue || oldValue === newValue;
}

function quantityQuestion(row: ReturnType<typeof targetRows>[number], quantity: number) {
  const amount = `${quantity} ${row.item.unit}`;
  return { questions: [{
    customer: row.customer.customer,
    text: `${row.item.product}是改成 ${amount}，还是加上 ${amount}？`,
    options: [`改成 ${amount}`, `加上 ${amount}`],
  }] };
}

const unionKeys = ['customerNumber', 'partyNumber', 'partyId'] as const;

function normalizeAddFill(op: Record<string, unknown>, draft: TripDraft): Record<string, unknown> {
  const normalizedOp = { ...op };
  if (normalizedOp.action === 'add') {
    // add 只按客户名称归属；行号 target 与选择客户用的联合键对新增没有意义。
    delete normalizedOp.target;
    const spoken = typeof normalizedOp.customer === 'string' ? normalizedOp.customer.trim() : '';
    const number = normalizedOp.customerNumber;
    if (!spoken && Number.isSafeInteger(number) && Number(number) > 0) {
      // 数字序号只还原成草稿里已有的称呼，真正的归属仍交给认人和合并流程复核，
      // 不能凭模型给出的序号把新名字直接塞进某位熟客。
      const row = draft.customers[Number(number) - 1];
      if (row?.customer.trim()) normalizedOp.customer = row.customer.trim();
    }
  }
  for (const key of unionKeys) delete normalizedOp[key];
  for (const field of textFields) {
    if (normalizedOp[field] === null) delete normalizedOp[field];
  }
  for (const field of ['quantity', 'price'] as const) {
    const value = normalizedOp[field];
    if (typeof value === 'number' && Number.isFinite(value)) normalizedOp[field] = String(value);
  }
  return normalizedOp;
}

export function prepareEdits(draft: TripDraft, value: unknown, parties: Party[], source: string, previous?: PreviousQuestions, confirmed = false) {
  if (!isObject(value) || !Array.isArray(value.operations) || !value.operations.length || value.operations.length > 24) invalidTool();
  const operations = value.operations.map((op: unknown) => isObject(op) && (op.action === 'add' || op.action === 'fill')
    ? normalizeAddFill(op, draft) : op);
  const edits = operations.filter((op: unknown) => isObject(op) && (op.action === 'add' || op.action === 'fill'));
  const next = structuredClone(draft);
  const initial = targetRows(draft);
  const actualRows = initial.filter(entry => !isPlaceholder(entry.item));
  const lines: string[] = [];
  const confirmations: string[] = [];
  let deleting = false;
  const names = new Set(parties.map(party => normalized(party.name)));
  const response = normalized(source);
  const priorText = previous?.payload.sourceText ?? previous?.text;
  const shortAnswer = response.replace(/\s/g, '');
  const matches = previous?.payload.questions.flatMap(question => question.options
    .map(normalized).filter(candidate =>
      candidate.replace(/\s/g, '') === shortAnswer ||
      (/^(?:追加|加上|再加|增加|加)$/.test(shortAnswer) && /^(?:追加|增加|再加|加上)/.test(candidate)) ||
      (/^(?:改成|改为)$/.test(shortAnswer) && /^(?:改成|改为)/.test(candidate)))
    .map(option => ({ question, option }))) ?? [];
  const selectedMatch = matches.length === 1 ? matches[0] : undefined;
  const selected = selectedMatch?.option ?? '';
  const targetSource = selectedMatch
    ? [response, priorText ?? '', selectedMatch.question.customer, selectedMatch.question.text].map(normalized).join(' ')
    : response;
  const checkRepeat = !confirmed && !selected;
  const issues = (message: string) => ({ issues: [{ code: 'edit_needs_review', message }] });

  if (edits.length) {
    if (edits.some(op => isObject(op) && typeof op.price === 'string' && op.price.trim() &&
      !includesValue(response, op.price.trim()))) return issues('请明确说明要填写的单价。');
    if (edits.some(op => isObject(op) && typeof op.quantity === 'string' && op.quantity.trim() &&
      !includesValue(response, op.quantity.trim()))) return issues('请说明要填写的确切数量。');
    if (checkRepeat && repeatVerb.test(response)) {
      for (const op of edits) {
        if (!isObject(op) || op.action !== 'add' || typeof op.customer !== 'string') continue;
        const customerName = normalized(op.customer);
        const { unit, product, quantity: proposed, brand, specification } = safeFields(op, invalidTool);
        if (!customerName || !unit || !product || !proposed) continue;
        const quantity = repeatedQuantity(response, normalized(unit));
        if (quantity === undefined || quantity !== Number(proposed)) continue;
        const matches = actualRows.filter(({ customer, item }) =>
          normalized(customer.customer) === customerName &&
          normalized(item.product) === normalized(product) &&
          normalized(item.unit) === normalized(unit) &&
          compatibleDetail(item.brand, brand) && compatibleDetail(item.specification, specification));
        if (matches.length === 1) return quantityQuestion(matches[0], quantity);
      }
    }
    const contextSource = priorText ? `${source} ${priorText}` : source;
    const merged = mergeOrder(next, { operations: edits }, names, contextSource, true);
    if (!merged.draft) return { issues: merged.issues };
    next.customers = merged.draft.customers;
  }

  for (const op of operations as unknown[]) {
    if (!isObject(op)) invalidTool();
    if (op.action === 'add' || op.action === 'fill') continue;
    if (op.action === 'set_customer') {
      const number = response.match(/客户\s*(\d+)/)?.[1] ?? selected.match(/客户\s*(\d+)/)?.[1];
      const party = number ? parties[Number(number) - 1] : undefined;
      const creates = /新建|另建/.test(response || selected);
      const unresolved = next.customers.filter(entry => entry.partyId === undefined && entry.customer.trim() &&
        (party ? normalized(entry.customer) === normalized(party.name) : names.has(normalized(entry.customer))));
      const customer = Number.isSafeInteger(op.customerNumber)
        ? next.customers[Number(op.customerNumber) - 1]
        : unresolved.length === 1 ? unresolved[0] : undefined;
      if (!customer || (!party && !creates) || (party && normalized(party.name) !== normalized(customer.customer))) {
        return issues('请选择对应的已有客户，或明确选择新建客户。');
      }
      const label = party ? `客户 ${number}` : '新建';
      if (party && next.customers.some(entry => entry !== customer && entry.partyId === party.id)) {
        return issues('本趟已有该客户，请在同一张客户单录入。');
      }
      const oldName = customer.customer;
      if (party) customer.customer = party.name;
      customer.partyId = party?.id ?? null;
      lines.push(`${oldName}：${party ? `关联${party.name} · ${label}` : '确认新建客户'}`);
      continue;
    }
    if (op.action !== 'update' && op.action !== 'remove_line') invalidTool();
    if (!Number.isSafeInteger(op.target)) invalidTool();
    const old = initial[Number(op.target) - 1];
    const row = old && targetRows(next).find(entry => entry.item.id === old.item.id);
    if (!row || isPlaceholder(row.item)) return issues('请指明要修改的货品明细。');
    const label = `${row.customer.customer} ${row.item.product}`.trim();
    const matchScore = ({ item, customer }: typeof row) =>
      Number(Boolean(item.product && targetSource.includes(normalized(item.product)))) +
      Number(Boolean(customer.customer && targetSource.includes(normalized(customer.customer))));
    const score = matchScore(old);
    if (actualRows.length !== 1 && (!score || actualRows.some(candidate => candidate !== old && matchScore(candidate) >= score))) {
      return issues('请带上客户和货品名称，指明要改哪一行。');
    }
    if (op.action === 'remove_line') {
      if (!confirmed && !/删除|删掉|去掉|不要了|取消这条/.test(response)) {
        if (!score) return issues('请带上客户或货品名称，指明要删哪一行。');
        deleting = true;
        confirmations.push(`删掉 ${label} ${row.item.quantity} ${row.item.unit}`);
      }
      row.customer.items = row.customer.items.filter(item => item.id !== row.item.id);
      if (!row.customer.items.length) next.customers = next.customers.filter(entry => entry !== row.customer);
      lines.push(`删除 ${label} ${row.item.quantity} ${row.item.unit}`);
      continue;
    }
    const namesProduct = Boolean(row.item.product && targetSource.includes(normalized(row.item.product)));
    const uniqueRow = actualRows.length === 1 && !draft.customers.some(customer =>
      customer !== old.customer && customer.customer.trim() && targetSource.includes(normalized(customer.customer)));
    const explicit = changeVerb.test(response + selected);
    const fields = safeFields(op, invalidTool);
    if (checkRepeat && fields.quantity && (!fields.unit || normalized(fields.unit) === normalized(old.item.unit))) {
      const quantity = repeatedQuantity(response, normalized(old.item.unit));
      if (quantity !== undefined &&
          (Number(fields.quantity) === quantity || Number(fields.quantity) === Number(old.item.quantity) + quantity)) {
        return quantityQuestion(old, quantity);
      }
    }
    for (const field of textFields) {
      const value = fields[field];
      if (typeof value !== 'string' || value === row.item[field]) continue;
      const increment = field === 'quantity'
        ? statedQuantity(selected || response, normalized(row.item.unit), incrementVerb) ||
          (selected && priorText && incrementVerb.test(selected)
            ? statedQuantity(normalized(priorText), row.item.unit, repeatVerb) : undefined)
        : undefined;
      const append = increment !== undefined && Number(row.item.quantity) + increment === Number(value);
      const eligible = field !== 'price' || /单价|价格|每[公斤斤箱袋件个包]/.test(response);
      if (!includesValue(response, value) && !includesValue(selected, value) && !append) {
        return issues('请说明本轮要改成的值。');
      }
      if (!confirmed && !((namesProduct || uniqueRow) && (append || (eligible && explicit)))) {
        const unit = field === 'price' ? '元' : field === 'quantity' ? row.item.unit : '';
        confirmations.push(`${label} ${row.item[field] || '空'}${unit}改成 ${value}${unit}`);
      }
      row.item[field] = value;
    }
  }

  if (confirmations.length) {
    const accept = deleting ? '删掉' : '改';
    const reject = deleting ? '保留' : '不改';
    const description = confirmations.join('；');
    const question: Question = { customer: '', text: `确认${description}？`,
      options: [accept, reject] };
    return { confirmation: { operations: value.operations, accept }, question };
  }

  if (!next.customers.length) next.customers = [emptyCustomer(randomUUID)];
  const before = new Map(initial.map(row => [row.item.id, row]));
  let added = 0;
  for (const { customer, item } of targetRows(next)) {
    if (isPlaceholder(item)) continue;
    const prior = before.get(item.id)?.item;
    if (!prior || isPlaceholder(prior)) {
      added++;
      continue;
    }
    for (const field of textFields) {
      if (item[field] === prior[field]) continue;
      const label = { product: '货品', brand: '品牌', specification: '规格', unit: '单位', quantity: '数量', price: '单价' }[field];
      const unit = field === 'quantity' ? item.unit : field === 'price' ? '元' : '';
      const from = prior[field] ? `${prior[field]}${unit}` : '空';
      const to = item[field] ? `${item[field]}${unit}` : '空';
      lines.push(`${customer.customer} ${item.product} ${label}：${from} → ${to}`);
    }
  }
  if (added) lines.unshift(`新增 ${added} 行`);
  if (JSON.stringify(next.customers) === JSON.stringify(draft.customers)) return issues('草稿已有相同内容，请核对明细。');
  if (!lines.length) lines.push('已补充客户或货品信息');
  return { draft: { ...next, revision: draft.revision + 1 }, lines, added };
}
