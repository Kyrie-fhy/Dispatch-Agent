import { randomUUID } from 'node:crypto';
import { isObject } from '../../miniprogram/core/orders';
import { textFields } from '../../miniprogram/core/text-order';
import { emptyCustomer, TripDraft } from '../../miniprogram/core/trips';
import type { Party } from '../../miniprogram/core/settlement';
import type { Question } from '../../miniprogram/core/agent';
import { HttpError } from '../http-error';
import { isPlaceholder, mergeOrder, normalized, safeFields, targetRows } from '../text-orders';

export function invalidTool(): never {
  throw new HttpError(502, 'invalid_agent_tool', '助手无法读取本次整理结果，可以重试或手动填写。');
}

export type PreviousQuestions = { text: string; payload: { questions: Question[] } };

function includesValue(source: string, value: string) {
  if (!/^\d+(\.\d+)?$/.test(value)) return source.includes(value);
  const literals = source.match(/\d+(?:\.\d+)?/g) ?? [];
  return literals.some(literal => Number(literal) === Number(value));
}

function statedQuantity(source: string, unit: string): number | undefined {
  const token = source.match(/(?:追加|加|再要)\s*(\d+|[一二两三四五六七八九十]+)\s*(.*)/);
  if (!token || (token[2] && !token[2].startsWith(unit))) return;
  if (/^\d+$/.test(token[1])) return Number(token[1]);
  const digits = '零一二三四五六七八九';
  const value = token[1].replace(/两/g, '二');
  if (value.length === 1 && value !== '十') return digits.indexOf(value);
  if (!/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(value)) return;
  const [tens, ones] = value.split('十');
  return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
}

export function prepareEdits(draft: TripDraft, value: unknown, parties: Party[], source: string, previous?: PreviousQuestions) {
  if (!isObject(value) || !Array.isArray(value.operations) || !value.operations.length || value.operations.length > 24) invalidTool();
  const edits = value.operations.filter((op: unknown) => isObject(op) && (op.action === 'add' || op.action === 'fill'));
  const next = structuredClone(draft);
  const initial = targetRows(draft);
  const lines: string[] = [];
  const names = new Set(parties.map(party => normalized(party.name)));
  const response = normalized(source);
  const options = previous?.payload.questions.flatMap(question => question.options) ?? [];
  const matches = options.filter(option => {
    const candidate = normalized(option);
    return candidate === response || (response === '追加' && candidate.startsWith('追加'));
  });
  const selected = matches.length === 1 ? normalized(matches[0]) : '';
  const issues = (message: string) => ({ issues: [{ code: 'edit_needs_review', message }] });

  if (edits.length) {
    if (edits.some(op => isObject(op) && typeof op.price === 'string' && op.price.trim() &&
      !includesValue(response, op.price.trim()))) return issues('请明确说明要填写的单价。');
    const merged = mergeOrder(next, { operations: edits }, names, source);
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
    const hasTarget = (row.item.product && response.includes(normalized(row.item.product))) ||
      (initial.filter(entry => !isPlaceholder(entry.item)).length === 1) ||
      (row.customer.customer && response.includes(normalized(row.customer.customer)) &&
        row.customer.items.filter(item => !isPlaceholder(item)).length === 1);
    if (!hasTarget && !(selected && previous?.text.includes(row.customer.customer))) {
      return issues('请带上客户和货品名称，指明要改哪一行。');
    }
    if (op.action === 'remove_line') {
      if (!/删除|删掉|去掉|不要了|取消这条/.test(response)) return issues('请明确说明是否删除这条货品。');
      row.customer.items = row.customer.items.filter(item => item.id !== row.item.id);
      if (!row.customer.items.length) next.customers = next.customers.filter(entry => entry !== row.customer);
      lines.push(`删除 ${label} ${row.item.quantity} ${row.item.unit}`);
      continue;
    }
    const fields = safeFields(op, invalidTool);
    for (const field of textFields) {
      const value = fields[field];
      if (typeof value !== 'string' || value === row.item[field]) continue;
      const explicit = /改成|改为|改到|改一下|更正|换成|调整|重填|单价改|价格改/.test(response + selected);
      const increment = field === 'quantity'
        ? (selected && previous && statedQuantity(normalized(previous.text), row.item.unit)) ||
          statedQuantity(selected || response, row.item.unit)
        : undefined;
      const append = typeof increment === 'number' && increment > 0 && /追加|加/.test(selected || response)
        && Number(row.item.quantity) + increment === Number(value);
      const eligible = field !== 'price' || /单价|价格|每[公斤斤箱袋件个包]/.test(response);
      if (!(eligible && explicit && (includesValue(response, value) || includesValue(selected, value))) && !append) {
        return issues('这条明细已有内容，请明确要改成什么，或点选追问里的选项。');
      }
      row.item[field] = value;
    }
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
