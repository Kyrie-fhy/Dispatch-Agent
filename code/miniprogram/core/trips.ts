import { emptyItem, isDraft, isObject, ItemInput, OrderLine, preview, readState as readS1 } from './orders';
import { Account, accountFor, checkOpening, emptyLedger, Ledger, localDay, OpeningPreview,
  parseAmount, Party, planReceipt, readLedger, Receipt, ReceiptPreview, settlementTotals, Sheet, sheetBalance, tripBalance } from './settlement';

export interface CustomerDraft { id: string; customer: string; items: ItemInput[]; partyId?: string | null }
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
export interface TripState { schemaVersion: 3; draft: TripDraft; trips: Trip[]; ledger: Ledger }
export interface TripStorage { read(): unknown; write(state: TripState): void }
export interface PickingLine { id: string; product: string; brand: string; specification: string; unit: string; quantity: number }
export interface PickingChange extends Omit<PickingLine, 'quantity'> { before: number; after: number }
export interface Amendment {
  id: string;
  tripId: string;
  version: number;
  statusRevision: number;
  accountBasis: string;
  customer: CustomerDraft;
  replacementStatuses?: Partial<Record<string, 'pending' | 'delivered'>>;
}
export interface DeliveryChange extends Sheet {
  version: number;
  lineId: string | null;
  status: 'pending' | 'delivered';
}
export interface DeliveryPreview {
  change: DeliveryChange;
  basis: string;
  reviewed: boolean;
  before: ReturnType<typeof sheetBalance>;
  after: ReturnType<typeof sheetBalance>;
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

export function pickingKey(item: ItemInput): string {
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
  const valid = value.every(customer => isObject(customer) && isDraft({ ...customer, revision: 0 })
    && (customer.partyId === undefined || customer.partyId === null || (typeof customer.partyId === 'string' && !!customer.partyId)));
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
  const trip = value as unknown as Trip;
  const lines = latest(trip).customers.flatMap(customer => customer.items);
  return unique(trip.versions.slice(1).map(version => version.amendmentId!))
    && Object.keys(trip.statuses).length === lines.length
    && lines.every(({ id }) => trip.statuses[id] === 'pending' || trip.statuses[id] === 'delivered'
      || (trip.origin === 's1' && trip.statuses[id] === 'unrecorded'));
}

function migrateS1(raw: unknown, id: () => string): TripState {
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
  return { schemaVersion: 3, draft, trips, ledger: emptyLedger() };
}

export class TripService {
  constructor(private storage: TripStorage, private id: () => string, private now: () => string) {}

  load(): TripState {
    const raw = this.storage.read();
    if (raw === undefined || raw === null || raw === '') return this.reset();
    if (isObject(raw) && raw.schemaVersion === 1) {
      const next = migrateS1(raw, this.id);
      this.storage.write(next);
      return next;
    }
    if (!isObject(raw) || (raw.schemaVersion !== 2 && raw.schemaVersion !== 3) || !isTripDraft(raw.draft)
      || !Array.isArray(raw.trips) || !raw.trips.every(isTrip) || !unique(raw.trips.map(trip => trip.id))) {
      throw new Error('本地配送数据无法读取，请保留数据并联系开发者');
    }
    const ledger = raw.schemaVersion === 2 ? emptyLedger() : readLedger(raw.ledger, raw.trips);
    const state: TripState = { schemaVersion: 3, draft: raw.draft, trips: raw.trips, ledger };
    if (raw.schemaVersion === 2) this.storage.write(state);
    return state;
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
    const choices = this.customerChoices(state);
    const trip: Trip = { id: draftId, origin: 's2', versions: [{ version: 1, customers, totalCents, savedAt: this.now() }],
      statuses: statusesFor(customers, 'pending'), statusRevision: 0 };
    const parties = [...state.ledger.parties];
    const accounts = [...state.ledger.accounts];
    choices.forEach((choice, index) => {
      const customer = customers[index];
      const party = choice ?? { id: this.id(), name: customer.customer };
      if (!choice) parties.push(party);
      accounts.push({ tripId: trip.id, sheetId: customer.id, partyId: party.id, reviewed: false });
    });
    this.write({ ...state, trips: [...state.trips, trip], ledger: { ...state.ledger, parties, accounts } });
    return trip;
  }

