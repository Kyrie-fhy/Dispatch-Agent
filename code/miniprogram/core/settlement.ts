import { isObject, money, yuanToCents } from './orders';
import type { CustomerOrder, DeliveryStatus, Trip, TripState } from './trips';

export interface Party { id: string; name: string }
export interface Sheet { tripId: string; sheetId: string }
export interface Account extends Sheet { partyId: string; reviewed: boolean }
export interface OpeningDebt { id: string; partyId: string; day: string; cents: number; source: string }
export interface Allocation { debtId: string; cents: number }
export interface Receipt { id: string; partyId: string; cents: number; savedAt: string; allocations: Allocation[] }
export interface Ledger {
  parties: Party[];
  accounts: Account[];
  opening: OpeningDebt[];
  receipts: Receipt[];
}
export interface OpeningPreview extends OpeningDebt { sheet: Sheet }
export interface ReceiptPreview {
  id: string;
  sheet: Sheet;
  partyId: string;
  cents: number;
  basis: string;
  allocations: (Allocation & { label: string; remaining: number })[];
}

interface Debt {
  id: string;
  day: string;
  time: number | null;
  label: string;
  cents: number;
  sheet?: Sheet;
  revision?: string;
}

export function emptyLedger(): Ledger {
  return { parties: [], accounts: [], opening: [], receipts: [] };
}

export function localDay(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((value, index) => String(value).padStart(index ? 2 : 4, '0')).join('-');
}

function validDay(day: string): boolean {
  const date = new Date(day + 'T00:00:00Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function positiveCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function parseAmount(input: string, label: string): number {
  const cents = yuanToCents(input.trim());
  if (Number.isNaN(cents)) throw new Error(`${label}须为最多两位小数的金额`);
  if (!positiveCents(cents)) throw new Error(`${label}须大于零且在可计算范围内`);
  return cents;
}

export function sumCents(amounts: number[]): number {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(total)) throw new Error('账目金额超出可计算范围');
  return total;
}

export function orderDebtId({ tripId, sheetId }: Sheet): string {
  return 'order:' + JSON.stringify([tripId, sheetId]);
}

function openingDebtId(id: string): string { return 'opening:' + id; }

export function accountFor(ledger: Ledger, { tripId, sheetId }: Sheet): Account | undefined {
  return ledger.accounts.find(account => account.tripId === tripId && account.sheetId === sheetId);
}

function allocatedAmounts(ledger: Ledger): Map<string, number> {
  const paid = new Map<string, number>();
  for (const receipt of ledger.receipts) {
    for (const { debtId, cents } of receipt.allocations) {
      paid.set(debtId, sumCents([paid.get(debtId) ?? 0, cents]));
    }
  }
  return paid;
}

function balance(due: number, paid: number) {
  return { due, paid, remaining: Math.max(due - paid, 0), excess: Math.max(paid - due, 0) };
}

function deliveredAmount(customer: CustomerOrder, statuses: Record<string, DeliveryStatus>): number {
  return sumCents(customer.items.filter(item => statuses[item.id] === 'delivered').map(item => item.amountCents));
}

