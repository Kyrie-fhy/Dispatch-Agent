import { isObject } from '../miniprogram/core/orders';
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
