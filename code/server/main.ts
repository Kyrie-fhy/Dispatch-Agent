import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { localDatabaseUrl, requireApplicationRole } from './database';
import { readSaveDraft } from './draft-input';
import { DraftStore, missingDraft } from './drafts';
import { HttpError } from './http-error';
import { isObject } from '../miniprogram/core/orders';

const draftPath = /^\/v1\/drafts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const bodyLimit = 512 * 1024;

async function readJson(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'invalid_content_type', '请使用 JSON 请求');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Leave the socket open long enough to return 413, then let the response close it.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > bodyLimit) {
      response.setHeader('Connection', 'close');
      throw new HttpError(413, 'body_too_large', '草稿请求过大');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求内容不是有效的 JSON');
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function handle(store: DraftStore, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const host = request.headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    throw new HttpError(400, 'invalid_host', '请通过本机地址访问草稿服务');
  }
  const method = request.method;
  const path = request.url?.split('?')[0] ?? '';
  const match = draftPath.exec(path);
  const draftId = match?.[1];

  if (method === 'POST' && path === '/v1/session/development') {
    const body = await readJson(request, response);
    if (!isObject(body) || typeof body.account !== 'string') {
      throw new HttpError(400, 'invalid_development_account', '请选择本地测试账号 a 或 b');
    }
    sendJson(response, 201, await store.developmentSession(body.account));
    return;
  }

  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
  if (!token) throw new HttpError(401, 'session_required', '请先登录');
  const account = await store.accountFor(token);

  if (method === 'DELETE' && path === '/v1/session') {
    await store.revoke(token);
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
    return;
  }

  if (method === 'GET' && (path === '/v1/workspace' || draftId)) {
    const draft = await store.workspace(account);
    if (draftId && draftId !== draft.id) throw missingDraft();
    sendJson(response, 200, { draft });
    return;
  }

  if (method === 'PUT' && draftId) {
    const input = readSaveDraft(draftId, await readJson(request, response));
    sendJson(response, 200, { draft: await store.save(account, input) });
    return;
  }

  throw new HttpError(404, 'not_found', '未找到此接口');
}

export async function startLocalServer(pool: Pool, port: number): Promise<Server> {
  await requireApplicationRole(pool);
  const store = new DraftStore(pool);
  const server = createServer({ requestTimeout: 15_000 }, (request, response) => {
    void handle(store, request, response).catch(error => {
      if (response.destroyed) return;
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
      } else {
        console.error('本地请求处理失败', error instanceof Error ? error.name : '');
        sendJson(response, 500, { error: 'server_error', message: '服务暂时无法处理，请重试' });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

async function main(): Promise<void> {
  const port = Number(process.env.DISPATCH_API_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('本地 API 端口不正确');
  const pool = new Pool({ connectionString: localDatabaseUrl('DISPATCH_DB_URL'), connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('PostgreSQL 空闲连接已断开，后续请求会重新连接'));
  try {
    const server = await startLocalServer(pool, port);
    const stop = () => {
      server.close(() => { void pool.end(); });
      server.closeIdleConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log(`S5 本地草稿服务已启动 http://127.0.0.1:${port}`);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
