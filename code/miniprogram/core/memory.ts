import type { DeliveryEdit } from './delivery-execution';
import { nullablePrice, yuanToCents } from './orders';
import type { Party } from './settlement';
import type { CustomerDraft, CustomerOrder, Trip } from './trips';

export interface CustomerAlias {
  customerId: string;
  alias: string;
  normalizedAlias: string;
}

export interface CustomerDirectory {
  customers: readonly Party[];
  aliases: readonly CustomerAlias[];
}

interface CustomerCandidate {
  customerId: string;
  canonicalName: string;
}

export type CustomerMention =
  | (CustomerCandidate & { status: 'resolved'; matchedBy: 'canonical' | 'alias'; matchedAlias: string | null })
  | { status: 'ambiguous' | 'candidate_only'; customerId: null; candidates: CustomerCandidate[] }
  | { status: 'new_customer'; customerId: null };

export function normalizeMemoryText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[！-～]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .trim().replace(/\s+/g, ' ').toLowerCase();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function resolveCustomerMention(directory: CustomerDirectory, rawInput: string): CustomerMention {
  const key = normalizeMemoryText(rawInput);
  if (!key) return { status: 'new_customer', customerId: null };

  const aliases = new Map<string, CustomerAlias[]>();
  for (const alias of directory.aliases) {
    const entries = aliases.get(alias.customerId);
    if (entries) entries.push(alias);
    else aliases.set(alias.customerId, [alias]);
  }

  const exact: Extract<CustomerMention, { status: 'resolved' }>[] = [];
  const nearby: CustomerCandidate[] = [];
  const allowNearMatch = Array.from(key).length >= 2;
  const isNear = (name: string) => Array.from(name).length >= 2 && (key.includes(name) || name.includes(key));
  const compareCandidates = (left: CustomerCandidate, right: CustomerCandidate) =>
    compareText(left.canonicalName, right.canonicalName) || compareText(left.customerId, right.customerId);

  for (const { id: customerId, name: canonicalName } of new Map(directory.customers.map(party => [party.id, party])).values()) {
    const candidate = { customerId, canonicalName };
    const canonicalKey = normalizeMemoryText(canonicalName);
    const names = aliases.get(customerId) ?? [];
    const matched = names.find(alias => alias.normalizedAlias === key);
    if (canonicalKey === key) {
      exact.push({ ...candidate, status: 'resolved', matchedBy: 'canonical', matchedAlias: null });
    } else if (matched) {
      exact.push({ ...candidate, status: 'resolved', matchedBy: 'alias', matchedAlias: matched.alias });
    } else if (allowNearMatch && (isNear(canonicalKey) || names.some(alias => isNear(alias.normalizedAlias)))) {
      nearby.push(candidate);
    }
  }

  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const candidates = exact.map(({ customerId, canonicalName }) => ({ customerId, canonicalName }));
    return { status: 'ambiguous', customerId: null, candidates: candidates.sort(compareCandidates) };
  }
  if (nearby.length) return { status: 'candidate_only', customerId: null, candidates: nearby.sort(compareCandidates) };
  return { status: 'new_customer', customerId: null };
}

export function suggestDraftCustomerMentions(customers: readonly CustomerDraft[], directory: CustomerDirectory) {
  return customers.filter(customer => customer.partyId === undefined && normalizeMemoryText(customer.customer))
    .map(customer => ({ draftCustomerId: customer.id, resolution: resolveCustomerMention(directory, customer.customer) }));
}

export function mergeDraftCustomers(customers: readonly CustomerDraft[], directory: CustomerDirectory): CustomerDraft[] {
  const parties = new Map(directory.customers.map(party => [party.id, party]));
  const groups = new Map<string, CustomerDraft>();
  const merged: CustomerDraft[] = [];
  for (const customer of customers) {
    const partyId = customer.partyId === undefined
      ? resolveCustomerMention(directory, customer.customer).customerId
      : customer.partyId;
    const party = partyId ? parties.get(partyId) : undefined;
    const items = customer.items.map(item => ({ ...item }));
    if (!party) {
      merged.push({ ...customer, items });
      continue;
    }

    const group = groups.get(party.id);
    if (group) {
      group.items.push(...items);
    } else {
      const entry = { ...customer, partyId: party.id, customer: party.name, items };
      groups.set(party.id, entry);
      merged.push(entry);
    }
  }
  return merged;
}

