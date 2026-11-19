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

function statedQuantity(source: string, unit: string): number | undefined {
  const afterVerb = source.match(/(?:追加|再加|加上|加|再要|再来)\s*(.+)/)?.[1];
  if (!afterVerb) return;
  const [token] = spokenNumbers(afterVerb);
  if (token?.start !== 0 || token.value === null || !Number.isInteger(token.value)) return;
  const suffix = afterVerb.slice(token.end).trim();
  if (suffix && !suffix.startsWith(unit) && !/^[，,。；;！!]/.test(suffix)) return;
  return token.value;
}

export function prepareEdits(draft: TripDraft, value: unknown, parties: Party[], source: string, previous?: PreviousQuestions, confirmed = false) {
  if (!isObject(value) || !Array.isArray(value.operations) || !value.operations.length || value.operations.length > 24) invalidTool();
  const edits = value.operations.filter((op: unknown) => isObject(op) && (op.action === 'add' || op.action === 'fill'));
  const next = structuredClone(draft);
  const initial = targetRows(draft);
  const lines: string[] = [];
  const confirmations: string[] = [];
  let deleting = false;
  const names = new Set(parties.map(party => normalized(party.name)));
  const response = normalized(source);
  const priorText = previous?.payload.sourceText ?? previous?.text;
  const options = previous?.payload.questions.flatMap(question => question.options) ?? [];
  const matches = options.filter(option => {
    const candidate = normalized(option);
    return candidate === response || (response === '追加' && candidate.startsWith('追加')) || (response === '改成' && candidate.startsWith('改成'));
  });
  const selected = matches.length === 1 ? normalized(matches[0]) : '';
  const issues = (message: string) => ({ issues: [{ code: 'edit_needs_review', message }] });

  if (edits.length) {
    if (edits.some(op => isObject(op) && typeof op.price === 'string' && op.price.trim() &&
      !includesValue(response, op.price.trim()))) return issues('请明确说明要填写的单价。');
    if (edits.some(op => isObject(op) && typeof op.quantity === 'string' && op.quantity.trim() &&
      !includesValue(response, op.quantity.trim()))) return issues('请说明要填写的确切数量。');
    const contextSource = priorText ? `${source} ${priorText}` : source;
    const merged = mergeOrder(next, { operations: edits }, names, contextSource);
    if (!merged.draft) return { issues: merged.issues };
    next.customers = merged.draft.customers;
  }

  for (const op of value.operations as unknown[]) {
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
    const actualRows = initial.filter(entry => !isPlaceholder(entry.item));
    const targetSource = selected && priorText ? response + normalized(priorText) : response;
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
    const explicit = /改成|改为|改到|改一下|更正|换成|调整|重填|单价改|价格改/.test(response + selected);
    const fields = safeFields(op, invalidTool);
    for (const field of textFields) {
      const value = fields[field];
      if (typeof value !== 'string' || value === row.item[field]) continue;
      const increment = field === 'quantity'
        ? (selected && priorText && statedQuantity(normalized(priorText), row.item.unit)) ||
          statedQuantity(selected || response, row.item.unit)
        : undefined;
      const append = typeof increment === 'number' && increment > 0 && /追加|加/.test(selected || response)
        && Number(row.item.quantity) + increment === Number(value);
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
