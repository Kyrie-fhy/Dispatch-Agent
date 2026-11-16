import { emptyItem, isDraft, isObject, ItemInput, OrderLine, preview, readState as readS1 } from './orders';

export interface CustomerDraft { id: string; customer: string; items: ItemInput[] }
export interface TripDraft { id: string; revision: number; customers: CustomerDraft[] }
export interface CustomerOrder extends CustomerDraft { items: OrderLine[]; totalCents: number }
export interface TripVersion {
  version: number;
  customers: CustomerOrder[];
  totalCents: number;
  savedAt: string;
  amendmentId?: string;
}
export type DeliveryStatus = 'pending' | 'delivered' | 'unrecorded';
export interface Trip {
  id: string;
  origin: 's1' | 's2';
  versions: TripVersion[];
  statuses: Record<string, DeliveryStatus>;
  statusRevision: number;
}
export interface TripState { schemaVersion: 2; draft: TripDraft; trips: Trip[] }
export interface TripStorage { read(): unknown; write(state: TripState): void }
export interface PickingLine { id: string; product: string; brand: string; specification: string; unit: string; quantity: number }
export interface PickingChange extends Omit<PickingLine, 'quantity'> { before: number; after: number }
export interface Amendment {
  id: string;
  tripId: string;
  version: number;
  statusRevision: number;
  customer: CustomerDraft;
}
export interface LineChange {
  id: string;
  before?: OrderLine;
  after?: OrderLine;
  beforeStatus?: DeliveryStatus;
  afterStatus?: DeliveryStatus;
}

export function emptyCustomer(id: () => string): CustomerDraft {
  return { id: id(), customer: '', items: [emptyItem(id())] };
}

export function emptyTrip(id: () => string): TripDraft {
  return { id: id(), revision: 0, customers: [emptyCustomer(id)] };
}

export function latest(trip: Trip): TripVersion {
  return trip.versions[trip.versions.length - 1];
}

export function currentTrip(state: TripState): Trip | undefined {
  const last = state.trips[state.trips.length - 1];
  return last?.origin === 's2' ? last : undefined;
}

function customerOrder(customer: CustomerDraft): CustomerOrder {
  const order = preview({ ...customer, revision: 0 });
  return { id: customer.id, customer: order.customer, items: order.items, totalCents: order.totalCents };
}

function sumOrders(customers: CustomerOrder[]): number {
  const total = customers.reduce((sum, customer) => sum + customer.totalCents, 0);
  if (!Number.isSafeInteger(total)) throw new Error('整趟订单金额超出可计算范围');
  return total;
}

export function previewTrip(draft: TripDraft): Pick<TripVersion, 'customers' | 'totalCents'> {
  const customers = draft.customers.map((customer, index) => {
    try {
      return customerOrder(customer);
    } catch (error) {
      const name = customer.customer.trim();
      const detail = error instanceof Error ? error.message : '请检查明细';
      throw new Error(`第 ${index + 1} 位客户${name ? `（${name}）` : ''}：${detail}`);
    }
  });
  return { customers, totalCents: sumOrders(customers) };
}

const pickingFields = ['product', 'brand', 'specification', 'unit'] as const;

function pickingKey(item: ItemInput): string {
  return JSON.stringify(pickingFields.map(field => item[field].trim()));
}

export function pickingList(customers: CustomerOrder[]): PickingLine[] {
  const entries = new Map<string, PickingLine>();
  for (const { items } of customers) {
    for (const item of items) {
      const id = pickingKey(item);
      const { product, brand, specification, unit } = item;
      const quantity = (entries.get(id)?.quantity ?? 0) + Number(item.quantity);
      entries.set(id, { id, product, brand, specification, unit, quantity });
    }
  }
  return [...entries.values()];
}

export function pickingChanges(before: CustomerOrder[], after: CustomerOrder[]): PickingChange[] {
  const oldRows = new Map(pickingList(before).map(row => [row.id, row]));
  const newRows = new Map(pickingList(after).map(row => [row.id, row]));
  const rows = new Map([...oldRows, ...newRows]);
  return [...rows.values()].flatMap(({ id, product, brand, specification, unit }) => {
    const before = oldRows.get(id)?.quantity ?? 0;
    const after = newRows.get(id)?.quantity ?? 0;
    return before === after ? [] : [{ id, product, brand, specification, unit, before, after }];
  });
}

function statusesFor(customers: CustomerOrder[], status: DeliveryStatus): Trip['statuses'] {
  return Object.fromEntries(customers.flatMap(customer => customer.items.map(item => [item.id, status])));
}

function unique(ids: string[]): boolean {
  return ids.length === new Set(ids).size;
}

function isCustomers(value: unknown): value is CustomerDraft[] {
  if (!Array.isArray(value) || !value.length) return false;
  const valid = value.every(customer => isObject(customer) && isDraft({ ...customer, revision: 0 }));
  return valid && unique(value.map(customer => customer.id)) && unique(value.flatMap(customer => customer.items.map((item: ItemInput) => item.id)));
}