export function sheetBalance(ledger: Ledger, trip: Trip, customer: CustomerOrder, statuses: Record<string, DeliveryStatus> = trip.statuses) {
  const id = orderDebtId({ tripId: trip.id, sheetId: customer.id });
  return balance(deliveredAmount(customer, statuses), allocatedAmounts(ledger).get(id) ?? 0);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function customerDebts(state: TripState, partyId: string) {
  const paid = allocatedAmounts(state.ledger);
  const trips = new Map(state.trips.map(trip => [trip.id, trip]));
  const debts: Debt[] = state.ledger.opening.filter(entry => entry.partyId === partyId)
    .map(entry => ({ id: openingDebtId(entry.id), day: entry.day, cents: entry.cents, time: null,
      label: `${entry.day} 旧欠款${entry.source ? ' · ' + entry.source : ''}` }));
  for (const account of state.ledger.accounts) {
    if (account.partyId !== partyId || !account.reviewed) continue;
    const trip = trips.get(account.tripId)!;
    const version = trip.versions[trip.versions.length - 1];
    const order = version.customers.find(entry => entry.id === account.sheetId)!;
    const time = Date.parse(trip.versions[0].savedAt);
    const day = localDay(new Date(time));
    debts.push({ id: orderDebtId(account), day, time, cents: deliveredAmount(order, trip.statuses),
      label: `${day} ${order.customer} · ${order.id}`, sheet: { tripId: account.tripId, sheetId: account.sheetId },
      revision: `${version.version}:${trip.statusRevision}` });
  }
  return debts.sort((a, b) => compareText(a.day, b.day)
    || (a.time ?? Number.MAX_SAFE_INTEGER) - (b.time ?? Number.MAX_SAFE_INTEGER) || compareText(a.id, b.id))
    .map(debt => ({ ...debt, ...balance(debt.cents, paid.get(debt.id) ?? 0) }));
}

export function settlementTotals(state: TripState) {
  const accounts = new Map(state.ledger.accounts.map(account => [orderDebtId(account), account]));
  const paid = allocatedAmounts(state.ledger);
  const remaining = new Map<string, number>();
  function addRemaining(partyId: string, cents: number) {
    remaining.set(partyId, sumCents([remaining.get(partyId) ?? 0, cents]));
  }
  for (const entry of state.ledger.opening) {
    addRemaining(entry.partyId, entry.cents - (paid.get(openingDebtId(entry.id)) ?? 0));
  }
  const sheets = new Map<string, ReturnType<typeof balance> & { account?: Account }>();
  for (const trip of state.trips) {
    for (const customer of trip.versions[trip.versions.length - 1].customers) {
      const id = orderDebtId({ tripId: trip.id, sheetId: customer.id });
      const account = accounts.get(id);
      const amounts = balance(deliveredAmount(customer, trip.statuses), paid.get(id) ?? 0);
      sheets.set(id, { ...amounts, account });
      if (account?.reviewed) addRemaining(account.partyId, amounts.remaining);
    }
  }
  return { sheets, remaining };
}

export function tripBalance(state: TripState, trip: Trip, totals = settlementTotals(state)) {
  const customers = trip.versions[trip.versions.length - 1].customers;
  const sheets = customers.map(customer => totals.sheets.get(orderDebtId({ tripId: trip.id, sheetId: customer.id }))!);
  const reviewed = sheets.filter(sheet => sheet.account?.reviewed);
  const historical = new Map<string, number>();
  for (const sheet of sheets) {
    if (!sheet.account) continue;
    const { partyId, reviewed } = sheet.account;
    const remaining = historical.get(partyId) ?? totals.remaining.get(partyId) ?? 0;
    historical.set(partyId, remaining - (reviewed ? sheet.remaining : 0));
  }
  return { due: sumCents(reviewed.map(sheet => sheet.due)), paid: sumCents(reviewed.map(sheet => sheet.paid)),
    remaining: sumCents(reviewed.map(sheet => sheet.remaining)), excess: sumCents(reviewed.map(sheet => sheet.excess)),
    unchecked: sumCents(sheets.filter(sheet => !sheet.account?.reviewed).map(sheet => sheet.due)),
    historical: sumCents([...historical.values()]), reviewed: reviewed.length, count: customers.length };
}

export function requireAccount(ledger: Ledger, sheet: Sheet): Account {
  const account = accountFor(ledger, sheet);
  if (!account) throw new Error('请先确认这张单的客户归属');
  return account;
}

export function planReceipt(state: TripState, sheet: Sheet, cents: number, id: string): ReceiptPreview {
  const account = requireAccount(state.ledger, sheet);
  if (!account.reviewed) throw new Error('请先确认对账');
  if (!positiveCents(cents)) throw new Error('收款金额须大于零且在可计算范围内');
  const debts = customerDebts(state, account.partyId);
  const available = sumCents(debts.map(debt => debt.remaining));
  if (cents > available) throw new Error(`当前最多可抵扣 ¥${money(available)}，请核对收款金额`);
  let left = cents;
  const allocations: ReceiptPreview['allocations'] = [];
  for (const debt of debts) {
    if (!left) break;
    const applied = Math.min(debt.remaining, left);
    if (!applied) continue;
    allocations.push({ debtId: debt.id, label: debt.label, cents: applied, remaining: debt.remaining - applied });
    left -= applied;
  }
  const basis = JSON.stringify(debts.map(debt => [debt.id, debt.time, debt.day, debt.revision, debt.cents, debt.paid]));
  return { id, sheet, partyId: account.partyId, cents, basis, allocations };
}

export function checkOpening(state: TripState, entry: OpeningPreview, today: string): void {
  const account = requireAccount(state.ledger, entry.sheet);
  if (account.partyId !== entry.partyId) throw new Error('客户归属已变化，请重新预览');
  if (!validDay(entry.day) || entry.day > today) throw new Error('请选择有效的欠款发生日期，日期不能晚于今天');
  if (!positiveCents(entry.cents)) throw new Error('欠款金额须大于零且在可计算范围内');
  if (state.ledger.opening.some(debt => debt.partyId === entry.partyId && debt.day === entry.day
    && debt.cents === entry.cents && debt.source === entry.source)) {
    throw new Error('已存在相同日期、金额和来源的旧欠款，可返回核对；另一笔可填写不同来源');
  }
}

export function readLedger(raw: unknown, trips: Trip[]): Ledger {
  const invalid = () => new Error('本地账目数据无法读取，请保留数据并联系开发者');
  if (!isObject(raw) || !Array.isArray(raw.parties) || !Array.isArray(raw.accounts)
    || !Array.isArray(raw.opening) || !Array.isArray(raw.receipts)) throw invalid();
  const parties = new Set<string>();
  for (const party of raw.parties) {
    if (!isObject(party) || typeof party.id !== 'string' || !party.id || parties.has(party.id)
      || typeof party.name !== 'string' || !party.name.trim()) throw invalid();
    parties.add(party.id);
  }
  const debts = new Map<string, string>();
  const sheetIds = new Set<string>();
  const tripsById = new Map(trips.map(trip => [trip.id, trip]));
  for (const account of raw.accounts) {
    if (!isObject(account) || typeof account.tripId !== 'string' || typeof account.sheetId !== 'string'
      || typeof account.partyId !== 'string' || !parties.has(account.partyId) || typeof account.reviewed !== 'boolean') throw invalid();
    const sheet = { tripId: account.tripId, sheetId: account.sheetId };
    const id = orderDebtId(sheet);
    const trip = tripsById.get(sheet.tripId);
    const customer = trip?.versions[trip.versions.length - 1].customers.find(order => order.id === sheet.sheetId);
    const partyInTrip = JSON.stringify([sheet.tripId, account.partyId]);
    if (sheetIds.has(id) || sheetIds.has(partyInTrip + ':party') || !customer
      || (account.reviewed && customer.items.some(item => trip?.statuses[item.id] === 'unrecorded'))) throw invalid();
    sheetIds.add(id);
    sheetIds.add(partyInTrip + ':party');
    if (account.reviewed) debts.set(id, account.partyId);
  }
  const openingKeys = new Set<string>();
  const openingCents = new Map<string, number>();
  for (const entry of raw.opening) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.partyId !== 'string'
      || !parties.has(entry.partyId) || typeof entry.day !== 'string' || !validDay(entry.day)
      || typeof entry.source !== 'string' || !positiveCents(entry.cents)) throw invalid();
    const id = openingDebtId(entry.id);
    const key = JSON.stringify([entry.partyId, entry.day, entry.cents, entry.source]);
    if (debts.has(id) || openingKeys.has(key)) throw invalid();
    openingKeys.add(key);
    openingCents.set(id, entry.cents);
    debts.set(id, entry.partyId);
  }
  const seenReceipts = new Set<string>();
  const paidByDebt = new Map<string, number>();
  for (const receipt of raw.receipts) {
    if (!isObject(receipt) || typeof receipt.id !== 'string' || !receipt.id || seenReceipts.has(receipt.id)
      || typeof receipt.partyId !== 'string' || !parties.has(receipt.partyId) || !positiveCents(receipt.cents)
      || typeof receipt.savedAt !== 'string' || !Number.isFinite(Date.parse(receipt.savedAt))
      || !Array.isArray(receipt.allocations) || !receipt.allocations.length) throw invalid();
    seenReceipts.add(receipt.id);
    const used = new Set<string>();
    const cents: number[] = [];
    for (const allocation of receipt.allocations) {
      if (!isObject(allocation) || typeof allocation.debtId !== 'string' || used.has(allocation.debtId)
        || debts.get(allocation.debtId) !== receipt.partyId || !positiveCents(allocation.cents)) throw invalid();
      used.add(allocation.debtId);
      cents.push(allocation.cents);
      const paid = (paidByDebt.get(allocation.debtId) ?? 0) + allocation.cents;
      if (!Number.isSafeInteger(paid) || paid > (openingCents.get(allocation.debtId) ?? Number.MAX_SAFE_INTEGER)) throw invalid();
      paidByDebt.set(allocation.debtId, paid);
    }
    if (sumCents(cents) !== receipt.cents) throw invalid();
  }
  return raw as unknown as Ledger;
}
