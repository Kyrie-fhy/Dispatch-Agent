export interface ItemInput {
  id: string; product: string; brand: string; specification: string;
  unit: string; quantity: string; price: string | null;
}
export interface Draft { id: string; revision: number; customer: string; items: ItemInput[] }
export interface OrderLine extends ItemInput { amountCents: number | null; unitPriceCents?: number | null }
export interface Order {
  id: string; revision: number; customer: string; items: OrderLine[];
  totalCents: number; confirmedAt: string;
}
export interface State { schemaVersion: 1; draft: Draft; orders: Order[] }
export interface StoragePort { read(): unknown; write(state: State): void }
export function emptyItem(id: string): ItemInput {
  return { id, product: '', brand: '', specification: '', unit: '箱', quantity: '', price: '' };
}
export function initialState(id: string): State {
  return { schemaVersion: 1, draft: { id, revision: 0, customer: '', items: [emptyItem(`${id}-1`)] }, orders: [] };
}
export function money(cents: number): string {
  const absolute = Math.abs(cents);
  const fraction = absolute % 100;
  return `${cents < 0 ? '-' : ''}${(absolute - fraction) / 100}.${String(fraction).padStart(2, '0')}`;
}
export function yuanToCents(input: string | null): number {
  if (input === null) return NaN;
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(input)) return NaN;
  const [yuan, fraction = ''] = input.split('.');
  return Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
}
export function nullablePrice(price: string | null): string | null {
  return price?.trim() || null;
}

export function validTextPrice(value: string): boolean {
  const cents = yuanToCents(value);
  return Number.isSafeInteger(cents) && cents > 0;
}

export function unitPrice(price: string | null): number | null {
  const input = nullablePrice(price);
  if (input === null) return null;
  const cents = yuanToCents(input);
  if (!validTextPrice(input)) throw new Error('单价须为大于零且最多两位小数的金额');
  return cents;
}

export function lineAmount(quantity: number, cents: number | null): number | null {
  if (quantity === 0) return 0;
  if (cents === null) return null;
  const amount = quantity * cents;
  if (!Number.isSafeInteger(amount)) throw new Error('明细金额超出可计算范围');
  return amount;
}

export function requiredLineFields(item: ItemInput, flexible: boolean) {
  return ([['product', '货品'], ['brand', '品牌'], ['specification', '规格'], ['unit', '单位']] as const)
    .filter(([key]) => !(flexible && (key === 'brand' || key === 'specification')) && !item[key]?.trim());
}

export function quantityIssue(value: string): string | undefined {
  if (!/^[1-9]\d*$/.test(value)) return '数量须为正整数';
  if (!Number.isSafeInteger(Number(value))) return '数量超出可计算范围';
}