function isTripDraft(value: unknown): value is TripDraft {
  return isObject(value) && typeof value.id === 'string' && !!value.id
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && isCustomers(value.customers);
}

function isVersion(value: unknown, index: number): value is TripVersion {
  if (!isObject(value) || value.version !== index + 1 || typeof value.savedAt !== 'string'
    || !Number.isFinite(Date.parse(value.savedAt)) || !isCustomers(value.customers)) return false;
  if (index === 0 ? value.amendmentId !== undefined : typeof value.amendmentId !== 'string' || !value.amendmentId) return false;
  const customers = value.customers as CustomerOrder[];
  try {
    const checked = customers.map(customerOrder);
    return value.totalCents === sumOrders(checked) && checked.every((expected, position) => {
      const actual = customers[position];
      return actual.totalCents === expected.totalCents && expected.items.every((item, line) => item.amountCents === actual.items[line].amountCents);
    });
  } catch {
    return false;
  }
}

function isTrip(value: unknown): value is Trip {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id || !Array.isArray(value.versions)
    || !value.versions.length || !value.versions.every(isVersion) || !isObject(value.statuses)
    || !Number.isSafeInteger(value.statusRevision) || Number(value.statusRevision) < 0) return false;
  if (value.origin !== 's1' && value.origin !== 's2') return false;
  if (value.origin === 's1' && (value.versions.length !== 1 || value.statusRevision !== 0)) return false;
  const trip = value as unknown as Trip;
  const lines = latest(trip).customers.flatMap(customer => customer.items);
  return unique(trip.versions.slice(1).map(version => version.amendmentId!))
    && Object.keys(trip.statuses).length === lines.length
    && lines.every(({ id }) => trip.origin === 's1' ? trip.statuses[id] === 'unrecorded' : ['pending', 'delivered'].includes(trip.statuses[id]));
}

function migrate(raw: unknown, id: () => string): TripState {
  const previous = readS1(raw, 'migration');
  const trips: Trip[] = previous.orders.map(order => {
    const { id, customer, items, totalCents, confirmedAt } = order;
    const customers = [{ id, customer, items, totalCents }];
    return { id, origin: 's1', versions: [{ version: 1, customers, totalCents, savedAt: confirmedAt }],
      statuses: statusesFor(customers, 'unrecorded'), statusRevision: 0 };
  });
  const previousDraft = previous.draft;
  const draft = trips.some(trip => trip.id === previousDraft.id) ? emptyTrip(id) : {
    id: previousDraft.id, revision: previousDraft.revision,
    customers: [{ id: id(), customer: previousDraft.customer, items: previousDraft.items }],
  };
  return { schemaVersion: 2, draft, trips };
}

export class TripService {
  constructor(private storage: TripStorage, private id: () => string, private now: () => string) {}

  load(): TripState {
    const raw = this.storage.read();
    if (raw === undefined || raw === null || raw === '') return this.reset();
    if (isObject(raw) && raw.schemaVersion === 1) {
      const next = migrate(raw, this.id);
      this.storage.write(next);
      return next;
    }
    if (!isObject(raw) || raw.schemaVersion !== 2 || !isTripDraft(raw.draft)
      || !Array.isArray(raw.trips) || !raw.trips.every(isTrip) || !unique(raw.trips.map(trip => trip.id))) {
      throw new Error('本地配送数据无法读取，请保留数据并联系开发者');
    }
    return { schemaVersion: 2, draft: raw.draft, trips: raw.trips };
  }

  saveDraft(draft: TripDraft): TripDraft {
    const state = this.load();
    if (state.draft.id !== draft.id || state.draft.revision !== draft.revision) throw new Error('草稿已更新，请重新打开后编辑');
    if (state.trips.some(trip => trip.id === draft.id)) throw new Error('这趟已确认，请开始下一趟');
    if (!isTripDraft(draft)) throw new Error('草稿格式不正确');
    const saved = { ...draft, revision: draft.revision + 1 };
    this.storage.write({ ...state, draft: saved });
    return saved;
  }

  confirm(draftId: string, revision: number): Trip {
    const state = this.load();
    const existing = state.trips.find(trip => trip.id === draftId && trip.origin === 's2');
    if (existing) return existing;
    if (state.draft.id !== draftId || state.draft.revision !== revision) throw new Error('草稿已变化，请重新预览');
    const { customers, totalCents } = previewTrip(state.draft);
    const trip: Trip = { id: draftId, origin: 's2', versions: [{ version: 1, customers, totalCents, savedAt: this.now() }],
      statuses: statusesFor(customers, 'pending'), statusRevision: 0 };
    this.storage.write({ ...state, trips: [...state.trips, trip] });
    return trip;
  }

