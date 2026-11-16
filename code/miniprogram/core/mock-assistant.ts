import { AssistantNotes, QuantityQuestion } from './assistant-notes';
import { emptyItem, ItemInput, money, yuanToCents } from './orders';
import { accountFor, localDay } from './settlement';
import { currentTrip, CustomerDraft, latest, pickingKey, TripDraft, TripState } from './trips';

export const images = [
  { id: 'a', asset: '/assets/s4/a.png', label: 'A 微信截图', caption: '客户 A：安井水饺 2 箱', text: '录入 客户 A 安井 水饺 - 2箱' },
  { id: 'b', asset: '/assets/s4/b.png', label: 'B 手写单', caption: '客户 B：3 箱 × 80\n另 3 袋 × 20', text: '录入 客户 B 安井 水饺 500g 3箱 80\n录入 客户 B 安井 水饺 500g 3袋 20' },
  { id: 'c', asset: '/assets/s4/c.png', label: 'C 微信截图', caption: '客户 C：三全水饺 1 箱 × 75', text: '录入 客户 C 三全 水饺 500g 1箱 75' },
  { id: 'failure', asset: '', label: '模拟失败', caption: '首次失败，重试后识别 C 的单', text: '录入 客户 C 三全 水饺 500g 1箱 75' },
];

export const voice = [
  { label: '补规格', text: '补充 客户 A 水饺 规格 500g' },
  { label: '整单送达', text: '客户 A 全部送达' },
  { label: '记收款', text: '客户 A 收到 100 元' },
];

const fields = ['product', 'brand', 'specification', 'unit', 'quantity', 'price'] as const;
const labels = ['货品', '品牌', '规格', '单位', '数量', '单价'];
const fieldByLabel = Object.fromEntries(labels.map((label, i) => [label, fields[i]]));
const numeric = /^[1-9]\d*$/;

type InputLine = Omit<ItemInput, 'id'>;
type Add = { kind: 'add'; name: string; line: InputLine };
type Fill = { kind: 'fill'; name: string; product: string; fields: Partial<InputLine> };
type Quantity = { kind: 'quantity'; name: string; product: string; quantity: string; unit: string; source: string };
export type Official = { kind: 'amend'; name: string; product: string; unit?: string; field: 'quantity' | 'price'; value: string }
  | { kind: 'deliver'; name: string }
  | { kind: 'receipt'; name: string; amount: string };
export type Intent = Add | Fill | Quantity | Official | { kind: 'generate' } | { kind: 'newPrice'; price: string };

export function recognize(text: string): Intent | null {
  const source = text.trim().replace(/\s+/g, ' ').replace(/[。！!]+$/, '');
  if (/^(生成送货单|生成整趟|出单)$/.test(source)) return { kind: 'generate' };
  const price = /^这次按\s*(\d+(?:\.\d{1,2})?)\s*元?$/.exec(source);
  if (price) return { kind: 'newPrice', price: price[1] };
  const delivery = /^(.+?)\s*(?:全部送达|整单送达)$/.exec(source);
  if (delivery?.[1].trim()) return { kind: 'deliver', name: delivery[1].trim() };
  const receipt = /^(.+?)\s*收到\s*(\d+(?:\.\d{1,2})?)\s*元?$/.exec(source);
  if (receipt?.[1].trim()) return { kind: 'receipt', name: receipt[1].trim(), amount: receipt[2] };
  const amendment = /^修改 (.+) (\S+?)(?:\/(\S+))? (数量|单价) (\d+(?:\.\d{1,2})?)$/.exec(source);
  if (amendment) return { kind: 'amend', name: amendment[1], product: amendment[2], ...(amendment[3] ? { unit: amendment[3] } : {}),
    field: amendment[4] === '数量' ? 'quantity' : 'price', value: amendment[5] };
  const quantity = /^(.+) (\S+) 再要\s*([1-9]\d*)\s*(\S+)$/.exec(source);
  if (quantity) return { kind: 'quantity', name: quantity[1], product: quantity[2], quantity: quantity[3], unit: quantity[4], source };
  const fill = /^补充 (.+?) (\S+) ((?:(?:货品|品牌|规格|单位|数量|单价) \S+)(?: (?:货品|品牌|规格|单位|数量|单价) \S+)*)$/.exec(source);
  if (fill) {
    const tokens = fill[3].split(' ');
    const updated: Partial<InputLine> = {};
    for (let i = 0; i < tokens.length; i += 2) updated[fieldByLabel[tokens[i]]] = tokens[i + 1];
    return { kind: 'fill', name: fill[1], product: fill[2], fields: updated };
  }
  const addition = /^录入 (.+) (\S+) (\S+) (\S+) ((?:[1-9]\d*|-)\s*(?:箱|袋|件|包|-))(?: (\d+(?:\.\d{1,2})?|-))?$/.exec(source);
  if (!addition) return null;
  const [, name, brand, product, specification, count, priceInput = ''] = addition;
  const parts = /^(\d+|-)\s*(\S+)$/.exec(count)!;
  const optional = (value: string) => value === '-' ? '' : value;
  return { kind: 'add', name, line: { brand: optional(brand), product: optional(product),
    specification: optional(specification), quantity: optional(parts[1]), unit: optional(parts[2]), price: optional(priceInput) } };
}