export interface ProductMention {
  productName: string | null | undefined;
  brand?: string | null;
  spec?: string | null;
  unit: string | null | undefined;
}

export interface PriceSource {
  unitPriceCents: number;
  issuedAt: string;
  tripId: string;
  sheetId: string;
}

export interface VariantPrice extends PriceSource {
  brand: string;
  spec: string;
  unit: string;
}

export interface HistoricalSale extends VariantPrice {
  customerId: string;
  productName: string;
  linePosition: number;
  deliveryCompleted?: boolean;
  receivedQuantity?: number;
  catalogVariantId?: string | null;
}

export interface HistoricalSheet {
  tripId: string;
  sheetId: string;
  issuedAt: string;
  customerId: string | null;
  customer: CustomerOrder;
  statuses: Trip['statuses'];
  edits: Record<string, Partial<DeliveryEdit> | undefined>;
  reviewed: boolean;
  deliveryCompleted?: boolean;
}

export type HistoricalPrice =
  | (VariantPrice & { status: 'exact_match' | 'unique_variant_match'; previousDistinctPrice: PriceSource | null })
  | { status: 'ambiguous_variants'; candidates: VariantPrice[] }
  | { status: 'no_match' };

export function collectHistoricalSales(sheets: readonly HistoricalSheet[]): HistoricalSale[] {
  return sheets.flatMap(({ tripId, sheetId, issuedAt, customerId, customer, statuses, edits, reviewed, deliveryCompleted }) => {
    if (!customerId) return [];
    return customer.items.flatMap((item, linePosition) => {
      const edit = Object.prototype.hasOwnProperty.call(edits, item.id) ? edits[item.id] : undefined;
      const receivedQuantity = edit?.receivedQuantity ?? Number(item.quantity);
      const unitPriceCents = edit?.unitPriceCents !== undefined ? edit.unitPriceCents
        : item.unitPriceCents === undefined ? yuanToCents(nullablePrice(item.price)) : item.unitPriceCents;
      if (unitPriceCents === null || !Number.isSafeInteger(unitPriceCents) || unitPriceCents <= 0
        || !Number.isSafeInteger(receivedQuantity) || receivedQuantity <= 0
        || (reviewed && edit?.receivedQuantity === undefined && statuses[item.id] === 'pending')) return [];
      return [{
        customerId, tripId, sheetId, issuedAt, linePosition, unitPriceCents,
        ...(deliveryCompleted === undefined ? {} : { deliveryCompleted, receivedQuantity }),
        ...(item.catalogVariantId === undefined ? {} : { catalogVariantId: item.catalogVariantId }),
        productName: item.product, brand: item.brand ?? '', spec: item.specification ?? '', unit: item.unit,
      }];
    });
  });
}

