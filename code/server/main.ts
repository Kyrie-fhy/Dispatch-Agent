import { AgentRuntime } from './agent/runtime';
import { AgentModel, configuredAgentModel } from './agent/model';
import { configuredIntentModel, IntentModel } from './agent/intent';
import { configuredDeliveryModel, DeliveryModel } from './agent/delivery-model';
import { missingDraft, readAccount, readWorkspace } from './account-workspace';
import { readTurnInput } from './agent/store';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { databaseOptions, requireApplicationRole, trialMode } from './database';
import { readAmendmentInput, readSaveDraft } from './draft-input';
import { AmendmentStore } from './amendments';
import { DraftStore } from './drafts';
import { DeliveryStore, readDeliveryApply } from './delivery';
import { LedgerStore } from './ledger';
import { MaterialStore, readMaterialInput } from './materials';
import { MemoryStore } from './memory';
import { TripStore } from './trips';
import { readConfirmInput, readDeliveryEdit, readDeliveryInput, readNextInput, readOpeningInput, readPreviewInput, readReceiptInput,
  readCommand, readReviewInput, uuidPattern, validRevision, validSheetKey } from './request-input';
import { HttpError } from './http-error';
import { configuredWechatLogin, readWechatCode, WechatLogin } from './wechat-login';
import { isObject } from '../miniprogram/core/orders';
import { materialChunkBytes } from '../miniprogram/core/materials';
import { configuredImageModel, configuredTextModel, ImageModel, TextModel } from './text-model';
import { readImageOrder, readTextOrder, TextOrders } from './text-orders';
import { configuredSpeechModel, decodeWave, readTranscript, SpeechModel, validateWave, voiceMaxBytes, voiceMaxJsonBytes } from './voice';

const bodyLimit = 512 * 1024;

async function readJson(request: IncomingMessage, response: ServerResponse, limit = bodyLimit, message = '草稿请求过大'): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'invalid_content_type', '请使用 JSON 请求');
  }
  const payload = await readBody(request, response, limit, message);
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求内容不是有效的 JSON');
  }
}