export function forDraft(state: TripState) {
  const base: AssistantNotes = state.assistant ?? { aliases: [] };
  const prior = base.draft;
  const draft = prior?.id === state.draft.id ? prior : { id: state.draft.id, seen: [], quantities: [] };
  const ids = new Set(state.draft.customers.flatMap(customer => customer.items.map(item => item.id)));
  return { ...base, draft: { ...draft, seen: draft.seen.filter(entry => ids.has(entry.itemId)),
    quantities: draft.quantities.filter(entry => ids.has(entry.itemId)) } };
}

export function knownAlias(state: TripState, name: string) {
  const entry = state.assistant?.aliases.find(alias => alias.name === name);
  // A display name can also belong to another customer. Ask instead of guessing.
  if (state.ledger.parties.some(party => party.name === name && party.id !== entry?.partyId)) return undefined;
  return state.ledger.parties.find(party => party.id === entry?.partyId);
}

export function replaceCustomer(draft: TripDraft, customer: CustomerDraft): TripDraft {
  return { ...draft, customers: draft.customers.map(entry => entry.id === customer.id ? customer : entry) };
}

function isBlank(customer: CustomerDraft) {
  return !customer.customer.trim() && customer.items.length === 1
    && fields.filter(field => field !== 'unit').every(field => customer.items[0][field] === '');
}

function findDraftCustomer(state: TripState, name: string) {
  const alias = knownAlias(state, name);
  const candidates = state.draft.customers.filter(customer => customer.customer.trim() === name || (alias && customer.partyId === alias.id));
  if (candidates.length > 1) throw new Error('本趟有多个同名客户，请在手动编辑中选择对应的客户单');
  return candidates[0];
}

export function applyInput(state: TripState, intents: (Add | Fill | Quantity)[], id: () => string, force = false) {
  const notes = forDraft(state);
  let draft = state.draft;
  const skipped: Add[] = [];
  const changes: string[] = [];
  for (const intent of intents) {
    const current = { ...state, draft };
    const found = findDraftCustomer(current, intent.name);
    if (intent.kind === 'add') {
      const key = JSON.stringify([found?.id ?? intent.name, ...fields.map(field => intent.line[field])]);
      const duplicate = found && (notes.draft.seen.some(entry => entry.key === key)
        || found.items.some(item => fields.every(field => item[field].trim() === intent.line[field])));
      if (!force && duplicate) { skipped.push(intent); continue; }
      const alias = knownAlias(state, intent.name);
      const empty = draft.customers.find(isBlank);
      const target = found ?? { id: empty?.id ?? id(), customer: alias?.name ?? intent.name, items: [], ...(alias ? { partyId: alias.id } : {}) };
      const item = { ...emptyItem(id()), ...intent.line };
      const customer = { ...target, items: [...target.items.filter(line =>
        fields.some(field => field !== 'unit' && line[field].trim())), item] };
      notes.draft.seen.push({ key: JSON.stringify([customer.id, ...fields.map(field => intent.line[field])]), itemId: item.id });
      draft = draft.customers.some(entry => entry.id === customer.id) ? replaceCustomer(draft, customer)
        : { ...draft, customers: [...draft.customers, customer] };
      changes.push(`${customer.customer} · ${describeItem(item)}`);
    } else {
      if (!found) throw new Error(`未找到「${intent.name}」的草稿，请先录入或手动指定客户`);
      const matches = found.items.filter(item => (item.product === intent.product || (intent.kind === 'fill' && intent.product === '-'))
        && (intent.kind === 'fill' || item.unit === intent.unit));
      if (matches.length !== 1) throw new Error('未能唯一定位草稿明细，请展开手动编辑补充');
      const [item] = matches;
      if (intent.kind === 'quantity') {
        const before = Number(item.quantity);
        const requested = Number(intent.quantity);
        if (!numeric.test(item.quantity) || !Number.isSafeInteger(before + requested)) throw new Error('数量无法计算，请手动核对');
        if (notes.draft.quantities.some(entry => entry.itemId === item.id)) throw new Error('这条明细已有待确认的数量，请先处理上一条');
        notes.draft.quantities.push({ itemId: item.id, before: item.quantity, requested: intent.quantity, unit: item.unit, source: intent.source });
        changes.push(`${found.customer} · 已记录数量歧义`);
      } else {
        draft = replaceCustomer(draft, { ...found, items: found.items.map(line =>
          line.id === item.id ? { ...line, ...intent.fields } : line) });
        changes.push(`${found.customer} · 已补充${intent.product === '-' ? '明细' : intent.product}`);
      }
    }
  }
  return { draft, notes, skipped, changes };
}

export function describeItem(item: InputLine) {
  return [item.brand, item.product || '未命名货品', item.specification, item.quantity + item.unit].filter(Boolean).join(' ');
}