// UTC timestamps from PostgreSQL carry up to six fractional digits.
function issuedTimeKey(value: string): string {
  return value.replace(/(?:\.(\d+))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(6, '0')}Z`);
}

function laterSaleFirst(left: HistoricalSale, right: HistoricalSale): number {
  return compareText(issuedTimeKey(right.issuedAt), issuedTimeKey(left.issuedAt))
    || compareText(right.tripId, left.tripId)
    || compareText(left.sheetId, right.sheetId)
    || right.linePosition - left.linePosition;
}

function priceSource({ unitPriceCents, issuedAt, tripId, sheetId }: PriceSource): PriceSource {
  return { unitPriceCents, issuedAt, tripId, sheetId };
}

function variantPrice(sale: HistoricalSale): VariantPrice {
  return { ...priceSource(sale), brand: sale.brand, spec: sale.spec, unit: sale.unit };
}

export function lookupHistoricalPrice(sales: readonly HistoricalSale[], customerId: string, product: ProductMention): HistoricalPrice {
  const productName = normalizeMemoryText(product.productName);
  const unit = normalizeMemoryText(product.unit);
  const brand = normalizeMemoryText(product.brand);
  const spec = normalizeMemoryText(product.spec);
  if (!productName || !unit) return { status: 'no_match' };

  const matches = sales.filter(sale => sale.customerId === customerId
    && normalizeMemoryText(sale.productName) === productName
    && normalizeMemoryText(sale.unit) === unit
    && (!brand || normalizeMemoryText(sale.brand) === brand)
    && (!spec || normalizeMemoryText(sale.spec) === spec)).sort(laterSaleFirst);

  const latest = matches[0];
  if (!latest) return { status: 'no_match' };

  const variants = new Map<string, HistoricalSale>();
  for (const sale of matches) {
    const variant = JSON.stringify([normalizeMemoryText(sale.brand), normalizeMemoryText(sale.spec)]);
    if (!variants.has(variant)) variants.set(variant, sale);
  }
  if (variants.size > 1) return { status: 'ambiguous_variants', candidates: [...variants.values()].map(variantPrice) };

  const exact = brand === normalizeMemoryText(latest.brand) && spec === normalizeMemoryText(latest.spec);
  const previous = matches.find(sale => sale.unitPriceCents !== latest.unitPriceCents);
  return {
    ...variantPrice(latest), status: exact ? 'exact_match' : 'unique_variant_match',
    previousDistinctPrice: previous ? priceSource(previous) : null,
  };
}

export function lookupDeliveredPrice(sales: readonly HistoricalSale[], customerId: string,
  product: ProductMention & { catalogVariantId: string }): ({ status: 'matched' } & PriceSource)
  | { status: 'no_match' | 'conflict' } {
  const key = (text: string | null | undefined) =>
    normalizeMemoryText(text?.normalize('NFKC')).replace(/\s+/g, '').replace(/[‐‑–—－]/g, '-')
      .replace(/(\d)(千克|公斤|克)/g, (_, number: string, unit: string) => number + (unit === '克' ? 'g' : 'kg'));
  const unit = key(product.unit);
  if (!unit) return { status: 'no_match' };
  const matches = sales.filter(sale => sale.customerId === customerId && sale.deliveryCompleted === true
    && (sale.receivedQuantity === undefined || (Number.isSafeInteger(sale.receivedQuantity) && sale.receivedQuantity > 0))
    && Number.isSafeInteger(sale.unitPriceCents) && sale.unitPriceCents > 0 && key(sale.unit) === unit
    && (sale.catalogVariantId ? sale.catalogVariantId === product.catalogVariantId
      : key(sale.productName) === key(product.productName) && key(sale.brand) === key(product.brand) && key(sale.spec) === key(product.spec)))
    .sort(laterSaleFirst);
  const latest = matches[0];
  if (!latest) return { status: 'no_match' };
  if (matches.some(sale => sale.tripId === latest.tripId && sale.sheetId === latest.sheetId
    && sale.unitPriceCents !== latest.unitPriceCents)) return { status: 'conflict' };
  return { status: 'matched', ...priceSource(latest) };
}

export interface DraftPriceLine extends ProductMention {
  id: string;
  unitPriceCents: number | null;
}

export interface DraftPriceCustomer {
  id: string;
  customerId?: string | null;
  items: readonly DraftPriceLine[];
}

export function draftCustomersForPriceSuggestions(customers: readonly CustomerDraft[]): DraftPriceCustomer[] {
  return customers.map(({ id, partyId: customerId, items }) => ({
    id, customerId,
    items: items.filter(item => nullablePrice(item.price) === null).map(item => ({
      id: item.id, productName: item.product, brand: item.brand, spec: item.specification, unit: item.unit, unitPriceCents: null,
    })),
  }));
}

export type DraftPriceSuggestion =
  { draftCustomerId: string; lineId: string }
  & (({ customerId: string } & HistoricalPrice) | { customerId: null; status: 'unresolved_customer' });

export function suggestDraftPrices(sales: readonly HistoricalSale[], customers: readonly DraftPriceCustomer[]): DraftPriceSuggestion[] {
  const byCustomer = new Map<string, HistoricalSale[]>();
  for (const sale of sales) {
    const entries = byCustomer.get(sale.customerId);
    if (entries) entries.push(sale);
    else byCustomer.set(sale.customerId, [sale]);
  }

  return customers.flatMap(({ id: draftCustomerId, customerId, items }) =>
    items.filter(item => item.unitPriceCents === null).map(item => {
      const target = { draftCustomerId, lineId: item.id };
      if (!customerId) return { ...target, customerId: null, status: 'unresolved_customer' };
      return { ...target, customerId, ...lookupHistoricalPrice(byCustomer.get(customerId) ?? [], customerId, item) };
    }));
}
