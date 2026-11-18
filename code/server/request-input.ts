import { isObject, unitPrice } from '../miniprogram/core/orders';
import { parseAmount } from '../miniprogram/core/settlement';
import { HttpError } from './http-error';

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requestPattern = /^[A-Za-z0-9_-]{1,80}$/;
const maxRevision = 2_147_483_647;

export function readCommand(value: unknown): Record<string, unknown> & { requestId: string } {
  if (!isObject(value) || typeof value.requestId !== 'string' || !requestPattern.test(value.requestId)) {
    throw new HttpError(400, 'invalid_request', '请提供有效的请求编号');
  }
  return { ...value, requestId: value.requestId };
}

export function readId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new HttpError(400, 'invalid_id', `请提供有效的${label}`);
  }
  return value;
}

export function validRevision(value: unknown, increment = false): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    && value <= maxRevision - Number(increment);
}

export function readPreviewInput(value: unknown) {
  const body = readCommand(value);
  const draftId = readId(body.draftId, '草稿编号');
  if (!validRevision(body.revision)) throw new HttpError(400, 'invalid_draft', '请提供有效的草稿版本');
  return { requestId: body.requestId, draftId, revision: body.revision };
}

export function readConfirmInput(value: unknown) {
  const body = readCommand(value);
  return { requestId: body.requestId, previewId: readId(body.previewId, '预览编号') };
}

export function readNextInput(value: unknown) {
  const body = readCommand(value);
  return { requestId: body.requestId, draftId: readId(body.draftId, '草稿编号') };
}

export function validSheetKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && !value.includes('\0') && Buffer.from(value).toString() === value;
}

export function readReviewInput(value: unknown) {
  const { requestId, version, statusRevision } = readCommand(value);
  if (!validRevision(version) || version === 0 || !validRevision(statusRevision)) {
    throw new HttpError(400, 'invalid_version', '请提供有效的正式单版本和配送修订号');
  }
  return { requestId, version, statusRevision };
}

export function readDeliveryInput(value: unknown) {
  const basis = readReviewInput(value);
  const { lineId, status } = value as Record<string, unknown>;
  if ((lineId !== null && !validSheetKey(lineId)) || (status !== 'pending' && status !== 'delivered')
    || (lineId === null && status !== 'delivered')) {
    throw new HttpError(400, 'invalid_delivery', '请选择要更新的货品和配送状态');
  }
  return { ...basis, lineId, status } as const;
}

export function readDeliveryEdit(value: unknown) {
  const basis = readReviewInput(value);
  const { lineId, receivedQuantity, price } = value as Record<string, unknown>;
  if (!validSheetKey(lineId) || typeof receivedQuantity !== 'string' || !/^(0|[1-9]\d*)$/.test(receivedQuantity)
      || !Number.isSafeInteger(Number(receivedQuantity))) {
    throw new HttpError(400, 'invalid_delivery_quantity', '实收数量须为零或正整数，且在可计算范围内');
  }
  if (price !== null && (typeof price !== 'string' || price.length > 40 || !price.trim())) {
    throw new HttpError(400, 'invalid_delivery_price', '请输入有效单价，待补价请留空');
  }
  try {
    return { ...basis, lineId, edit: { receivedQuantity: Number(receivedQuantity), unitPriceCents: unitPrice(price) } };
  } catch (error) {
    throw new HttpError(400, 'invalid_delivery_price', (error as Error).message);
  }
}

function readLedgerAmount(value: unknown, label: string) {
  const body = readCommand(value);
  if (typeof body.amount !== 'string' || body.amount.length > 40) {
    throw new HttpError(400, 'invalid_amount', `请输入有效的${label}`);
  }
  try {
    return { requestId: body.requestId, cents: parseAmount(body.amount, label) };
  } catch (error) {
    throw new HttpError(400, 'invalid_amount', (error as Error).message);
  }
}

export function readReceiptInput(value: unknown) {
  return readLedgerAmount(value, '收款金额');
}

export function readOpeningInput(value: unknown) {
  const amount = readLedgerAmount(value, '旧欠款金额');
  const { day, source = '' } = value as Record<string, unknown>;
  if (typeof day !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day) || day.startsWith('0000')
    || typeof source !== 'string' || source.length > 200 || source.includes('\0') || Buffer.from(source).toString() !== source) {
    throw new HttpError(400, 'invalid_opening', '请输入有效的欠款日期和来源');
  }
  return { ...amount, day, source: source.trim() };
}
