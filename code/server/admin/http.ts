import { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../http-error';
import { isObject } from '../../miniprogram/core/orders';
import { uuidPattern } from '../request-input';

export type Input = Record<string, unknown>;

export function invalidInput(message: string): never {
  throw new HttpError(400, 'invalid_input', message);
}

export function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new HttpError(400, 'invalid_id', `请提供有效的${label}`);
  }
  return value.toLowerCase();
}

export function inputText(value: unknown, label: string, max: number, required = false) {
  if (typeof value !== 'string' || /[\0\uFFFD\uD800-\uDFFF]/u.test(value)
    || Array.from(value.trim()).length > max || (required && !value.trim())) {
    invalidInput(`请提供${required ? '非空且' : ''}不超过 ${max} 字的${label}`);
  }
  return value.trim();
}

export async function readAdminJson(request: IncomingMessage, response: ServerResponse, limit = 512 * 1024): Promise<Input> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'invalid_content_type', '请使用 JSON 请求');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      response.setHeader('Connection', 'close');
      throw new HttpError(413, 'body_too_large', '后台请求过大');
    }
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求内容不是有效的 UTF-8 JSON');
  }
  if (!isObject(body)) invalidInput('请提供 JSON 对象');
  return body;
}

export function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
}