  previewDraft(draft: TripDraft) {
    const state = this.load();
    if (state.draft.id !== draft.id || state.draft.revision !== draft.revision) throw new Error('草稿已变化，请重新预览');
    const result = previewTrip(state.draft);
    const choices = this.customerChoices(state);
    return { ...result, choices };
  }

  startNext(): TripDraft {
    const state = this.load();
    if (currentTrip(state)?.id !== state.draft.id) throw new Error('请先完成当前草稿');
    const draft = emptyTrip(this.id);
    this.storage.write({ ...state, draft });
    return draft;
  }

  reset(): TripState {
    const state: TripState = { schemaVersion: 3, draft: emptyTrip(this.id), trips: [], ledger: emptyLedger() };
    this.storage.write(state);
    return state;
  }

  linkCustomer(sheet: Sheet, partyId: string | null): void {
    const state = this.load();
    const trip = this.requireTrip(state, sheet.tripId);
    const customer = this.requireCustomer(trip, sheet.sheetId);
    const prior = accountFor(state.ledger, sheet);
    if (prior) {
      if (prior.partyId === partyId || partyId === null) return;
      throw new Error('客户归属已确认，请重新打开单据');
    }
    const existing = partyId === null ? null : this.requireParty(state, partyId);
    if (state.ledger.accounts.some(account => account.tripId === trip.id && account.partyId === existing?.id)) {
      throw new Error('本趟已有该客户的单据，请核对客户归属');
    }
    const party = existing ?? { id: this.id(), name: customer.customer };
    const account: Account = { ...sheet, partyId: party.id, reviewed: false };
    const parties = existing ? state.ledger.parties : [...state.ledger.parties, party];
    this.write({ ...state, ledger: { ...state.ledger, parties, accounts: [...state.ledger.accounts, account] } });
  }

  reviewSheet(sheet: Sheet, version: number, statusRevision: number): void {
    const state = this.load();
    const trip = this.requireTrip(state, sheet.tripId);
    const customer = this.requireCustomer(trip, sheet.sheetId);
    const account = accountFor(state.ledger, sheet);
    if (!account) throw new Error('请先确认这张单的客户归属');
    if (latest(trip).version !== version || trip.statusRevision !== statusRevision) {
      throw new Error('配送状态已变化，请重新核对');
    }
    if (customer.items.some(item => trip.statuses[item.id] === 'unrecorded')) throw new Error('请先标记所有未记录的明细');
    if (account.reviewed) return;
    const accounts = state.ledger.accounts.map(entry => entry === account ? { ...entry, reviewed: true } : entry);
    this.write({ ...state, ledger: { ...state.ledger, accounts } });
  }

  previewOpening(sheet: Sheet, day: string, input: string, source: string): OpeningPreview {
    const state = this.load();
    const partyId = accountFor(state.ledger, sheet)?.partyId ?? '';
    const entry = { sheet, id: this.id(), partyId, day, cents: parseAmount(input, '旧欠款金额'), source: source.trim() };
    checkOpening(state, entry, localDay(new Date(this.now())));
    return entry;
  }

  confirmOpening(preview: OpeningPreview): void {
    const state = this.load();
    const { sheet, ...entry } = preview;
    const existing = state.ledger.opening.find(debt => debt.id === entry.id);
    if (existing) {
      if (existing.partyId !== entry.partyId || existing.day !== entry.day || existing.cents !== entry.cents || existing.source !== entry.source) {
        throw new Error('这笔旧欠款已保存，请重新预览');
      }
      return;
    }
    checkOpening(state, preview, localDay(new Date(this.now())));
    this.write({ ...state, ledger: { ...state.ledger, opening: [...state.ledger.opening, entry] } });
  }

  previewReceipt(sheet: Sheet, input: string): ReceiptPreview {
    return planReceipt(this.load(), sheet, parseAmount(input, '收款金额'), this.id());
  }