  startNext(): TripDraft {
    const state = this.load();
    if (currentTrip(state)?.id !== state.draft.id) throw new Error('请先完成当前草稿');
    const draft = emptyTrip(this.id);
    this.storage.write({ ...state, draft });
    return draft;
  }

  reset(): TripState {
    const state: TripState = { schemaVersion: 2, draft: emptyTrip(this.id), trips: [] };
    this.storage.write(state);
    return state;
  }

  setDelivery(tripId: string, version: number, customerId: string, lineId: string | null, status: 'pending' | 'delivered'): void {
    const state = this.load();
    const trip = this.requireCurrent(state, tripId);
    if (latest(trip).version !== version) throw new Error('正式单已变化，请重新打开单据');
    const customer = this.requireCustomer(trip, customerId);
    const lines = lineId === null ? customer.items : customer.items.filter(item => item.id === lineId);
    if (!lines.length) throw new Error('货品明细已变化，请重新打开单据');
    if (lines.every(item => trip.statuses[item.id] === status)) return;
    const statuses = { ...trip.statuses, ...Object.fromEntries(lines.map(item => [item.id, status])) };
    this.saveTrip(state, { ...trip, statuses, statusRevision: trip.statusRevision + 1 });
  }

  startAmendment(tripId: string, customerId: string): Amendment {
    const trip = this.requireCurrent(this.load(), tripId);
    const customer = this.requireCustomer(trip, customerId);
    return { id: this.id(), tripId, version: latest(trip).version, statusRevision: trip.statusRevision,
      customer: { id: customer.id, customer: customer.customer, items: customer.items } };
  }

  previewAmendment(amendment: Amendment) {
    return this.evaluateAmendment(this.requireCurrent(this.load(), amendment.tripId), amendment);
  }

  confirmAmendment(amendment: Amendment): TripVersion {
    const state = this.load();
    const existing = state.trips.find(trip => trip.id === amendment.tripId)?.versions.find(version => version.amendmentId === amendment.id);
    if (existing) return existing;
    const trip = this.requireCurrent(state, amendment.tripId);
    const { customers, changes, totalCents } = this.evaluateAmendment(trip, amendment);
    const version = { version: amendment.version + 1, customers, totalCents, savedAt: this.now(), amendmentId: amendment.id };
    const updated = new Map(changes.map(change => [change.id, change.afterStatus]));
    const statuses = Object.fromEntries(customers.flatMap(customer => customer.items.map(({ id }) => [id, updated.get(id) ?? trip.statuses[id]])));
    this.saveTrip(state, { ...trip, versions: [...trip.versions, version], statuses });
    return version;
  }

  private evaluateAmendment(trip: Trip, amendment: Amendment) {
    const previous = latest(trip);
    if (previous.version !== amendment.version || trip.statusRevision !== amendment.statusRevision) {
      throw new Error('正式单或配送状态已变化，请核对最新数据后重新预览');
    }
    const original = this.requireCustomer(trip, amendment.customer.id);
    const corrected = customerOrder({ ...amendment.customer, customer: original.customer });
    const customers = previous.customers.map(customer => customer.id === corrected.id ? corrected : customer);
    if (!isCustomers(customers)) throw new Error('更正后的明细标识重复或不完整');
    const before = new Map(original.items.map(item => [item.id, item]));
    const after = new Map(corrected.items.map(item => [item.id, item]));
    const changes: LineChange[] = [];
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const oldLine = before.get(id);
      const newLine = after.get(id);
      const beforeStatus = oldLine ? trip.statuses[id] : undefined;
      const sameProduct = oldLine && newLine && pickingKey(oldLine) === pickingKey(newLine);
      if (beforeStatus === 'delivered' && !sameProduct) throw new Error('已送达明细暂不支持换货或移除');
      if (sameProduct && oldLine.quantity === newLine.quantity && oldLine.price === newLine.price) continue;
      const afterStatus = newLine ? (sameProduct ? beforeStatus : 'pending') : undefined;
      changes.push({ id, before: oldLine, after: newLine, beforeStatus, afterStatus });
    }
    if (!changes.length) throw new Error('请先修改明细');
    return { customers, customer: corrected, original, changes, totalCents: sumOrders(customers),
      picking: pickingChanges(previous.customers, customers) };
  }

  private requireCurrent(state: TripState, id: string): Trip {
    const trip = currentTrip(state);
    if (!trip || trip.id !== id) throw new Error('此单已不在当前配送趟，请打开当前单据');
    return trip;
  }

  private requireCustomer(trip: Trip, id: string): CustomerOrder {
    const customer = latest(trip).customers.find(order => order.id === id);
    if (!customer) throw new Error('未找到该客户单据，请重新打开');
    return customer;
  }

  private saveTrip(state: TripState, trip: Trip): void {
    this.storage.write({ ...state, trips: state.trips.map(existing => existing.id === trip.id ? trip : existing) });
  }
}
