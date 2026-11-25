import { createHash, timingSafeEqual } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { ActivationCodes } from '../activation';
import { HttpError } from '../http-error';
import { TripStore } from '../trips';
import { changeCustomerAlias, customerPrices, issueActivationCode, listActivationCodes, listCustomers,
  renameAccount, revokeActivationCode, setAccountDisabled } from './account-ops';
import { confirmImport, maxCatalogJsonBytes, previewImport, readCatalogBoard, readCatalogCsv, saveManualItem,
  testCatalogQuery } from './catalog-ops';
import { readAdminJson, requireId, sendJson } from './http';
import { adminPage } from './page';
import { configuredCostRates, createMistake, dashboard, exportMistake, listMistakes, patchMistake, qualityTurns,
  type CostRates } from './quality';
import { accountOverview, listAccounts, materialContent, promptBoard, readEvalCase, readScope } from './store';

const adminCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'";
const loopbackHostPattern = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const tailscaleDomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.ts\.net$/;
const tailscaleIpv6Pattern = /^\[fd7a:115c:a1e0:[0-9a-f:]+\]$/;
const adminOriginError = 'DISPATCH_ADMIN_ORIGINS 仅支持 Tailscale 私密地址（如 https://<节点>.<尾网>.ts.net 或 http://100.64.x.x:8787）';

function isTailscaleHostname(hostname: string): boolean {
  if (tailscaleDomainPattern.test(hostname) || tailscaleIpv6Pattern.test(hostname)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!ipv4) return false;
  const [a, b, c, d] = ipv4.slice(1).map(Number);
  return a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255;
}

export function parseAdminOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(adminOriginError);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(adminOriginError);
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
    || !isTailscaleHostname(parsed.hostname)) {
    throw new Error(adminOriginError);
  }
  return parsed.origin;
}

export function configuredAdminOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = env.DISPATCH_ADMIN_ORIGINS?.trim();
  if (!raw) return [];
  return [...new Set(raw.split(',').map(parseAdminOrigin))];
}

function originMatchesHost(origin: string, normalizedHost: string): boolean {
  const parsed = new URL(origin);
  if (parsed.host === normalizedHost) return true;
  if (parsed.port) return false;
  return `${parsed.hostname}:${parsed.protocol === 'https:' ? '443' : '80'}` === normalizedHost;
}

function allowedAdminHost(host: string, trustedOrigins: readonly string[]): boolean {
  if (loopbackHostPattern.test(host)) return true;
  const normalizedHost = host.toLowerCase();
  return trustedOrigins.some(origin => originMatchesHost(origin, normalizedHost));
}

function allowedWriteOrigins(host: string, trustedOrigins: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  if (loopbackHostPattern.test(host)) {
    allowed.add('http://' + host);
    for (const origin of trustedOrigins) allowed.add(origin);
    return allowed;
  }
  const normalizedHost = host.toLowerCase();
  for (const origin of trustedOrigins) {
    if (originMatchesHost(origin, normalizedHost)) allowed.add(origin);
  }
  return allowed;
}

export function configuredAdminToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.DISPATCH_ADMIN_TOKEN?.trim();
  if (!token) return undefined;
  if (token.length < 16) throw new Error('DISPATCH_ADMIN_TOKEN 长度须不少于 16 位');
  return token;
}

type ModelStatus = { configured: boolean; name: string | null };
export type AdminRuntime = {
  codes: ActivationCodes;
  requireActivation: boolean;
  wechatConfigured: boolean;
  models: Record<'text' | 'image' | 'voice' | 'agent', ModelStatus>;
  rates: CostRates;
  adminOrigins?: readonly string[];
};

function requireAdmin(request: IncomingMessage, token: string): void {
  const match = /^Bearer ([^\s]{1,512})$/.exec(request.headers.authorization ?? '');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const same = timingSafeEqual(hash(token), hash(match?.[1] ?? ''));
  if (!match || !same) throw new HttpError(401, 'admin_auth_required', '请输入正确的排障后台口令');
}