  confirmReceipt(preview: ReceiptPreview): Receipt {
    const state = this.load();
    const { id, sheet, cents, partyId } = preview;
    const allocations = preview.allocations.map(({ debtId, cents }) => ({ debtId, cents }));
    const existing = state.ledger.receipts.find(receipt => receipt.id === id);
    if (existing) {
      if (existing.partyId !== partyId || existing.cents !== cents || JSON.stringify(existing.allocations) !== JSON.stringify(allocations)) {
        throw new Error('这笔收款已保存，请重新预览');
      }
      return existing;
    }
    let current: ReceiptPreview;
    try { current = planReceipt(state, sheet, cents, id); }
    catch { throw new Error('客户账目已变化，请重新预览收款'); }
    if (current.partyId !== partyId || current.basis !== preview.basis || JSON.stringify(current.allocations) !== JSON.stringify(preview.allocations)) {
      throw new Error('客户账目已变化，请重新预览收款');
    }
    const receipt = { id, partyId, cents, allocations, savedAt: this.now() };
    this.write({ ...state, ledger: { ...state.ledger, receipts: [...state.ledger.receipts, receipt] } });
    return receipt;
  }

  setDelivery(tripId: string, version: number, customerId: string, lineId: string | null, status: 'pending' | 'delivered'): void {
    const state = this.load();
    const result = this.evaluateDelivery(state, { tripId, version, sheetId: customerId, lineId, status });
    if (result.preview.reviewed) throw new Error('请先核对配送和账目变化');
    if (result.changed) this.saveTrip(state, result.trip);
  }

  previewDelivery(change: DeliveryChange): DeliveryPreview {
    return this.evaluateDelivery(this.load(), change).preview;
  }

  confirmDelivery(preview: DeliveryPreview): void {
    const state = this.load();
    const result = this.evaluateDelivery(state, preview.change);
    if (!result.changed) return;
    if (result.preview.basis !== preview.basis) throw new Error('配送状态或账目已变化，请重新预览');
    this.saveTrip(state, result.trip);
  }

  private evaluateDelivery(state: TripState, change: DeliveryChange) {
    const trip = this.requireTrip(state, change.tripId);
    if (latest(trip).version !== change.version) throw new Error('正式单已变化，请重新打开单据');
    const customer = this.requireCustomer(trip, change.sheetId);
    const lines = change.lineId === null ? customer.items : customer.items.filter(item => item.id === change.lineId);
    if (!lines.length) throw new Error('货品明细已变化，请重新打开单据');
    const changed = lines.some(item => trip.statuses[item.id] !== change.status);
    const statuses = { ...trip.statuses, ...Object.fromEntries(lines.map(item => [item.id, change.status])) };
    const before = sheetBalance(state.ledger, trip, customer);
    const after = sheetBalance(state.ledger, trip, customer, statuses);
    const reviewed = accountFor(state.ledger, change)?.reviewed ?? false;
    const basis = JSON.stringify([change.tripId, change.sheetId, change.version, change.lineId, change.status,
      trip.statusRevision, this.accountBasis(state, trip, customer)]);
    return { changed, trip: { ...trip, statuses, statusRevision: trip.statusRevision + 1 },
      preview: { change, basis, reviewed, before, after } };
  }

  startAmendment(tripId: string, customerId: string): Amendment {
    const state = this.load();
    const trip = this.requireTrip(state, tripId);
    const customer = this.requireCustomer(trip, customerId);
    return { id: this.id(), tripId, version: latest(trip).version, statusRevision: trip.statusRevision,
      accountBasis: this.accountBasis(state, trip, customer),
      customer: { id: customer.id, customer: customer.customer, items: customer.items.map(item => ({ ...item })) } };
  }

  previewAmendment(amendment: Amendment) {
    const state = this.load();
    return this.evaluateAmendment(state, this.requireTrip(state, amendment.tripId), amendment);
  }