async function readBody(request: IncomingMessage, response: ServerResponse, limit: number, message: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Leave the socket open long enough to return 413, then let the response close it.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) {
      response.setHeader('Connection', 'close');
      throw new HttpError(413, 'body_too_large', message);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function resourceId(path: string, collection: 'drafts' | 'trips'): string | null {
  const prefix = `/v1/${collection}/`;
  if (!path.startsWith(prefix)) return null;
  const id = path.slice(prefix.length);
  return uuidPattern.test(id) ? id : null;
}

async function handle(pool: Pool, store: DraftStore, trips: TripStore, delivery: DeliveryStore, ledger: LedgerStore, amendments: AmendmentStore,
  materials: MaterialStore, textOrders: TextOrders, agent: AgentRuntime, memory: MemoryStore, request: IncomingMessage, response: ServerResponse,
  wechat?: WechatLogin, speechModel?: SpeechModel): Promise<void> {
  const host = request.headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    throw new HttpError(400, 'invalid_host', '请通过本机地址访问草稿服务');
  }
  const method = request.method;
  const path = request.url?.split('?')[0] ?? '';

  if (method === 'GET' && path === '/healthz') {
    try { await pool.query('SELECT 1 FROM dispatch.workspaces LIMIT 0'); }
    catch { throw new HttpError(503, 'database_unavailable', '数据库暂不可用'); }
    sendJson(response, 200, { status: 'ready' });
    return;
  }
  const draftId = resourceId(path, 'drafts');
  const tripId = resourceId(path, 'trips');

  if (method === 'POST' && path === '/v1/session/development') {
    if (wechat) throw new HttpError(404, 'not_found', '未找到此接口');
    const body = await readJson(request, response);
    if (!isObject(body) || typeof body.account !== 'string') {
      throw new HttpError(400, 'invalid_development_account', '请选择本地测试账号 a 或 b');
    }
    sendJson(response, 201, await store.developmentSession(body.account));
    return;
  }
  if (method === 'POST' && path === '/v1/session/wechat') {
    if (!wechat) throw new HttpError(404, 'not_found', '未找到此接口');
    const code = readWechatCode(await readJson(request, response));
    const openId = await wechat.exchange(code);
    sendJson(response, 201, await store.wechatSession(wechat.appId, openId));
    return;
  }

  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
  if (!token) throw new HttpError(401, 'session_required', '请先登录');
  const account = await store.accountFor(token, wechat?.appId);

  if (method === 'DELETE' && path === '/v1/session') {
    await store.revoke(token);
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
    return;
  }

  if (method === 'POST' && path === '/v1/agent/turns') {
    const input = readTurnInput(await readJson(request, response));
    sendJson(response, 202, await agent.submit(account, input, () => store.accountFor(token, wechat?.appId)));
    return;
  }
  if (method === 'GET' && path === '/v1/agent/conversation') {
    sendJson(response, 200, await agent.store.conversation(account));
    return;
  }
  if (method === 'POST' && path === '/v1/agent/card-actions') {
    sendJson(response, 200, await agent.store.card(account, await readJson(request, response)));
    return;
  }
  if (method === 'GET' && path === '/v1/agent/memory') {
    const id = new URL(request.url ?? path, 'http://127.0.0.1').searchParams.get('draftId');
    if (typeof id !== 'string' || !uuidPattern.test(id)) {
      throw new HttpError(400, 'invalid_id', '请提供有效的草稿编号');
    }
    sendJson(response, 200, await memory.agentMemory(account, id));
    return;
  }
  if (method === 'POST' && path === '/v1/agent/customer-choice') {
    sendJson(response, 200, await memory.chooseDraftCustomer(account, await readJson(request, response)));
    return;
  }
  if (method === 'POST' && path === '/v1/agent/price-adopt') {
    sendJson(response, 200, await memory.adoptDraftPrices(account, await readJson(request, response)));
    return;
  }
  if (method === 'GET' && path === '/v1/customer-aliases') {
    sendJson(response, 200, await memory.aliasList(account));
    return;
  }
  if (method === 'POST' && path === '/v1/customer-aliases/unbind') {
    sendJson(response, 200, await memory.unbindCustomerAlias(account, await readJson(request, response)));
    return;
  }
  const turnRoute = /^\/v1\/agent\/turns\/([^/]+)\/(events|undo)$/.exec(path);
  if (turnRoute && uuidPattern.test(turnRoute[1])) {
    const [, id, action] = turnRoute;
    if (method === 'GET' && action === 'events') {
      const after = new URL(request.url ?? '/', 'http://localhost').searchParams.get('after') ?? '0';
      if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) {
        throw new HttpError(400, 'invalid_cursor', '消息进度无效，请重新载入。');
      }
      sendJson(response, 200, await agent.store.events(account, id, Number(after)));
      return;
    }
    if (method === 'POST' && action === 'undo') {
      sendJson(response, 200, await agent.store.undo(account, id, readCommand(await readJson(request, response)).requestId));
      return;
    }
  }

  if (method === 'GET' && path === '/v1/workspace') {
    sendJson(response, 200, await trips.workspace(account));
    return;
  }
  const voiceRoute = /^\/v1\/drafts\/([^/]+)\/transcription$/.exec(path);
  const agentVoice = path === '/v1/agent/transcription';
  const voiceDraftId = agentVoice ? request.headers['x-draft-id'] : voiceRoute?.[1];
  if (method === 'POST' && (agentVoice || (voiceRoute && uuidPattern.test(voiceRoute[1])))) {
    if (typeof voiceDraftId !== 'string' || !uuidPattern.test(voiceDraftId)) throw missingDraft();
    const header = request.headers['x-draft-revision'];
    const revision = typeof header === 'string' && /^\d{1,10}$/.test(header) ? Number(header) : NaN;
    if (!validRevision(revision)) throw new HttpError(400, 'invalid_draft', '请提供有效的草稿版本');
    const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
    if (contentType !== 'audio/wav' && contentType !== 'application/json') {
      throw new HttpError(415, 'invalid_content_type', '请以 JSON 或 WAV 发送录音');
    }
    const checkVoice = () => agentVoice ? readAccount(pool, account, async client => {
      const workspace = await readWorkspace(client, account);
      if (workspace.id !== voiceDraftId) throw missingDraft();
      if (workspace.revision !== revision) throw new HttpError(409, 'draft_changed', '本趟信息已更新，请刷新后重新录音。');
    }) : store.checkVoiceDraft(account, voiceDraftId, revision);
    await checkVoice();
    if (!speechModel) throw new HttpError(503, 'voice_model_unavailable', '语音转写暂未开启，可以手动输入。');
    const tooLarge = '录音文件过大，请分段录音';
    const wave = contentType === 'application/json'
      ? decodeWave(await readJson(request, response, voiceMaxJsonBytes, tooLarge))
      : await readBody(request, response, voiceMaxBytes, tooLarge);
    validateWave(wave);
    await store.accountFor(token, wechat?.appId);
    await checkVoice();
    const result = await speechModel(wave);
    await store.accountFor(token, wechat?.appId);
    await checkVoice();
    sendJson(response, 200, { draftId: voiceDraftId, revision, text: readTranscript(result) });
    return;
  }
  if (method === 'POST' && (path === '/v1/text-orders' || path === '/v1/image-orders')) {
    const body = await readJson(request, response);
    const input = path === '/v1/text-orders' ? readTextOrder(body) : readImageOrder(body);
    sendJson(response, 200, await textOrders.apply(account, input, () => store.accountFor(token, wechat?.appId)));
    return;
  }
  if (path === '/v1/materials') {
    if (method === 'GET') {
      sendJson(response, 200, { materials: await materials.list(account) });
      return;
    }
    if (method === 'POST') {
      const input = readMaterialInput(await readJson(request, response));
      sendJson(response, 201, { material: await materials.begin(account, input) });
      return;
    }
  }
  const materialRoute = /^\/v1\/materials\/([^/]+)(?:\/(chunks))?$/.exec(path);
  if (materialRoute && uuidPattern.test(materialRoute[1])) {
    const [, id, chunks] = materialRoute;
    if (method === 'GET' && !chunks) {
      sendJson(response, 200, { material: await materials.read(account, id) });
      return;
    }
    if (method === 'PUT' && chunks) {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
        throw new HttpError(415, 'invalid_content_type', '请发送文件分块');
      }
      const offset = request.headers['x-material-offset'];
      if (typeof offset !== 'string' || !/^\d{1,8}$/.test(offset)) {
        throw new HttpError(400, 'invalid_chunk', '文件分块位置无效');
      }
      await materials.read(account, id);
      const content = await readBody(request, response, materialChunkBytes, '文件分块过大');
      sendJson(response, 200, { material: await materials.append(account, id, Number(offset), content) });
      return;
    }
  }
  if (method === 'GET' && draftId) {
    sendJson(response, 200, { draft: await store.draft(account, draftId) });
    return;
  }
  if (method === 'PUT' && draftId) {
    const input = readSaveDraft(draftId, await readJson(request, response));
    sendJson(response, 200, { draft: await store.save(account, input) });
    return;
  }
  if (method === 'POST' && path === '/v1/trips/preview') {
    const input = readPreviewInput(await readJson(request, response));
    sendJson(response, 200, { preview: await trips.preview(account, input) });
    return;
  }
  if (method === 'POST' && path === '/v1/trips/confirm') {
    const input = readConfirmInput(await readJson(request, response));
    sendJson(response, 200, await trips.confirm(account, input));
    return;
  }
  if (method === 'POST' && path === '/v1/trips/next-draft') {
    const input = readNextInput(await readJson(request, response));
    sendJson(response, 200, { draft: await trips.nextDraft(account, input) });
    return;
  }
  if (method === 'GET' && path === '/v1/trips') {
    const params = new URL(request.url ?? path, 'http://127.0.0.1').searchParams;
    const before = params.get('before');
    const limit = params.get('limit') ?? '20';
    if ((before !== null && !uuidPattern.test(before)) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50) {
      throw new HttpError(400, 'invalid_trip_page', '历史趟次分页参数不正确');
    }
    sendJson(response, 200, await trips.history(account, before, Number(limit)));
    return;
  }
  const tripTurnsRoute = /^\/v1\/trips\/([^/]+)\/turns$/.exec(path);
  if (method === 'GET' && tripTurnsRoute && uuidPattern.test(tripTurnsRoute[1])) {
    sendJson(response, 200, await agent.store.tripTurns(account, tripTurnsRoute[1]));
    return;
  }
  if (method === 'GET' && tripId) {
    sendJson(response, 200, await trips.trip(account, tripId));
    return;
  }

  const sheetRoute = /^\/v1\/trips\/([^/]+)\/sheets\/([^/]+)(?:\/(delivery(?:\/(?:preview|confirm|line|complete|apply))?|review|ledger|(?:opening|receipt|amendment)\/(?:preview|confirm)))?$/.exec(path);
  if (sheetRoute && uuidPattern.test(sheetRoute[1])) {
    const [, sheetTripId, key, action] = sheetRoute;
    let sheetId: string;
    try { sheetId = decodeURIComponent(key); }
    catch { throw new HttpError(400, 'invalid_id', '请提供有效的客户单编号'); }
    if (!validSheetKey(sheetId)) throw new HttpError(400, 'invalid_id', '请提供有效的客户单编号');
    const sheetKey = { tripId: sheetTripId, sheetId };
    if (method === 'GET' && !action) {
      sendJson(response, 200, { sheet: await delivery.sheet(account, sheetTripId, sheetId) });
      return;
    }
    if (method === 'GET' && action === 'ledger') {
      sendJson(response, 200, { ledger: await ledger.read(account, sheetKey) });
      return;
    }
    if (method === 'POST' && action && action !== 'ledger') {
      const body = await readJson(request, response);
      if (action === 'opening/preview') {
        sendJson(response, 200, { preview: await ledger.previewOpening(account, sheetKey, readOpeningInput(body)) });
      } else if (action === 'opening/confirm') {
        sendJson(response, 200, { opening: await ledger.confirmOpening(account, sheetKey, readConfirmInput(body)) });
      } else if (action === 'receipt/preview') {
        sendJson(response, 200, { preview: await ledger.previewReceipt(account, sheetKey, readReceiptInput(body)) });
      } else if (action === 'receipt/confirm') {
        sendJson(response, 200, { receipt: await ledger.confirmReceipt(account, sheetKey, readConfirmInput(body)) });
      } else if (action === 'amendment/preview') {
        sendJson(response, 200, { preview: await amendments.preview(account, sheetKey, readAmendmentInput(body)) });
      } else if (action === 'amendment/confirm') {
        sendJson(response, 200, { version: await amendments.confirm(account, sheetKey, readConfirmInput(body)) });
      } else if (action === 'delivery/preview') {
        const preview = await delivery.preview(account, sheetTripId, sheetId, readDeliveryInput(body));
        sendJson(response, 200, { preview });
      } else {
        const sheet = action === 'review' ? await delivery.review(account, sheetTripId, sheetId, readReviewInput(body))
          : action === 'delivery/line' ? await delivery.editLine(account, sheetTripId, sheetId, readDeliveryEdit(body))
          : action === 'delivery/complete' ? await delivery.complete(account, sheetTripId, sheetId, readReviewInput(body))
          : action === 'delivery/apply' ? await delivery.apply(account, sheetTripId, sheetId, readDeliveryApply(body))
          : action === 'delivery/confirm' ? await delivery.confirm(account, sheetTripId, sheetId, readConfirmInput(body))
          : await delivery.setDelivery(account, sheetTripId, sheetId, readDeliveryInput(body));
        sendJson(response, 200, { sheet });
      }
      return;
    }
  }

  throw new HttpError(404, 'not_found', '未找到此接口');
}

