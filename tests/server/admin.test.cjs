const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { Pool } = require('pg');
const { migrate } = require('../../code/server-dist/server/migrate');
const { requireApplicationRole } = require('../../code/server-dist/server/database');
const { startLocalServer } = require('../../code/server-dist/server/main');
const { configuredAdminToken } = require('../../code/server-dist/server/admin');
const { textPrompt } = require('../../code/server-dist/server/text-model');
const { deliveryTools } = require('../../code/server-dist/server/agent/delivery-model');

const pause = ms => new Promise(done => setTimeout(done, ms));

function adminUrl() {
  const url = new URL(process.env.DISPATCH_TEST_ADMIN_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'The test cluster must be local');
  assert.notEqual(url.pathname, '/dispatch_local');
  return url;
}

async function ensureSharedRole(admin) {
  const hasRole = async () => (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'dispatch_app'")).rowCount > 0;
  if (await hasRole()) return;

  await pause(400);
  const deadline = Date.now() + 5000;
  while (!(await hasRole())) {
    const { rowCount: peers } = await admin.query("SELECT 1 FROM pg_database WHERE datname LIKE 'dispatch_test_%'");
    if (!peers || Date.now() >= deadline) break;
    await pause(30);
  }
  if (await hasRole()) return;

  try {
    await admin.query('CREATE ROLE dispatch_app NOLOGIN');
  } catch (error) {
    if (error.constraint !== 'pg_authid_rolname_index' && error.code !== '42710') throw error;
  }
}

async function isolatedDatabase(t) {
  const url = adminUrl();
  const name = `dispatch_test_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const admin = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  let db;
  t.after(async () => {
    try {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
    } finally {
      await admin.end();
    }
  });
  await ensureSharedRole(admin);
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
  url.pathname = `/${name}`;
  db = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  try {
    await migrate(db);
  } catch (error) {
    if (error.constraint !== 'pg_authid_rolname_index' && error.code !== '42710') throw error;
    const { rowCount } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'dispatch_app'");
    if (!rowCount) throw error;
    await migrate(db);
  }
  await admin.query(`GRANT dispatch_app TO ${name}`);
  url.username = name;
  url.password = password;
  const probe = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  try {
    await requireApplicationRole(probe);
  } finally {
    await probe.end();
  }
  return { name, admin, appUrl: url.href, owner: db };
}

async function start(db, options = {}) {
  const pool = new Pool({ connectionString: db.appUrl, connectionTimeoutMillis: 5000 });
  let server;
  try {
    server = await startLocalServer(pool, 0, undefined, options.textModel, options.imageModel, undefined,
      options.agentModel, options.intentModel, options.deliveryModel, options.adminToken);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async request(path, { method = 'GET', token, authorization, body, chunk, offset } = {}) {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (authorization) headers.authorization = authorization;
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (chunk) {
        headers['content-type'] = 'application/octet-stream';
        if (offset !== undefined) headers['x-material-offset'] = String(offset);
      }
      const response = await fetch(origin + path, {
        method, headers, body: chunk ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      const raw = response.status === 204 ? '' : await response.text();
      const json = (response.headers.get('content-type') || '').includes('application/json');
      return { status: response.status, headers: response.headers,
        data: json && raw ? JSON.parse(raw) : raw };
    },
    async stop() {
      const closed = new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      server.closeIdleConnections();
      try { await closed; } finally { await pool.end(); }
    },
  };
}

function materialInput(draft, payload, requestId) {
  return { draftId: draft.id, revision: draft.revision, requestId, name: 's7d-unpriced-order.png',
    size: payload.length, digest: createHash('sha256').update(payload).digest('hex') };
}

function agentInput(draft, text, materialIds = []) {
  return { draftId: draft.id, revision: draft.revision, text, materialIds, requestId: randomUUID() };
}

async function login(api, account) {
  const result = await api.request('/v1/session/development', { method: 'POST', body: { account } });
  assert.equal(result.status, 201);
  return result.data.token;
}

async function read(api, token) {
  const result = await api.request('/v1/workspace', { token });
  assert.equal(result.status, 200);
  return result.data.draft;
}

async function waitForAgent(api, token, id) {
  const events = [];
  let after = 0;
  const started = Date.now();
  while (Date.now() - started < 65_000) {
    const { status, data } = await api.request(`/v1/agent/turns/${id}/events?after=${after}`, { token });
    assert.equal(status, 200);
    events.push(...data.events);
    after = events.at(-1)?.seq ?? 0;
    if (data.status !== 'running') return { ...data, events };
    await pause(120);
  }
  assert.fail('agent turn did not finish');
}

function toolReply(name, args) {
  return { role: 'assistant', content: null, tool_calls: [
    { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ] };
}

async function writeSnapshot(db) {
  const { rows: [row] } = await db.owner.query(`SELECT
    (SELECT jsonb_agg(jsonb_build_object('account', account_id, 'revision', draft_revision) ORDER BY account_id)
      FROM dispatch.workspaces) AS workspaces,
    (SELECT jsonb_agg(jsonb_build_object('account', account_id, 'id', id, 'revision', status_revision) ORDER BY account_id, id)
      FROM dispatch.trips) AS trips,
    (SELECT count(*)::int FROM dispatch.request_results) AS "requestResults",
    (SELECT count(*)::int FROM dispatch.agent_events) AS "agentEvents",
    (SELECT count(*)::int FROM dispatch.materials) AS materials`);
  return row;
}

function adminAuth(token) {
  return `Bearer ${token}`;
}

test('admin token configuration requires at least 16 characters', () => {
  assert.equal(configuredAdminToken({}), undefined);
  assert.equal(configuredAdminToken({ DISPATCH_ADMIN_TOKEN: '   ' }), undefined);
  assert.equal(configuredAdminToken({ DISPATCH_ADMIN_TOKEN: ' 0123456789abcdef ' }), '0123456789abcdef');
  assert.throws(() => configuredAdminToken({ DISPATCH_ADMIN_TOKEN: 'short-token' }),
    /DISPATCH_ADMIN_TOKEN 长度须不少于 16 位/);
});

test('admin routes are closed by default and protect read-only APIs with a token', { timeout: 30_000 }, async t => {
  const db = await isolatedDatabase(t);
  const closed = await start(db);
  try {
    for (const path of ['/admin', '/admin/api/accounts', '/admin/api/prompts']) {
      const result = await closed.request(path);
      assert.equal(result.status, 404, path);
      assert.equal(result.data.error, 'not_found');
    }
  } finally {
    await closed.stop();
  }

  const token = 'test-admin-token-0123456789';
  const api = await start(db, { adminToken: token });
  try {
    const page = await api.request('/admin');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html; charset=utf-8$/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'unsafe-inline'/);
    assert.match(csp, /img-src 'self' blob: data:/);
    assert.match(csp, /connect-src 'self'/);
    assert.equal((await api.request('/admin', { method: 'POST' })).status, 405);

    const noAuth = await api.request('/admin/api/accounts');
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.data.error, 'admin_auth_required');
    assert.equal((await api.request('/admin/api/prompts', { authorization: adminAuth('wrong-token-0123456789') })).status, 401);
    assert.equal((await api.request('/admin/api/prompts', { authorization: adminAuth(token), method: 'POST' })).status, 405);

    const accounts = await api.request('/admin/api/accounts', { authorization: adminAuth(token) });
    assert.equal(accounts.status, 200);
    assert.deepEqual(accounts.data, { accounts: [] });
    const prompts = await api.request('/admin/api/prompts', { authorization: adminAuth(token) });
    assert.equal(prompts.status, 200);
    assert.equal(prompts.data.prompts.length, 7);
  } finally {
    await api.stop();
  }
});

test('admin scopes tolerate unfinished draft values and keep full missing prices honest', { timeout: 30_000 }, async t => {
  const db = await isolatedDatabase(t);
  const token = 'admin-dirty-draft-token-0123456789';
  const api = await start(db, { adminToken: token });
  try {
    const tokenA = await login(api, 'a');
    const draftA = await read(api, tokenA);
    const blankId = randomUUID();
    const invalidId = randomUUID();
    const missingId = randomUUID();
    const saveA = await api.request(`/v1/drafts/${draftA.id}`, { method: 'PUT', token: tokenA, body: {
      requestId: randomUUID(), revision: draftA.revision,
      customers: [{ id: randomUUID(), customer: '草稿客户', items: [
        { id: blankId, product: '', brand: '', specification: '', unit: '箱', quantity: '', price: null },
        { id: invalidId, product: '水饺', brand: '安井', specification: '500g', unit: '箱', quantity: '2', price: '82.' },
        { id: missingId, product: '春卷', brand: '安井', specification: '500g', unit: '袋', quantity: '3', price: null },
      ] }],
    } });
    assert.equal(saveA.status, 200, JSON.stringify(saveA.data));

    const tokenB = await login(api, 'b');
    const draftB = await read(api, tokenB);
    const saveB = await api.request(`/v1/drafts/${draftB.id}`, { method: 'PUT', token: tokenB, body: {
      requestId: randomUUID(), revision: draftB.revision,
      customers: [{ id: randomUUID(), customer: '全缺价客户', partyId: null, items: [
        { id: randomUUID(), product: '汤圆', brand: '安井', specification: '500g', unit: '箱', quantity: '2', price: null },
      ] }],
    } });
    assert.equal(saveB.status, 200, JSON.stringify(saveB.data));
    const unpriced = saveB.data.draft;
    const preview = await api.request('/v1/trips/preview', { method: 'POST', token: tokenB,
      body: { draftId: unpriced.id, revision: unpriced.revision, requestId: randomUUID() } });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const confirmed = await api.request('/v1/trips/confirm', { method: 'POST', token: tokenB,
      body: { previewId: preview.data.preview.previewId, requestId: randomUUID() } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));

    const { rows: [accountA] } = await db.owner.query(
      "SELECT id FROM dispatch.accounts WHERE identity_provider = 'development' AND identity_subject = 'a'");
    const { rows: [accountB] } = await db.owner.query(
      "SELECT id FROM dispatch.accounts WHERE identity_provider = 'development' AND identity_subject = 'b'");
    const before = await writeSnapshot(db);
    const auth = adminAuth(token);

    const draftScope = await api.request(`/admin/api/accounts/${accountA.id}/scopes/${draftA.id}`, { authorization: auth });
    assert.equal(draftScope.status, 200, JSON.stringify(draftScope.data));
    assert.equal(draftScope.data.document.type, 'draft');
    assert.equal(draftScope.data.document.dueCents, 0);
    assert.equal(draftScope.data.document.pendingPrices, 2);
    const lines = draftScope.data.document.customers[0].lines;
    const blank = lines.find(line => line.id === blankId);
    assert.equal(blank.blank, true);
    assert.equal(blank.amountCents, null);
    assert.equal(blank.receivedQuantity, null);
    const invalid = lines.find(line => line.id === invalidId);
    assert.equal(invalid.invalidPrice, '82.');
    assert.equal(invalid.unitPriceCents, null);
    assert.equal(invalid.amountCents, null);
    const missing = lines.find(line => line.id === missingId);
    assert.equal(missing.invalidPrice, undefined);
    assert.equal(missing.unitPriceCents, null);
    assert.equal(missing.amountCents, null);

    const tripScope = await api.request(`/admin/api/accounts/${accountB.id}/scopes/${confirmed.data.trip.id}`,
      { authorization: auth });
    assert.equal(tripScope.status, 200, JSON.stringify(tripScope.data));
    assert.equal(tripScope.data.document.dueCents, 0);
    assert.equal(tripScope.data.document.pendingPrices, 1);
    assert.equal(tripScope.data.document.customers[0].orderCents, 0);
    assert.equal(tripScope.data.document.customers[0].orderPendingPrices, 1);
    assert.equal(tripScope.data.document.customers[0].lines[0].unitPriceCents, null);
    assert.equal(tripScope.data.document.customers[0].lines[0].amountCents, null);

    const page = await api.request('/admin');
    assert.equal(page.status, 200);
    assert.equal(typeof page.data, 'string');
    assert.equal(page.data.includes('esc(money'), false);
    assert.equal(page.data.includes("accountId + ':' + id"), true);
    assert.equal(page.data.includes('URL.revokeObjectURL'), true);
    assert.ok((page.data.match(/clearMaterialUrls\(\)/g) || []).length >= 2);
    const start = page.data.indexOf('<script>') + 8;
    const end = page.data.lastIndexOf('</script>');
    assert.ok(start > 7 && end > start);
    new vm.Script(page.data.slice(start, end));

    assert.deepEqual(await writeSnapshot(db), before);
  } finally {
    await api.stop();
  }
});

test('admin reads two accounts, images, prompts and full harness events without writing', { timeout: 60_000 }, async t => {
  const db = await isolatedDatabase(t);
  const png = await readFile(resolve(__dirname, '../fixtures/s7d-unpriced-order.png'));
  const imageModel = async (_image, hooks) => {
    hooks.trace({ tool: 'extract_image', model: 'fixture-image', outcome: 'received_json',
      promptVersion: 's7d-image-v3', elapsedMs: 5, inputTokens: 30, outputTokens: 12 });
    return { operations: [{ action: 'add', customer: '李记', product: '春卷', quantity: '2', unit: '袋', price: '45' }],
      question: '' };
  };
  const agentModel = async (messages, _signal, record) => {
    const input = JSON.parse(messages.at(-1).content);
    const text = typeof input.text === 'string' ? input.text : '';
    const operation = text.includes('带鱼')
      ? { action: 'add', customer: '客户乙', product: '带鱼', quantity: '3', unit: '箱', price: '120' }
      : { action: 'add', customer: '老王', product: '水饺', quantity: '2', unit: '箱', price: '82' };
    const argumentsText = JSON.stringify({ operations: [operation] });
    record({ model: 'fixture-agent', promptVersion: 'a1-agent-v5', outcome: 'tool_calls', elapsedMs: 7,
      inputTokens: 100, outputTokens: 20, toolCalls: [{ name: 'edit_draft', arguments: argumentsText }] });
    return toolReply('edit_draft', { operations: [operation] });
  };
  const intentModel = async (_text, _context, _signal, record) => {
    record({ model: 'fixture-intent', promptVersion: 'a1-agent-v5', outcome: 'received_json', elapsedMs: 2,
      inputTokens: 40, outputTokens: 5 });
    return { draft: true, preview: false, query: false, answering: false };
  };
  const adminToken = 'admin-integration-token-0123456789';
  const api = await start(db, { imageModel, agentModel, intentModel, adminToken });
  let materialId;
  let tripId;
  let tokenA;
  let tokenB;
  try {
    tokenA = await login(api, 'a');
    tokenB = await login(api, 'b');

    let draft = await read(api, tokenA);
    const begun = await api.request('/v1/materials', { method: 'POST', token: tokenA, body: materialInput(draft, png, randomUUID()) });
    assert.equal(begun.status, 201);
    materialId = begun.data.material.id;
    const uploaded = await api.request(`/v1/materials/${materialId}/chunks`, { method: 'PUT', token: tokenA, chunk: png, offset: 0 });
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.data.material.status, 'ready');

    draft = await read(api, tokenA);
    const imageTurn = await api.request('/v1/agent/turns', { method: 'POST', token: tokenA,
      body: agentInput(draft, '', [materialId]) });
    assert.equal(imageTurn.status, 202);
    assert.equal((await waitForAgent(api, tokenA, imageTurn.data.turnId)).status, 'completed');

    draft = await read(api, tokenA);
    const textTurn = await api.request('/v1/agent/turns', { method: 'POST', token: tokenA,
      body: agentInput(draft, '老王订两箱水饺，82元一箱') });
    assert.equal(textTurn.status, 202);
    assert.equal((await waitForAgent(api, tokenA, textTurn.data.turnId)).status, 'completed');

    draft = await read(api, tokenA);
    const preview = await api.request('/v1/trips/preview', { method: 'POST', token: tokenA,
      body: { draftId: draft.id, revision: draft.revision, requestId: randomUUID() } });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const confirmed = await api.request('/v1/trips/confirm', { method: 'POST', token: tokenA,
      body: { previewId: preview.data.preview.previewId, requestId: randomUUID() } });
    assert.equal(confirmed.status, 200);
    tripId = confirmed.data.trip.id;
    const wang = confirmed.data.trip.versions[0].customers.find(customer => customer.customer === '老王');
    assert.ok(wang);
    const wangSheet = confirmed.data.sheets.find(sheet => sheet.sheetId === wang.id);
    assert.ok(wangSheet);
    const applied = await api.request(`/v1/trips/${tripId}/sheets/${encodeURIComponent(wangSheet.sheetId)}/delivery/apply`, {
      method: 'POST', token: tokenA,
      body: { requestId: randomUUID(), version: 1, statusRevision: confirmed.data.trip.statusRevision,
        complete: false, edits: [{ lineId: wang.items[0].id, receivedQuantity: 1, price: '80.00' }] },
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.equal(applied.data.sheet.lines[0].receivedQuantity, 1);

    const { rows: [accountA] } = await db.owner.query(
      "SELECT id FROM dispatch.accounts WHERE identity_provider = 'development' AND identity_subject = 'a'");
    const { rows: [accountB] } = await db.owner.query(
      "SELECT id FROM dispatch.accounts WHERE identity_provider = 'development' AND identity_subject = 'b'");
    const { rows: [li] } = await db.owner.query(
      'SELECT id FROM dispatch.parties WHERE account_id = $1 AND name = $2', [accountA.id, '李记']);
    await db.owner.query(`INSERT INTO dispatch.customer_aliases (account_id, customer_id, alias, normalized_alias)
      VALUES ($1, $2, $3, $4)`, [accountA.id, li.id, '老李', '老李']);

    const draftB = await read(api, tokenB);
    const turnB = await api.request('/v1/agent/turns', { method: 'POST', token: tokenB,
      body: agentInput(draftB, '客户乙订三箱带鱼，120元一箱') });
    assert.equal(turnB.status, 202);
    assert.equal((await waitForAgent(api, tokenB, turnB.data.turnId)).status, 'completed');

    const before = await writeSnapshot(db);
    const auth = adminAuth(adminToken);

    const accounts = await api.request('/admin/api/accounts', { authorization: auth });
    assert.equal(accounts.status, 200);
    assert.equal(accounts.data.accounts.length, 2);
    const summaryA = accounts.data.accounts.find(account => account.id === accountA.id);
    const summaryB = accounts.data.accounts.find(account => account.id === accountB.id);
    assert.equal(summaryA.subject, 'a');
    assert.equal(summaryA.tripCount, 1);
    assert.equal(summaryA.partyCount, 2);
    assert.equal(summaryA.aliasCount, 1);
    assert.equal(summaryA.turnCount, 2);
    assert.equal(summaryA.draftConfirmed, true);
    assert.ok(summaryA.lastTurnAt);
    assert.equal(summaryB.subject, 'b');
    assert.equal(summaryB.tripCount, 0);
    assert.equal(summaryB.partyCount, 0);
    assert.equal(summaryB.aliasCount, 0);
    assert.equal(summaryB.turnCount, 1);
    assert.equal(summaryB.draftConfirmed, false);

    const overview = await api.request(`/admin/api/accounts/${accountA.id}/overview`, { authorization: auth });
    assert.equal(overview.status, 200);
    assert.equal(overview.data.draft.id, tripId);
    assert.equal(overview.data.draftConfirmed, true);
    assert.equal(overview.data.trips.length, 1);
    assert.equal(overview.data.trips[0].id, tripId);
    assert.equal(overview.data.trips[0].customers, 2);
    assert.equal(overview.data.trips[0].lines, 2);
    assert.equal(overview.data.trips[0].delivered, 0);
    assert.equal(overview.data.trips[0].turnCount, 2);
    assert.equal(overview.data.trips[0].pendingPrices, 0);
    assert.equal(overview.data.trips[0].totalCents, 17000);
    assert.equal(overview.data.parties.length, 2);
    assert.equal(overview.data.aliases.length, 1);
    assert.equal(overview.data.aliases[0].alias, '老李');
    assert.equal(overview.data.aliases[0].canonicalName, '李记');

    const scope = await api.request(`/admin/api/accounts/${accountA.id}/scopes/${tripId}`, { authorization: auth });
    assert.equal(scope.status, 200);
    assert.equal(scope.data.document.type, 'trip');
    assert.equal(scope.data.document.dueCents, 17000);
    assert.equal(scope.data.document.customers.length, 2);
    const scopeWang = scope.data.document.customers.find(customer => customer.customer === '老王');
    assert.equal(scopeWang.lines[0].receivedQuantity, 1);
    assert.equal(scopeWang.lines[0].unitPriceCents, 8000);
    assert.equal(scopeWang.lines[0].amountCents, 8000);
    assert.equal(scope.data.turns.length, 2);
    assert.equal(scope.data.turns[1].startRevision < scope.data.turns[1].endRevision, true);
    const modelEvents = scope.data.turns.flatMap(turn => turn.events.filter(event => event.kind === 'model'));
    assert.ok(modelEvents.length >= 3);
    assert.ok(modelEvents.some(event => event.payload.toolCalls?.[0]?.name === 'edit_draft'));
    assert.ok(modelEvents.some(event => event.payload.promptVersion === 's7d-image-v3'));
    assert.equal(scope.data.stats.turns, 2);
    assert.equal(scope.data.stats.completed, 2);
    assert.equal(scope.data.stats.modelCalls, 3);
    assert.equal(scope.data.stats.inputTokens, 170);
    assert.equal(scope.data.stats.outputTokens, 37);
    assert.ok(scope.data.stats.medianModelMs > 0);
    assert.deepEqual(scope.data.stats.promptVersions.sort(), ['a1-agent-v5', 's7d-image-v3']);
    assert.equal(JSON.stringify(scope.data).includes('带鱼'), false);
    assert.equal(JSON.stringify(scope.data).includes('客户乙'), false);

    const scopeB = await api.request(`/admin/api/accounts/${accountB.id}/scopes/${draftB.id}`, { authorization: auth });
    assert.equal(scopeB.status, 200);
    assert.equal(scopeB.data.document.type, 'draft');
    assert.ok(JSON.stringify(scopeB.data).includes('带鱼'));
    assert.equal(JSON.stringify(scopeB.data).includes('水饺'), false);
    assert.equal(JSON.stringify(scopeB.data).includes('李记'), false);

    assert.equal((await api.request(`/admin/api/accounts/${accountA.id}/scopes/${draftB.id}`, { authorization: auth })).status, 404);

    const conversation = await api.request('/v1/agent/conversation', { token: tokenA });
    assert.equal(conversation.status, 200);
    assert.equal(JSON.stringify(conversation.data).includes('"kind":"model"'), false);
    assert.equal(JSON.stringify(conversation.data).includes('toolCalls'), false);

    const image = await fetch(`${api.origin}/admin/api/accounts/${accountA.id}/materials/${materialId}/content`,
      { headers: { authorization: auth } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('cache-control'), 'no-store');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal((await fetch(`${api.origin}/admin/api/accounts/${accountB.id}/materials/${materialId}/content`,
      { headers: { authorization: auth } })).status, 404);

    const prompts = await api.request('/admin/api/prompts', { authorization: auth });
    assert.equal(prompts.status, 200);
    assert.equal(prompts.data.prompts.length, 7);
    const versions = prompts.data.prompts.map(entry => entry.version);
    for (const version of ['s7d-text-v3', 's7d-image-v3', 'a1-agent-v5', 'a2-delivery-v3']) {
      assert.ok(versions.includes(version), version);
    }
    assert.equal(prompts.data.prompts.find(entry => entry.id === 'text-order').prompts[0].text, textPrompt);
    assert.deepEqual(prompts.data.prompts.find(entry => entry.id === 'a2-candidate').tools, deliveryTools);

    assert.deepEqual(await writeSnapshot(db), before);
  } finally {
    await api.stop();
  }
});