  confirmAmendment(amendment: Amendment): TripVersion {
    const state = this.load();
    const existing = state.trips.find(trip => trip.id === amendment.tripId)?.versions.find(version => version.amendmentId === amendment.id);
    if (existing) return existing;
    const trip = this.requireTrip(state, amendment.tripId);
    const { customers, statuses, totalCents } = this.evaluateAmendment(state, trip, amendment);
    const version = { version: amendment.version + 1, customers, totalCents, savedAt: this.now(), amendmentId: amendment.id };
    this.saveTrip(state, { ...trip, versions: [...trip.versions, version], statuses });
    return version;
  }

  private evaluateAmendment(state: TripState, trip: Trip, amendment: Amendment) {
    const previous = latest(trip);
    if (previous.version !== amendment.version || trip.statusRevision !== amendment.statusRevision) {
      throw new Error('正式单或配送状态已变化，请核对最新数据后重新预览');
    }
    const original = this.requireCustomer(trip, amendment.customer.id);
    if (this.accountBasis(state, trip, original) !== amendment.accountBasis) throw new Error('客户账目已变化，请重新预览');
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
      if (sameProduct && oldLine.quantity === newLine.quantity && oldLine.price === newLine.price) continue;
      let afterStatus: DeliveryStatus | undefined;
      if (newLine) {
        afterStatus = sameProduct ? beforeStatus : 'pending';
        if (!sameProduct && beforeStatus === 'delivered') {
          const selected = amendment.replacementStatuses?.[id];
          if (selected !== 'delivered' && selected !== 'pending') throw new Error('请确认替换货品的配送状态');
          afterStatus = selected;
        }
      }
      changes.push({ id, before: oldLine, after: newLine, beforeStatus, afterStatus });
    }
    if (!changes.length) throw new Error('请先修改明细');
    const updated = new Map(changes.map(change => [change.id, change.afterStatus]));
    const statuses = Object.fromEntries(customers.flatMap(customer => customer.items.map(({ id }) => [id, updated.get(id) ?? trip.statuses[id]])));
    return { customers, customer: corrected, original, changes, statuses, totalCents: sumOrders(customers),
      before: sheetBalance(state.ledger, trip, original), after: sheetBalance(state.ledger, trip, corrected, statuses),
      unchecked: corrected.items.filter(item => statuses[item.id] !== 'delivered'),
      picking: pickingChanges(previous.customers, customers) };
  }

  private requireTrip(state: TripState, id: string): Trip {
    const trip = state.trips.find(entry => entry.id === id);
    if (!trip) throw new Error('未找到该配送趟，请重新打开');
    return trip;
  }

  private requireCustomer(trip: Trip, id: string): CustomerOrder {
    const customer = latest(trip).customers.find(order => order.id === id);
    if (!customer) throw new Error('未找到该客户单据，请重新打开');
    return customer;
  }

  private requireParty(state: TripState, id: string): Party {
    const party = state.ledger.parties.find(entry => entry.id === id);
    if (!party) throw new Error('未找到所选客户，请重新选择');
    return party;
  }

  private customerChoices(state: TripState): (Party | null)[] {
    const selected = new Set<string>();
    return state.draft.customers.map((customer, index) => {
      if (customer.partyId === undefined) throw new Error(`请为第 ${index + 1} 位客户选择已有客户或新建`);
      if (customer.partyId === null) return null;
      const party = this.requireParty(state, customer.partyId);
      if (selected.has(party.id)) throw new Error('本趟已选择该客户，请回到该客户单添加货品');
      if (party.name !== customer.customer.trim()) throw new Error('客户名称已变化，请重新选择客户');
      selected.add(party.id);
      return party;
    });
  }

  private accountBasis(state: TripState, trip: Trip, customer: CustomerOrder): string {
    const account = accountFor(state.ledger, { tripId: trip.id, sheetId: customer.id });
    return JSON.stringify([account?.partyId, account?.reviewed, sheetBalance(state.ledger, trip, customer).paid]);
  }

  private write(state: TripState): void {
    const totals = settlementTotals(state);
    for (const trip of state.trips) tripBalance(state, trip, totals);
    this.storage.write(state);
  }

  private saveTrip(state: TripState, trip: Trip): void {
    this.write({ ...state, trips: state.trips.map(existing => existing.id === trip.id ? trip : existing) });
  }
}