export async function startLocalServer(pool: Pool, port: number, wechat?: WechatLogin, textModel?: TextModel,
  imageModel?: ImageModel, speechModel?: SpeechModel, agentModel?: AgentModel, intentModel?: IntentModel, deliveryModel?: DeliveryModel): Promise<Server> {
  await requireApplicationRole(pool);
  const store = new DraftStore(pool);
  const trips = new TripStore(pool);
  const delivery = new DeliveryStore(pool);
  const ledger = new LedgerStore(pool);
  const amendments = new AmendmentStore(pool);
  const materials = new MaterialStore(pool);
  const memory = new MemoryStore(pool);
  const textOrders = new TextOrders(pool, textModel, imageModel);
  const agent = new AgentRuntime(pool, trips, textOrders, agentModel, intentModel, deliveryModel);
  await agent.store.interrupt();
  const server = createServer({ requestTimeout: 15_000 }, (request, response) => {
    void handle(pool, store, trips, delivery, ledger, amendments, materials, textOrders, agent, memory, request, response, wechat, speechModel).catch(error => {
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
  const trial = trialMode();
  const wechat = configuredWechatLogin(process.env);
  if (trial && !wechat) throw new Error('试用环境必须配置微信登录');
  const pool = new Pool(databaseOptions('DISPATCH_DB_URL'));
  pool.on('error', () => console.error('PostgreSQL 空闲连接已断开，后续请求会重新连接'));
  try {
    const server = await startLocalServer(pool, port, wechat, configuredTextModel(process.env),
      configuredImageModel(process.env), configuredSpeechModel(process.env), configuredAgentModel(process.env),
      configuredIntentModel(process.env, 'A'), configuredDeliveryModel(process.env));
    const stop = () => {
      server.close(() => { void pool.end(); });
      server.closeIdleConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log(`S5 ${trial ? '试用' : '本地'} API 已启动 http://127.0.0.1:${port}（${wechat ? '微信会话' : '开发会话'}）`);
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