export function linePrice(state: TripState, customer: CustomerDraft, item: ItemInput) {
  if (!customer.partyId || ![item.product, item.brand, item.specification, item.unit].every(value => value.trim())) return null;
  const sources = state.trips.flatMap(trip => {
    const version = latest(trip);
    return version.customers.flatMap(sheet => {
      if (accountFor(state.ledger, { tripId: trip.id, sheetId: sheet.id })?.partyId !== customer.partyId) return [];
      return sheet.items.filter(line => pickingKey(line) === pickingKey(item)).map(line => ({
        price: line.price, day: localDay(new Date(trip.versions[0].savedAt)), source: sheet.id,
        time: Date.parse(trip.versions[0].savedAt), mock: false,
      }));
    });
  }).sort((a, b) => b.time - a.time);
  const first = sources[0];
  if (first) return sources.some(source => source.time === first.time && yuanToCents(source.price) !== yuanToCents(first.price)) ? null : first;
  if (customer.partyId === state.assistant?.demoPartyId
    && pickingKey(item) === JSON.stringify(['水饺', '安井', '500g', '箱'])) {
    return { price: '78', day: '2026-11-01', source: 'S4-A-1101', mock: true };
  }
  return null;
}

export function questions(state: TripState) {
  const notes = forDraft(state);
  return state.draft.customers.flatMap((customer, index) => {
    const name = customer.customer || `第 ${index + 1} 位客户`;
    const identity = customer.partyId === undefined;
    const entries = customer.items.map(item => {
      const missing = fields.slice(0, 4).filter(field => !item[field].trim()).map(field => labels[fields.indexOf(field)]);
      if (!numeric.test(item.quantity) || !Number.isSafeInteger(Number(item.quantity))) missing.push('数量');
      const cents = yuanToCents(item.price);
      const priceMissing = !Number.isSafeInteger(cents) || cents <= 0;
      const ready = fields.slice(0, 4).every(field => item[field].trim());
      const history = priceMissing && ready && !identity ? linePrice(state, customer, item) : null;
      if (priceMissing && ready && !identity && !history) missing.push('单价');
      const quantity = notes.draft.quantities.find(entry => entry.itemId === item.id) ?? null;
      return { id: item.id, label: describeItem(item), unit: item.unit, missing: missing.join('、'), history,
        historyLabel: history ? `${history.mock ? '模拟历史价' : '本地历史价'} ¥${money(yuanToCents(history.price))}/${item.unit} · ${history.day}` : '',
        priceMissing, quantity, quantityChanged: quantity !== null && (quantity.before !== item.quantity || quantity.unit !== item.unit),
        sum: quantity ? Number(quantity.before) + Number(quantity.requested) : 0 };
    });
    const lines = entries.filter(entry => entry.missing || entry.quantity || entry.history);
    return identity || !customer.customer || lines.length ? [{ id: customer.id, name, identity, lines }] : [];
  });
}

export function resolveQuantity(item: ItemInput, question: QuantityQuestion, choice: string): ItemInput {
  if (choice === 'keep') return item;
  if (question.before !== item.quantity || question.unit !== item.unit) throw new Error('该行数量或单位已编辑，请保留手动修改或重新发送');
  if (choice !== 'replace' && choice !== 'append') throw new Error('请选择一种数量');
  return { ...item, quantity: choice === 'replace' ? question.requested : String(Number(question.before) + Number(question.requested)) };
}

export interface OfficialTarget {
  id: string; tripId: string; sheetId: string; label: string; name: string; lineId: string | null; version: number; basis: string;
}

export function officialTargets(state: TripState, intent: Official): OfficialTarget[] {
  const alias = knownAlias(state, intent.name);
  const current = currentTrip(state);
  const candidates = [...state.trips].reverse().flatMap(trip => {
    const version = latest(trip);
    const day = localDay(new Date(trip.versions[0].savedAt));
    return version.customers.flatMap<OfficialTarget>(customer => {
      const sheet = { tripId: trip.id, sheetId: customer.id };
      const account = accountFor(state.ledger, sheet);
      if (alias ? account?.partyId !== alias.id : customer.customer !== intent.name) return [];
      const party = state.ledger.parties.findIndex(party => party.id === account?.partyId);
      const label = `${day} · ${customer.customer}${party >= 0 ? ` · 客户 ${party + 1}` : ''} · ${trip.id === current?.id ? '当前趟' : '历史单'}`;
      const summary = customer.items.map(describeItem).join('；');
      const basis = JSON.stringify([version.version, trip.statusRevision, account?.partyId, account?.reviewed]);
      return intent.kind === 'amend' ? customer.items.filter(item => item.product === intent.product && (!intent.unit || item.unit === intent.unit))
        .map(item => ({ ...sheet, id: item.id, label: `${label} · ${describeItem(item)}`, name: customer.customer, lineId: item.id, version: version.version, basis }))
        : [{ ...sheet, id: customer.id, label: `${label} · ${summary}`, name: customer.customer, lineId: null, version: version.version, basis }];
    });
  });
  const preferred = candidates.filter(candidate => candidate.tripId === current?.id);
  return preferred.length ? preferred : candidates;
}

