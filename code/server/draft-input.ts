import { catalogStatuses, isDraft, isObject, itemPriceSources, ItemInput, nullablePrice } from '../miniprogram/core/orders';
import { isTripDraft, TripDraft } from '../miniprogram/core/trips';
import { HttpError } from './http-error';

import { readCommand, readReviewInput, uuidPattern, validRevision, validSheetKey } from './request-input';

function cleanText(value: string, limit: number): boolean {
  return value.length <= limit && !value.includes('\0') && Buffer.from(value).toString() === value;
}

function optionalItemFields(value: unknown) {
  if (!isObject(value)) return value;
  return { ...value, brand: value.brand ?? '', specification: value.specification ?? '', price: value.price ?? null };
}

function itemFields({ id, product, brand, specification, unit, quantity, price }: ItemInput): ItemInput {
  return { id, product, brand, specification, unit, quantity, price };
}

const catalogFields = ['catalogProductId', 'catalogVariantId', 'catalogStatus', 'priceSource', 'priceHint'] as const;

function draftItemFields(item: ItemInput): ItemInput {
  const validId = (id: string | null | undefined) => id == null || (typeof id === 'string' && uuidPattern.test(id));
  if (!validId(item.catalogProductId) || !validId(item.catalogVariantId)
    || (item.catalogStatus != null && !catalogStatuses.includes(item.catalogStatus))
    || (item.priceSource != null && !itemPriceSources.includes(item.priceSource))
    || (item.priceHint != null && (typeof item.priceHint !== 'string' || !cleanText(item.priceHint, 4000)))) {
    throw new HttpError(400, 'invalid_catalog_metadata', '草稿的货品规格或价格来源不正确');
  }
  return Object.assign(itemFields(item), Object.fromEntries(
    catalogFields.filter(key => item[key] !== undefined).map(key => [key, item[key]])));
}

export function itemIdentityChanged(item: ItemInput, prior: ItemInput) {
  return (['product', 'brand', 'specification', 'unit'] as const).some(key => item[key] !== prior[key]);
}

export function clearCatalogIdentity(item: ItemInput) {
  delete item.catalogProductId;
  delete item.catalogVariantId;
  delete item.catalogStatus;
  delete item.priceHint;
}

export function reconcileManualItem(item: ItemInput, previous?: ItemInput, sameCustomer = true): ItemInput {
  // Catalog metadata on a manual save comes from the server's previous copy of the row.
  const next = itemFields(item);
  const sameIdentity = previous && !itemIdentityChanged(item, previous);
  if (sameIdentity) {
    for (const key of catalogFields) {
      if (previous[key] !== undefined) Object.assign(next, { [key]: previous[key] });
    }
  }
  const price = nullablePrice(item.price);
  if (price !== nullablePrice(previous?.price ?? null)) {
    next.priceSource = price === null ? null : 'manual';
  } else if (previous?.priceSource === 'customer_history' && (!sameIdentity || !sameCustomer)
    || previous?.priceSource === 'catalog' && !sameIdentity) {
    next.price = null;
    next.priceSource = null;
  } else if (!sameIdentity && previous?.priceSource !== undefined) {
    next.priceSource = previous.priceSource;
  }
  return next;
}

export interface SaveDraftInput {
  draft: TripDraft;
  requestId: string;
}

export function readSaveDraft(id: string, value: unknown): SaveDraftInput {
  const body = readCommand(value);
  const customersInput = Array.isArray(body.customers) ? body.customers.map(customer =>
    isObject(customer) && Array.isArray(customer.items) ? { ...customer, items: customer.items.map(optionalItemFields) } : customer)
    : body.customers;
  const draft = { id, revision: body.revision, customers: customersInput };
  if (!isTripDraft(draft) || !validRevision(draft.revision, true)) {
    throw new HttpError(400, 'invalid_draft', '草稿格式或版本不正确');
  }

  const customers = draft.customers.map(customer => {
    if (typeof customer.partyId === 'string' && !uuidPattern.test(customer.partyId)) {
      throw new HttpError(400, 'invalid_customer', '请重新选择已有客户');
    }
    const fields = [customer.id, customer.customer];
    const items = customer.items.map(draftItemFields);
    for (const item of items) fields.push(...Object.values(itemFields(item)));
    if (!fields.every(value => value === null || cleanText(value, 200))) {
      throw new HttpError(400, 'invalid_draft', '草稿字段过长或包含无效字符');
    }
    return { id: customer.id, customer: customer.customer, items, ...(customer.partyId === undefined ? {} : { partyId: customer.partyId }) };
  });
  return { draft: { id, revision: draft.revision, customers }, requestId: body.requestId };
}

export function readAmendmentInput(value: unknown) {
  const basis = readReviewInput(value);
  const { items, replacementStatuses = {} } = value as Record<string, unknown>;
  const draft = { id: 'amendment', revision: 0, customer: '', items: Array.isArray(items) ? items.map(optionalItemFields) : items };
  if (!isDraft(draft)) throw new HttpError(400, 'invalid_amendment', '更正须包含至少一条有效且编号唯一的货品明细');
  const lines = draft.items.map(itemFields);
  if (lines.some(line => Object.values(line).some(value => value !== null && !cleanText(value, 200)))) {
    throw new HttpError(400, 'invalid_amendment', '货品字段过长或包含无效字符');
  }
  if (!isObject(replacementStatuses)) throw new HttpError(400, 'invalid_amendment', '请选择有效的替换明细配送状态');
  const replacements = new Map<string, 'pending' | 'delivered'>();
  const lineIds = new Set(lines.map(line => line.id));
  for (const id of Object.keys(replacementStatuses).sort()) {
    const status = replacementStatuses[id];
    if (!validSheetKey(id) || !lineIds.has(id) || (status !== 'pending' && status !== 'delivered')) {
      throw new HttpError(400, 'invalid_amendment', '请选择有效的替换明细配送状态');
    }
    replacements.set(id, status);
  }
  return { ...basis, items: lines, replacementStatuses: Object.fromEntries(replacements) };
}
