import { isObject, ItemInput } from '../miniprogram/core/orders';
import { isTripDraft, TripDraft } from '../miniprogram/core/trips';
import { HttpError } from './http-error';

const requestPattern = /^[A-Za-z0-9_-]{1,80}$/;
const maxRevision = 2_147_483_646;

function cleanText(value: string, limit: number): boolean {
  return value.length <= limit && !value.includes('\0') && Buffer.from(value).toString() === value;
}

export interface SaveDraftInput {
  draft: TripDraft;
  requestId: string;
}

export function readSaveDraft(id: string, body: unknown): SaveDraftInput {
  if (!isObject(body) || typeof body.requestId !== 'string' || !requestPattern.test(body.requestId)) {
    throw new HttpError(400, 'invalid_request', '请提供有效的保存请求编号');
  }
  const draft = { id, revision: body.revision, customers: body.customers };
  if (!isTripDraft(draft) || draft.revision > maxRevision) {
    throw new HttpError(400, 'invalid_draft', '草稿格式或版本不正确');
  }

  const customers = draft.customers.map(customer => {
    // The local service does not yet have an account-scoped customer directory.
    if (typeof customer.partyId === 'string') {
      throw new HttpError(400, 'invalid_customer', '本阶段草稿只能录入新客户');
    }
    const fields = [customer.id, customer.customer];
    const items = customer.items.map(({ id, product, brand, specification, unit, quantity, price }): ItemInput => {
      fields.push(id, product, brand, specification, unit, quantity, price);
      return { id, product, brand, specification, unit, quantity, price };
    });
    if (!fields.every(value => cleanText(value, 200))) {
      throw new HttpError(400, 'invalid_draft', '草稿字段过长或包含无效字符');
    }
    return { id: customer.id, customer: customer.customer, items, ...(customer.partyId === null ? { partyId: null } : {}) };
  });
  return { draft: { id, revision: draft.revision, customers }, requestId: body.requestId };
}
