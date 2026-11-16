import { ItemInput } from '../miniprogram/core/orders';
import { isTripDraft, TripDraft } from '../miniprogram/core/trips';
import { HttpError } from './http-error';

import { readCommand, uuidPattern, validRevision } from './request-input';

function cleanText(value: string, limit: number): boolean {
  return value.length <= limit && !value.includes('\0') && Buffer.from(value).toString() === value;
}

export interface SaveDraftInput {
  draft: TripDraft;
  requestId: string;
}

export function readSaveDraft(id: string, value: unknown): SaveDraftInput {
  const body = readCommand(value);
  const draft = { id, revision: body.revision, customers: body.customers };
  if (!isTripDraft(draft) || !validRevision(draft.revision, true)) {
    throw new HttpError(400, 'invalid_draft', '草稿格式或版本不正确');
  }

  const customers = draft.customers.map(customer => {
    if (typeof customer.partyId === 'string' && !uuidPattern.test(customer.partyId)) {
      throw new HttpError(400, 'invalid_customer', '请重新选择已有客户');
    }
    const fields = [customer.id, customer.customer];
    const items = customer.items.map(({ id, product, brand, specification, unit, quantity, price }): ItemInput => {
      fields.push(id, product, brand, specification, unit, quantity, price);
      return { id, product, brand, specification, unit, quantity, price };
    });
    if (!fields.every(value => cleanText(value, 200))) {
      throw new HttpError(400, 'invalid_draft', '草稿字段过长或包含无效字符');
    }
    return { id: customer.id, customer: customer.customer, items, ...(customer.partyId === undefined ? {} : { partyId: customer.partyId }) };
  });
  return { draft: { id, revision: draft.revision, customers }, requestId: body.requestId };
}