export function preview(draft: Draft, flexible = false): Order {
  if (!draft.customer.trim()) throw new Error('请填写客户名称');
  if (draft.items.length === 0) throw new Error('请至少添加一条货品');
  const items = draft.items.map((item, index) => {
    const [missing] = requiredLineFields(item, flexible);
    if (missing) throw new Error(`第 ${index + 1} 条：请填写${missing[1]}`);
    const quantity = Number(item.quantity);
    const issue = quantityIssue(item.quantity);
    if (issue) throw new Error(`第 ${index + 1} 条：${issue}`);
    if (flexible) {
      const price = nullablePrice(item.price);
      try {
        const unitPriceCents = unitPrice(price);
        return { ...item, product: item.product.trim(), brand: item.brand?.trim() || '',
          specification: item.specification?.trim() || '', unit: item.unit.trim(), price, unitPriceCents,
          amountCents: lineAmount(quantity, unitPriceCents) };
      } catch (error) {
        throw new Error(`第 ${index + 1} 条：${(error as Error).message}`);
      }
    }
    const cents = yuanToCents(item.price);
    if (Number.isNaN(cents)) throw new Error(`第 ${index + 1} 条：单价须为最多两位小数的金额`);
    const amountCents = cents * quantity;
    if (cents <= 0 || !Number.isSafeInteger(cents) || !Number.isSafeInteger(amountCents)) {
      throw new Error(`第 ${index + 1} 条：单价须大于零，金额和数量不能超出可计算范围`);
    }
    return { ...item, product: item.product.trim(), brand: item.brand.trim(), specification: item.specification.trim(), unit: item.unit.trim(), amountCents };
  });
  const totalCents = items.reduce((total, item) => total + (item.amountCents ?? 0), 0);
  if (!Number.isSafeInteger(totalCents)) throw new Error('订单总额超出可计算范围');
  return { id: draft.id, revision: draft.revision, customer: draft.customer.trim(), items, totalCents, confirmedAt: '' };
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isDraft(value: unknown): value is Draft {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id || typeof value.customer !== 'string' || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.items) || !value.items.length) return false;
  const keys = ['id', 'product', 'brand', 'specification', 'unit', 'quantity'];
  return value.items.every(item => isObject(item) && keys.every(key => typeof item[key] === 'string') && (item.price === null || typeof item.price === 'string') && !!item.id)
    && new Set(value.items.map(item => item.id)).size === value.items.length;
}
export function readState(raw: unknown, newId: string): State {
  if (raw === undefined || raw === null || raw === '') return initialState(newId);
  if (!isObject(raw) || raw.schemaVersion !== 1 || !isDraft(raw.draft) || !Array.isArray(raw.orders)) throw new Error('本地数据格式无法读取，请保留数据并联系开发者');
  for (const order of raw.orders) {
    if (!isDraft(order) || !isObject(order) || typeof order.confirmedAt !== 'string' || !order.confirmedAt || !Number.isFinite(Date.parse(order.confirmedAt))) throw new Error('正式单据数据无法读取，请保留数据并联系开发者');
    const calculated = preview(order);
    if (calculated.totalCents !== order.totalCents || order.items.some((item, index) => (item as OrderLine).amountCents !== calculated.items[index].amountCents)) throw new Error('单据金额校验失败，请保留数据并联系开发者');
  }
  if (new Set(raw.orders.map(order => order.id)).size !== raw.orders.length) throw new Error('单据标识重复，请联系开发者');
  return JSON.parse(JSON.stringify(raw)) as State;
}
export class OrderService {
  constructor(private storage: StoragePort, private id: () => string, private now: () => string) {}
  load(): State {
    const raw = this.storage.read();
    const state = readState(raw, this.id());
    if (raw === undefined || raw === null || raw === '') this.storage.write(state);
    return state;
  }
  save(draft: Draft): State {
    const state = this.load();
    if (state.draft.id !== draft.id || state.draft.revision !== draft.revision) throw new Error('草稿已更新，请重新打开后编辑');
    if (state.orders.some(order => order.id === draft.id)) throw new Error('这张单已确认，请开始下一张草稿');
    if (!isDraft(draft)) throw new Error('草稿格式不正确');
    const next: State = { ...state, draft: { ...draft, revision: draft.revision + 1 } };
    this.storage.write(next);
    return next;
  }
  confirm(draftId: string, revision: number): Order {
    const state = this.load();
    const existing = state.orders.find(order => order.id === draftId);
    if (existing) return existing;
    if (state.draft.id !== draftId || state.draft.revision !== revision) throw new Error('草稿已变化，请重新预览');
    const order = { ...preview(state.draft), confirmedAt: this.now() };
    this.storage.write({ ...state, orders: [...state.orders, order] });
    return order;
  }
  startNext(): State {
    const state = this.load();
    if (!state.orders.some(order => order.id === state.draft.id)) throw new Error('请先完成当前草稿');
    const next = { ...state, draft: initialState(this.id()).draft };
    this.storage.write(next);
    return next;
  }
  reset(): State {
    const state = initialState(this.id());
    this.storage.write(state);
    return state;
  }
}