function requireSameOrigin(request: IncomingMessage, trustedOrigins: readonly string[]) {
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (origin === undefined && site === undefined) return;
  const allowed = allowedWriteOrigins(request.headers.host ?? '', trustedOrigins);
  if (site === 'cross-site' || typeof origin !== 'string' || !allowed.has(origin.toLowerCase())) {
    throw new HttpError(403, 'admin_origin_rejected', '请从本机或受信任后台页面执行此操作');
  }
}

const methodNotAllowed = () => new HttpError(405, 'method_not_allowed', '此后台接口不支持该请求方法');

export async function handleAdmin(pool: Pool, adminToken: string | undefined, request: IncomingMessage,
  response: ServerResponse, runtime?: AdminRuntime): Promise<boolean> {
  const path = request.url?.split('?')[0] ?? '';
  if (path !== '/admin' && !path.startsWith('/admin/')) return false;
  const trustedOrigins = runtime?.adminOrigins ?? [];
  if (!adminToken || !allowedAdminHost(request.headers.host ?? '', trustedOrigins)
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
    throw new HttpError(404, 'not_found', '未找到此接口');
  }
  const method = request.method;
  if (path === '/admin') {
    if (method !== 'GET') throw methodNotAllowed();
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': adminCsp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    });
    response.end(adminPage);
    return true;
  }
  const apiPath = path.slice('/admin/api'.length);
  if (!path.startsWith('/admin/api/')) throw new HttpError(404, 'not_found', '未找到此接口');
  const search = new URL(request.url ?? path, 'http://localhost').searchParams;
  const ids = /^\/accounts\/([^/]+)(\/.*)?$/.exec(apiPath);
  const accountId = () => requireId(ids?.[1], '账号编号');
  const resource = ids?.[2] ?? '';
  const routes: { methods: Record<string, () => Promise<unknown> | unknown>; match: boolean }[] = [];
  const route = (candidate: string, methods: Record<string, () => Promise<unknown> | unknown>) => {
    routes.push({ match: apiPath === candidate, methods });
  };
  const accountRoute = (candidate: string, methods: Record<string, () => Promise<unknown> | unknown>) => {
    routes.push({ match: Boolean(ids && resource === candidate), methods });
  };
  const accountSubroute = (pattern: RegExp, methods: (id: string, suffix: string) => Record<string, () => Promise<unknown> | unknown>) => {
    const match = pattern.exec(resource);
    if (ids && match) routes.push({ match: true, methods: methods(match[1], match[2]) });
  };
  const json = (limit?: number) => readAdminJson(request, response, limit);
  const downloaded = Symbol();
  const download = (type: string, filename: string, content: string | Buffer) => {
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${filename}"` });
    response.end(content);
    return downloaded;
  };
  const codes = () => runtime?.codes ?? new ActivationCodes(adminToken);
  const rates = () => runtime?.rates ?? configuredCostRates({});

  route('/accounts', { GET: () => listAccounts(pool) });
  route('/prompts', { GET: promptBoard });
  route('/activation-codes', {
    GET: () => listActivationCodes(pool),
    POST: async () => issueActivationCode(pool, codes(), await json()),
  });
  const codeAction = /^\/activation-codes\/([^/]+)\/(revoke|reissue)$/.exec(apiPath);
  if (codeAction) route(apiPath, {
    POST: () => revokeActivationCode(pool, codes(), requireId(codeAction[1], '开通码编号'), codeAction[2] === 'reissue'),
  });
  route('/system/status', {
    GET: async () => {
      const reachable = await pool.query('SELECT 1 FROM dispatch.accounts LIMIT 0').then(() => true, () => false);
      const modelStatus = { configured: false, name: null };
      return { database: { reachable }, wechat: { configured: runtime?.wechatConfigured ?? false,
        requireActivation: runtime?.requireActivation ?? false }, models: runtime?.models ?? {
        text: modelStatus, image: modelStatus, voice: modelStatus, agent: modelStatus,
      }, costRates: rates() };
    },
  });

  accountRoute('', { PATCH: async () => renameAccount(pool, accountId(), await json()) });
  accountRoute('/disable', { POST: () => setAccountDisabled(pool, accountId(), true) });
  accountRoute('/enable', { POST: () => setAccountDisabled(pool, accountId(), false) });
  accountRoute('/overview', { GET: () => accountOverview(pool, accountId()) });
  accountRoute('/dashboard', { GET: () => dashboard(pool, accountId(), rates()) });
  accountRoute('/catalog', { GET: () => readCatalogBoard(pool, accountId()) });
  accountRoute('/catalog/export.csv', { GET: async () =>
    download('text/csv; charset=utf-8', 'catalog.csv', await readCatalogCsv(pool, accountId())) });
  accountRoute('/catalog/import/preview', { POST: async () =>
    previewImport(pool, accountId(), adminToken, await json(maxCatalogJsonBytes)) });
  accountRoute('/catalog/import/confirm', { POST: async () =>
    confirmImport(pool, accountId(), adminToken, await json(maxCatalogJsonBytes)) });
  accountRoute('/catalog/items', { POST: async () => saveManualItem(pool, accountId(), await json()) });
  accountSubroute(/^\/catalog\/variants\/([^/]+)$/, id => ({
    PATCH: async () => saveManualItem(pool, accountId(), await json(), requireId(id, '规格编号')),
  }));
  accountRoute('/catalog/test-query', { POST: async () => testCatalogQuery(pool, accountId(), await json()) });
  accountRoute('/customers', { GET: () => listCustomers(pool, accountId()) });
  accountSubroute(/^\/customers\/([^/]+)\/prices$/, id => ({
    GET: () => customerPrices(pool, accountId(), requireId(id, '客户编号')),
  }));
  accountRoute('/customer-aliases', {
    POST: async () => changeCustomerAlias(pool, accountId(), await json(), false),
    DELETE: async () => changeCustomerAlias(pool, accountId(), await json(), true),
  });
  accountRoute('/quality-turns', { GET: () => qualityTurns(pool, accountId(), search) });
  accountRoute('/mistakes', {
    GET: () => listMistakes(pool, accountId(), search),
    POST: async () => createMistake(pool, accountId(), await json()),
  });
  accountSubroute(/^\/mistakes\/([^/]+)$/, id => ({
    PATCH: async () => patchMistake(pool, accountId(), requireId(id, '回合编号'), await json()),
  }));
  accountSubroute(/^\/mistakes\/([^/]+)\/export$/, id => ({
    GET: async () => {
      const fixture = await exportMistake(pool, accountId(), requireId(id, '回合编号'));
      return download('application/json; charset=utf-8', `${fixture.id}.json`, JSON.stringify(fixture));
    },
  }));
  accountSubroute(/^\/scopes\/([^/]+)$/, id => ({
    GET: () => readScope(pool, new TripStore(pool), accountId(), requireId(id, '草稿或正式趟编号')),
  }));
  accountSubroute(/^\/turns\/([^/]+)\/eval-case$/, id => ({
    GET: async () => {
      const fixture = await readEvalCase(pool, accountId(), requireId(id, '回合编号'), search.get('catalog') === '1');
      return download('application/json; charset=utf-8', `${fixture.id}.json`, JSON.stringify(fixture));
    },
  }));
  accountSubroute(/^\/materials\/([^/]+)\/content$/, id => ({
    GET: async () => {
      const material = await materialContent(pool, accountId(), requireId(id, '材料编号'));
      response.writeHead(200, {
        'Content-Type': material.mime, 'Content-Length': material.content.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': adminCsp,
      });
      response.end(material.content);
      return downloaded;
    },
  }));

  const target = routes.find(candidate => candidate.match);
  if (target && (!method || !Object.hasOwn(target.methods, method))) throw methodNotAllowed();
  requireAdmin(request, adminToken);
  if (!target || !method) throw new HttpError(404, 'not_found', '未找到此接口');
  if (method !== 'GET') requireSameOrigin(request, trustedOrigins);
  const payload = await target.methods[method]();
  if (payload !== downloaded) sendJson(response, 200, payload);
  return true;
}
