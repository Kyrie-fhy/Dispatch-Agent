const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { isDeepStrictEqual } = require('node:util');
const { Pool } = require('pg');
const { databaseOptions } = require('../../code/server-dist/server/database');
const { migrate } = require('../../code/server-dist/server/migrate');
const { startLocalServer } = require('../../code/server-dist/server/main');
const { configuredWechatLogin } = require('../../code/server-dist/server/wechat-login');
const { configuredImageModel, configuredTextModel, imagePromptVersion, textPromptVersion } = require('../../code/server-dist/server/text-model');
const { configuredSpeechModel } = require('../../code/server-dist/server/voice');
const { HttpError } = require('../../code/server-dist/server/http-error');
const s6 = require('../fixtures/s6-text-cases.cjs');
const { materialChunkBytes } = require('../../code/server-dist/miniprogram/core/materials');

async function isolatedDatabase(t, beforeMigrate) {
  const url = new URL(process.env.DISPATCH_TEST_ADMIN_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'The test cluster must be local');
  const name = `dispatch_test_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const admin = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  let migrationPool;
  const services = new Set();
  t.after(async () => {
    try {
      for (const stop of services) await stop();
      await migrationPool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
    } finally {
      await admin.end();
    }
  });
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  url.pathname = `/${name}`;
  migrationPool = new Pool({ connectionString: url.href });
  if (beforeMigrate) await beforeMigrate(migrationPool, name);
  await migrate(migrationPool);
  await migrate(migrationPool);
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
  await admin.query(`GRANT dispatch_app TO ${name}`);
  url.username = name;
  url.password = password;

  return { name, appUrl: url.href, admin: migrationPool, services,
    pool: () => new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }) };
}

function runPostgresClient(tool, database, args, input) {
  assert.match(database, /^dispatch_test_[0-9a-f]{16}$/);
  const url = new URL(process.env.DISPATCH_TEST_ADMIN_URL);
  const container = process.env.DISPATCH_TEST_PG_CONTAINER;
  const connection = {
    PGHOST: container ? '127.0.0.1' : url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: container ? '5432' : (url.port || '5432'),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
    PGSSLMODE: url.searchParams.get('sslmode') ?? 'prefer',
    PGCONNECT_TIMEOUT: '5',
  };
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  const directory = process.env.DISPATCH_TEST_PG_BIN;
  const options = { input, env: { ...environment, ...connection }, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 };
  const argumentsForTool = ['--no-password', ...args];
  const result = container
    ? spawnSync('docker', ['exec', '-i', ...Object.keys(connection).flatMap(key => ['-e', key]), container, tool, ...argumentsForTool], options)
    : spawnSync(directory ? resolve(directory, tool) : tool, argumentsForTool, options);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${tool} failed: ${result.stderr.toString()}`);
  return result.stdout;
}

async function start(db, wechat, textModel, imageModel, speechModel) {
  const pool = db.pool();
  let server;
  try {
    server = await startLocalServer(pool, 0, wechat, textModel, imageModel, speechModel);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const origin = `http://127.0.0.1:${server.address().port}`;

  const stop = async () => {
    db.services.delete(stop);
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeIdleConnections();
    try { await closed; } finally { await pool.end(); }
  };
  db.services.add(stop);

  return {
    origin,
    async request(path, { method = 'GET', token, body, chunk, offset, headers: extraHeaders } = {}) {
      const headers = { ...extraHeaders };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (chunk) {
        headers['content-type'] ??= 'application/octet-stream';
        if (offset !== undefined) headers['x-material-offset'] = String(offset);
      }
      const response = await fetch(origin + path, {
        method, headers, body: chunk ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      return { status: response.status, data: response.status === 204 ? null : await response.json() };
    },
    stop,
  };
}

test('trial API uses local PostgreSQL with a restricted role and disables development login', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const url = new URL(db.appUrl);
  url.search = '?sslmode=disable';
  const env = { DISPATCH_SERVER_MODE: 'trial', DISPATCH_DB_URL: url.href,
    DISPATCH_WECHAT_APP_ID: 'wx1111111111111111', DISPATCH_WECHAT_APP_SECRET: 'trial-test-secret' };
  const pool = () => new Pool(databaseOptions('DISPATCH_DB_URL', env));
  const api = await start({ ...db, pool }, configuredWechatLogin(env));
  assert.deepEqual(await api.request('/healthz'), { status: 200, data: { status: 'ready' } });
  const { rows } = await db.admin.query(`
    SELECT ssl FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE usename = $1 AND datname = $1`, [db.name]);
  assert.deepEqual(rows, [{ ssl: false }]);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(`${api.origin}/healthz`, { headers: { Host: 'dispatch-api.example.com' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus, 400);
  assert.equal((await api.request('/v1/session/development', { method: 'POST', body: { account: 'a' } })).status, 404);
  assert.equal((await api.request('/v1/session/wechat', { method: 'POST', body: {} })).status, 400);
});

function materialInput(draft, payload, requestId) {
  return { draftId: draft.id, revision: draft.revision, requestId, name: '材料.png', size: payload.length,
    digest: createHash('sha256').update(payload).digest('hex') };
}

test('materials resume after interruption and restart with account and draft revision checks', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  let api = await start(db);
  let a = await login(api, 'a');
  const b = await login(api, 'b');
  const draft = await read(api, a);
  const contents = randomBytes(2 * materialChunkBytes + 7);
  const transfer = materialInput(draft, contents, 'material-a');
  const begin = (token, body) => api.request('/v1/materials', { method: 'POST', token, body });
  const rejected = await begin(a, { ...transfer, name: '材料.mp3' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.error, 'invalid_material');
  assert.deepEqual((await api.request('/v1/materials', { token: a })).data, { materials: [] });
  assert.equal((await begin(b, transfer)).status, 404);
  const started = await begin(a, transfer);
  assert.equal(started.status, 201);
  assert.equal(started.data.material.draftCurrent, true);
  assert.deepEqual(await begin(a, transfer), started);
  assert.equal((await begin(a, { ...transfer, name: '换文件.png' })).data.error, 'request_conflict');
  const path = `/v1/materials/${started.data.material.id}`;
  const readMaterial = (token = a) => api.request(path, { token });
  const put = (offset, chunk, token = a) => api.request(path + '/chunks', { method: 'PUT', token, offset, chunk });
  const first = contents.subarray(0, materialChunkBytes);
  const second = contents.subarray(materialChunkBytes, 2 * materialChunkBytes);
  const last = contents.subarray(2 * materialChunkBytes);
  assert.equal((await readMaterial(b)).status, 404);
  assert.deepEqual((await api.request('/v1/materials', { token: b })).data, { materials: [] });
  assert.equal((await put(0, first, b)).status, 404);
  assert.equal((await put(materialChunkBytes, second)).data.error, 'material_offset');
  const written = await put(0, first);
  assert.equal(written.status, 200);
  assert.equal(written.data.material.received, first.length);
  assert.deepEqual(await put(0, first), written);
  assert.equal((await put(0, Buffer.alloc(first.length))).data.error, 'material_chunk_conflict');

  await new Promise((resolve, reject) => {
    const request = http.request(api.origin + path + '/chunks', { method: 'PUT', headers: {
      authorization: `Bearer ${a}`, 'content-type': 'application/octet-stream', 'content-length': second.length,
      'x-material-offset': first.length,
    } });
    request.on('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
    request.on('close', resolve);
    request.write(second.subarray(0, 350), () => request.destroy());
  });
  assert.deepEqual(await readMaterial(), written);
  await api.stop();
  api = await start(db);
  a = await login(api, 'a');
  assert.equal((await readMaterial()).data.material.received, first.length);
  assert.equal((await save(api, a, draft, 'material-draft-edit', '材料保存后修改')).status, 200);
  assert.equal((await begin(a, { ...transfer, requestId: 'old-revision' })).data.error, 'material_draft_changed');
  assert.equal((await begin(a, transfer)).data.material.draftCurrent, false);
  assert.equal((await put(first.length, second)).data.material.received, first.length + second.length);
  assert.equal((await put(first.length + second.length, Buffer.alloc(last.length))).data.error, 'material_digest');
  assert.equal((await readMaterial()).data.material.received, first.length + second.length);

  const finish = await put(first.length + second.length, last);
  assert.equal(finish.status, 200);
  assert.equal(finish.data.material.status, 'ready');
  assert.equal(finish.data.material.draftCurrent, false);
  assert.deepEqual(await put(first.length + second.length, last), finish);
  const { rows } = await db.admin.query('SELECT content FROM dispatch.material_chunks ORDER BY byte_offset');
  assert.deepEqual(Buffer.concat(rows.map(row => row.content)), contents);
  assert.equal((await read(api, a)).customers[0].customer, '材料保存后修改');
});

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

function save(api, token, draft, requestId, customerName) {
  const customers = draft.customers.map((customer, index) => index === 0 ? { ...customer, customer: customerName } : customer);
  return api.request(`/v1/drafts/${draft.id}`, {
    method: 'PUT', token, body: { requestId, revision: draft.revision, customers },
  });
}

test('PostgreSQL persists each account draft across server restart and blocks cross-account access', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  let api = await start(db);
  await assert.rejects(startLocalServer(db.admin, 0), /非管理员数据库账号/);

  assert.deepEqual(await api.request('/healthz'), { status: 200, data: { status: 'ready' } });
  assert.equal((await api.request('/v1/workspace')).status, 401);
  assert.equal((await api.request('/v1/session/development', { method: 'POST', body: { account: 'c' } })).status, 400);
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const draftA = await read(api, a);
  const draftB = await read(api, b);
  assert.notEqual(draftA.id, draftB.id);

  // The same request ID is independent in each account.
  const savedA = await save(api, a, draftA, 'first', '客户甲');
  assert.equal(savedA.status, 200);
  assert.equal((await save(api, b, draftB, 'first', '客户乙')).status, 200);
  assert.equal((await api.request(`/v1/drafts/${draftA.id}`, { token: b })).status, 404);
  assert.equal((await save(api, b, draftA, 'wrong-account', '意外覆盖')).status, 404);

  const accounts = await db.admin.query("SELECT id, identity_subject FROM dispatch.accounts ORDER BY identity_subject");
  const direct = db.pool();
  try {
    const client = await direct.connect();
    try {
      assert.deepEqual((await client.query('SELECT draft_id FROM dispatch.workspaces')).rows, []);
      await client.query('BEGIN');
      await client.query("SELECT set_config('dispatch.account_id', $1, true)", [accounts.rows[0].id]);
      assert.deepEqual((await client.query('SELECT draft_id FROM dispatch.workspaces')).rows, [{ draft_id: draftA.id }]);
      assert.equal((await client.query('SELECT request_id FROM dispatch.request_results')).rowCount, 1);
      const untouched = await client.query('UPDATE dispatch.workspaces SET draft_revision = 200 WHERE draft_id = $1', [draftB.id]);
      assert.equal(untouched.rowCount, 0);
      await client.query('COMMIT');
      assert.deepEqual((await client.query('SELECT draft_id FROM dispatch.workspaces')).rows, []);
    } finally {
      client.release();
    }
  } finally {
    await direct.end();
  }

  await api.stop();
  api = await start(db);
  const resumed = await login(api, 'a');
  assert.notEqual(resumed, a);
  assert.equal((await read(api, resumed)).customers[0].customer, '客户甲');
  assert.deepEqual(await save(api, resumed, draftA, 'first', '客户甲'), savedA);
  assert.equal((await read(api, resumed)).revision, 1);
  assert.equal((await read(api, b)).customers[0].customer, '客户乙');
  assert.equal((await api.request('/v1/session', { method: 'DELETE', token: resumed })).status, 204);
  assert.equal((await api.request('/v1/workspace', { token: resumed })).status, 401);
});

test('draft saves retry once, reject stale revisions and roll back when the result cannot be recorded', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db);
  const a = await login(api, 'a');
  const initial = await read(api, a);

  const attempted = await Promise.all([
    save(api, a, initial, 'edit-1', '第一页'),
    save(api, a, initial, 'edit-2', '第二页'),
  ]);
  assert.deepEqual(attempted.map(result => result.status).sort(), [200, 409]);
  const index = attempted.findIndex(result => result.status === 200);
  const winner = attempted[index];
  assert.equal(attempted[1 - index].data.error, 'draft_changed');
  const replay = await save(api, a, initial, `edit-${index + 1}`, winner.data.draft.customers[0].customer);
  assert.deepEqual(replay, winner);
  const changed = await save(api, a, initial, `edit-${index + 1}`, '不同内容');
  assert.equal(changed.status, 409);
  assert.equal(changed.data.error, 'request_conflict');

  // Fail the second write of the transaction after the updated draft would have been written.
  await db.admin.query("ALTER TABLE dispatch.request_results ADD CONSTRAINT test_write_failure CHECK (request_id <> 'try-again')");
  const failed = await save(api, a, winner.data.draft, 'try-again', '恢复后的编辑');
  assert.equal(failed.status, 500);
  assert.deepEqual(await read(api, a), winner.data.draft);
  await db.admin.query('ALTER TABLE dispatch.request_results DROP CONSTRAINT test_write_failure');
  const retried = await save(api, a, winner.data.draft, 'try-again', '恢复后的编辑');
  assert.equal(retried.status, 200);
  assert.equal(retried.data.draft.revision, 2);
  assert.equal(retried.data.draft.customers[0].customer, '恢复后的编辑');
});

function line(id, brand, unit, quantity, price) {
  return { id, product: '水饺', brand, specification: '500g', unit, quantity, price };
}

function exampleCustomers(price = '82') {
  return [
    { id: 'sheet-a', customer: '客户 A', partyId: null, items: [line('line-a', '安井', '箱', '2', price)] },
    { id: 'sheet-b', customer: '客户 B', partyId: null, items: [
      line('line-b-box', '安井', '箱', '3', '80'), line('line-b-bag', '安井', '袋', '3', '20'),
    ] },
    { id: 'sheet-c', customer: '客户 C', partyId: null, items: [line('line-c', '三全', '箱', '1', '75')] },
  ];
}

async function putCustomers(api, token, draft, requestId, customers) {
  const result = await api.request(`/v1/drafts/${draft.id}`, {
    method: 'PUT', token, body: { requestId, revision: draft.revision, customers },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.draft;
}

function tripCommand(api, token, action, body) {
  return api.request(`/v1/trips/${action}`, { method: 'POST', token, body });
}

function preview(api, token, draft, requestId) {
  return tripCommand(api, token, 'preview', { draftId: draft.id, revision: draft.revision, requestId });
}

function confirm(api, token, previewId, requestId) {
  return tripCommand(api, token, 'confirm', { previewId, requestId });
}

test('upgraded drafts preview the saved revision and concurrent confirms create one formal trip', { timeout: 20_000 }, async t => {
  const existingDraft = { id: randomUUID(), revision: 4, customers: exampleCustomers('78') };
  const db = await isolatedDatabase(t, async admin => {
    await admin.query(`CREATE SCHEMA dispatch;
      CREATE TABLE dispatch.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const path = resolve(__dirname, '../../code/server/migrations/001_drafts.sql');
    await admin.query(await readFile(path, 'utf8'));
    await admin.query("INSERT INTO dispatch.schema_migrations (name) VALUES ('001_drafts.sql')");
    const account = randomUUID();
    await admin.query("INSERT INTO dispatch.accounts VALUES ($1, 'development', 'a')", [account]);
    await admin.query('INSERT INTO dispatch.workspaces (account_id, draft_id, draft_revision, draft_customers) VALUES ($1, $2, $3, $4)',
      [account, existingDraft.id, existingDraft.revision, JSON.stringify(existingDraft.customers)]);
  });

  let api = await start(db);
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const original = await read(api, a);
  assert.deepEqual(original, existingDraft);
  const old = await preview(api, a, original, 'old-preview');
  assert.equal(old.status, 200);
  assert.equal(old.data.preview.totalCents, 53100);
  assert.deepEqual(old.data.preview.choices, [null, null, null]);
  assert.equal((await api.request(`/v1/trips/${original.id}`, { token: a })).status, 404);
  const unconfirmed = (await api.request('/v1/workspace', { token: a })).data;
  assert.equal(unconfirmed.currentTrip, null);
  assert.equal(unconfirmed.draftConfirmed, false);
  assert.deepEqual(unconfirmed.parties, []);
  assert.equal((await db.admin.query('SELECT 1 FROM dispatch.sheets')).rowCount, 0);

  const updated = await putCustomers(api, a, original, 'update-price', exampleCustomers());
  const stale = await confirm(api, a, old.data.preview.previewId, 'stale-confirm');
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'draft_changed');
  const next = await preview(api, a, updated, 'new-preview');
  assert.equal(next.status, 200);
  assert.equal(next.data.preview.totalCents, 53900);
  const currentPreview = next.data.preview.previewId;
  assert.equal((await preview(api, a, updated, 'same-version')).data.preview.previewId, currentPreview);
  assert.equal((await confirm(api, b, currentPreview, 'wrong-account')).status, 404);

  const results = await Promise.all([
    confirm(api, a, currentPreview, 'confirm-trip-a'),
    confirm(api, a, currentPreview, 'confirm-trip-a'),
    confirm(api, a, currentPreview, 'confirm-trip-b'),
  ]);
  for (const result of results) {
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.deepEqual(result.data, results[0].data);
  }
  const firstTrip = results[0].data;
  assert.equal(firstTrip.trip.id, updated.id);
  assert.equal(firstTrip.trip.versions.length, 1);
  assert.equal(firstTrip.trip.versions[0].totalCents, 53900);
  assert.deepEqual(firstTrip.trip.statuses, {
    'line-a': 'pending', 'line-b-box': 'pending', 'line-b-bag': 'pending', 'line-c': 'pending',
  });
  assert.deepEqual(firstTrip.picking.map(({ brand, unit, quantity }) => [brand, unit, quantity]),
    [['安井', '箱', 5], ['安井', '袋', 3], ['三全', '箱', 1]]);
  assert.equal((await db.admin.query('SELECT 1 FROM dispatch.trips')).rowCount, 1);
  assert.equal((await db.admin.query('SELECT 1 FROM dispatch.trip_versions')).rowCount, 1);
  assert.equal((await db.admin.query('SELECT 1 FROM dispatch.parties')).rowCount, 3);
  assert.equal((await api.request(`/v1/trips/${original.id}`, { token: b })).status, 404);
  assert.equal((await confirm(api, a, old.data.preview.previewId, 'old-after-confirm')).status, 409);
  const locked = await save(api, a, updated, 'write-confirmed', '误改草稿');
  assert.equal(locked.status, 409);
  assert.equal(locked.data.error, 'draft_confirmed');

  await api.stop();
  api = await start(db);
  assert.deepEqual((await api.request(`/v1/trips/${updated.id}`, { token: a })).data, firstTrip);
  const workspace = (await api.request('/v1/workspace', { token: a })).data;
  assert.equal(workspace.draftConfirmed, true);
  assert.deepEqual(workspace.currentTrip, { id: updated.id, version: 1, totalCents: 53900 });

  const body = { draftId: updated.id, requestId: 'next-trip' };
  const fresh = await tripCommand(api, a, 'next-draft', body);
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.data.draft.id, updated.id);
  assert.equal(fresh.data.draft.revision, 0);
  assert.deepEqual(await tripCommand(api, a, 'next-draft', body), fresh);
  assert.equal((await api.request('/v1/workspace', { token: a })).data.currentTrip.id, updated.id);
  assert.deepEqual((await confirm(api, a, currentPreview, 'confirm-after-next')).data, firstTrip);
  const priorPartyId = firstTrip.sheets.find(sheet => sheet.sheetId === 'sheet-a').partyId;

  const bDraft = await read(api, b);
  const unauthorizedCustomer = await api.request(`/v1/drafts/${bDraft.id}`, {
    method: 'PUT', token: b, body: { revision: bDraft.revision, requestId: 'wrong-party',
      customers: [{ ...exampleCustomers()[0], partyId: priorPartyId }] },
  });
  assert.equal(unauthorizedCustomer.status, 400);
  assert.equal(unauthorizedCustomer.data.error, 'invalid_customer');
  assert.deepEqual((await api.request('/v1/workspace', { token: b })).data.parties, []);

  const [customerA] = exampleCustomers();
  const linked = await putCustomers(api, a, fresh.data.draft, 'write-next', [
    { ...customerA, partyId: priorPartyId },
    { ...customerA, id: 'same-name', items: [line('same-name-line', '安井', '箱', '1', '82')] },
  ]);
  const linkedPreview = await preview(api, a, linked, 'preview-linked');
  assert.equal(linkedPreview.status, 200);
  assert.equal(linkedPreview.data.preview.choices[0].id, priorPartyId);
  const linkedTrip = await confirm(api, a, linkedPreview.data.preview.previewId, 'confirmed-linked');
  assert.equal(linkedTrip.status, 200);
  assert.equal(linkedTrip.data.sheets.find(sheet => sheet.sheetId === 'sheet-a').partyId, priorPartyId);
  assert.notEqual(linkedTrip.data.sheets.find(sheet => sheet.sheetId === 'same-name').partyId, priorPartyId);
  assert.equal((await db.admin.query("SELECT 1 FROM dispatch.parties WHERE name = '客户 A'")).rowCount, 2);
});

test('a failed formal commit leaves the draft editable and no official snapshot, customer or sheet', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db);
  const a = await login(api, 'a');
  const original = await read(api, a);
  assert.equal((await preview(api, a, original, 'empty-draft')).status, 400);

  const customers = exampleCustomers();
  const [first, ...remaining] = customers;
  const noChoice = await putCustomers(api, a, original, 'no-choice', [
    { id: first.id, customer: first.customer, items: first.items }, ...remaining,
  ]);
  const rejected = await preview(api, a, noChoice, 'requires-identity');
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.message, /选择已有客户或新建/);
  const saved = await putCustomers(api, a, noChoice, 'save-trip', customers);
  const review = await preview(api, a, saved, 'preview-valid');
  assert.equal(review.status, 200);
  const previewId = review.data.preview.previewId;
  await db.admin.query("ALTER TABLE dispatch.request_results ADD CONSTRAINT test_confirm_failure CHECK (request_id <> 'retry-formal')");
  const failed = await confirm(api, a, previewId, 'retry-formal');
  assert.equal(failed.status, 500);
  assert.equal((await api.request(`/v1/trips/${saved.id}`, { token: a })).status, 404);
  const workspace = (await api.request('/v1/workspace', { token: a })).data;
  assert.equal(workspace.draftConfirmed, false);
  assert.equal(workspace.currentTrip, null);
  assert.deepEqual(workspace.draft, saved);
  assert.deepEqual(workspace.parties, []);
  for (const table of ['trips', 'trip_versions', 'parties', 'sheets']) {
    assert.equal((await db.admin.query(`SELECT 1 FROM dispatch.${table}`)).rowCount, 0);
  }

  await db.admin.query('ALTER TABLE dispatch.request_results DROP CONSTRAINT test_confirm_failure');
  const retried = await confirm(api, a, previewId, 'retry-formal');
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
  assert.equal(retried.data.trip.versions[0].totalCents, 53900);
  assert.deepEqual(await confirm(api, a, previewId, 'retry-formal'), retried);
});

async function formalExample(api, token) {
  const draft = await putCustomers(api, token, await read(api, token), 'save-example', exampleCustomers());
  const reviewed = await preview(api, token, draft, 'example-preview');
  assert.equal(reviewed.status, 200);
  const formal = await confirm(api, token, reviewed.data.preview.previewId, 'confirm-example');
  assert.equal(formal.status, 200);
  return formal.data;
}

function sheetEndpoint(api, token, tripId, sheetId) {
  const path = `/v1/trips/${tripId}/sheets/${encodeURIComponent(sheetId)}`;
  return (action, body) => api.request(action ? `${path}/${action}` : path, {
    token, method: body === undefined ? 'GET' : 'POST', body,
  });
}

async function deliverAndReview(sheet, requestPrefix, statusRevision = 0) {
  const basis = { version: 1, statusRevision };
  const marked = await sheet('delivery', { ...basis, requestId: `${requestPrefix}-delivery`, lineId: null, status: 'delivered' });
  assert.equal(marked.status, 200, JSON.stringify(marked.data));
  const checked = await sheet('review', { ...basis, requestId: `${requestPrefix}-review`, statusRevision: marked.data.sheet.statusRevision });
  assert.equal(checked.status, 200, JSON.stringify(checked.data));
  return checked.data.sheet;
}

test('delivery and review exclude the three undelivered bags without changing the formal order', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  let api = await start(db);
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const formal = await formalExample(api, a);
  const tripId = formal.trip.id;
  const sheetB = sheetEndpoint(api, a, tripId, 'sheet-b');
  const initial = await sheetB();
  assert.equal(initial.status, 200);
  assert.equal(initial.data.sheet.orderCents, 30000);
  assert.equal(initial.data.sheet.amounts.due, 0);
  assert.equal(initial.data.sheet.reviewed, false);

  const boxes = { requestId: 'deliver-boxes', version: 1, statusRevision: 0, lineId: 'line-b-box', status: 'delivered' };
  const otherAccount = sheetEndpoint(api, b, tripId, 'sheet-b');
  assert.equal((await otherAccount()).status, 404);
  assert.equal((await otherAccount('delivery', boxes)).status, 404);
  const wrongLine = await sheetB('delivery', { ...boxes, lineId: 'line-a' });
  assert.equal(wrongLine.status, 404);
  const delivered = await sheetB('delivery', boxes);
  assert.equal(delivered.status, 200);
  assert.equal(delivered.data.sheet.statusRevision, 1);
  assert.equal(delivered.data.sheet.reviewed, false);
  assert.deepEqual(await sheetB('delivery', boxes), delivered);
  assert.equal((await sheetB('delivery', { ...boxes, lineId: 'line-b-bag' })).data.error, 'request_conflict');
  const stale = await sheetB('review', { requestId: 'review-b', version: 1, statusRevision: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'delivery_changed');

  const review = { requestId: 'review-b', version: 1, statusRevision: 1 };
  assert.equal((await otherAccount('review', review)).status, 404);
  await db.admin.query("ALTER TABLE dispatch.request_results ADD CONSTRAINT test_review_failure CHECK (request_id <> 'review-b')");
  assert.equal((await sheetB('review', review)).status, 500);
  assert.equal((await sheetB()).data.sheet.reviewed, false);
  await db.admin.query('ALTER TABLE dispatch.request_results DROP CONSTRAINT test_review_failure');
  const reviewed = await sheetB('review', review);
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.data.sheet.reviewed, true);
  assert.deepEqual(reviewed.data.sheet.lines.map(line => [line.id, line.status]), [
    ['line-b-box', 'delivered'], ['line-b-bag', 'pending'],
  ]);
  assert.deepEqual(reviewed.data.sheet.amounts, { due: 24000, paid: 0, remaining: 24000, excess: 0 });
  assert.deepEqual(await sheetB('review', review), reviewed);

  await api.stop();
  api = await start(db);
  const resumed = await login(api, 'a');
  assert.deepEqual(await sheetEndpoint(api, resumed, tripId, 'sheet-b')(), reviewed);
  const after = (await api.request(`/v1/trips/${tripId}`, { token: resumed })).data;
  assert.deepEqual(after.trip.versions, formal.trip.versions);
  assert.deepEqual(after.picking, formal.picking);
  assert.deepEqual(after.trip.statuses, { ...formal.trip.statuses, 'line-b-box': 'delivered' });
  assert.deepEqual(after.sheets.filter(sheet => sheet.reviewed).map(sheet => sheet.sheetId), ['sheet-b']);
});

test('reviewed delivery changes require a fresh and scoped preview and commit once', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db);
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const { trip: { id } } = await formalExample(api, a);
  const sheetA = sheetEndpoint(api, a, id, 'sheet-a');
  const sheetB = sheetEndpoint(api, a, id, 'sheet-b');
  const all = { requestId: 'deliver-b', version: 1, statusRevision: 0, lineId: null, status: 'delivered' };
  const delivered = await sheetB('delivery', all);
  assert.equal(delivered.status, 200);
  assert.equal(delivered.data.sheet.amounts.due, 30000);
  assert.ok(delivered.data.sheet.lines.every(line => line.status === 'delivered'));
  assert.equal((await sheetA()).data.sheet.lines[0].status, 'pending');
  assert.equal((await sheetB('review', { requestId: 'review-b', version: 1, statusRevision: 1 })).status, 200);

  const undo = { requestId: 'preview-undo-bags', version: 1, statusRevision: 1, lineId: 'line-b-bag', status: 'pending' };
  const rejected = await sheetB('delivery', undo);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.error, 'delivery_preview_required');
  const planned = await sheetB('delivery/preview', undo);
  assert.equal(planned.status, 200);
  assert.equal(planned.data.preview.before.due, 30000);
  assert.equal(planned.data.preview.after.due, 24000);
  assert.equal((await sheetB()).data.sheet.amounts.due, 30000);
  const attempt = { requestId: 'confirm-undo', previewId: planned.data.preview.previewId };
  assert.equal((await sheetA('delivery/confirm', attempt)).status, 404);
  assert.equal((await sheetEndpoint(api, b, id, 'sheet-b')('delivery/confirm', attempt)).status, 404);

  const candidates = await Promise.all([
    sheetA('delivery', { ...all, requestId: 'concurrent-a', statusRevision: 1 }),
    sheetA('delivery', { ...all, requestId: 'concurrent-a-line', statusRevision: 1, lineId: 'line-a' }),
  ]);
  assert.deepEqual(candidates.map(result => result.status).sort(), [200, 409]);
  const outdated = await sheetB('delivery/confirm', attempt);
  assert.equal(outdated.status, 409);
  assert.equal(outdated.data.error, 'delivery_changed');
  const current = await sheetB('delivery/preview', { ...undo, requestId: 'refresh-undo-bags', statusRevision: 2 });
  assert.equal(current.status, 200);
  const confirmBody = { ...attempt, previewId: current.data.preview.previewId };

  await db.admin.query("ALTER TABLE dispatch.request_results ADD CONSTRAINT test_delivery_failure CHECK (request_id <> 'confirm-undo')");
  assert.equal((await sheetB('delivery/confirm', confirmBody)).status, 500);
  assert.equal((await sheetB()).data.sheet.amounts.due, 30000);
  assert.equal((await sheetB()).data.sheet.statusRevision, 2);
  await db.admin.query('ALTER TABLE dispatch.request_results DROP CONSTRAINT test_delivery_failure');
  const confirmed = await sheetB('delivery/confirm', confirmBody);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.sheet.reviewed, true);
  assert.equal(confirmed.data.sheet.statusRevision, 3);
  assert.equal(confirmed.data.sheet.amounts.due, 24000);
  assert.deepEqual(await sheetB('delivery/confirm', confirmBody), confirmed);
});

test('opening debt and receipt allocations persist atomically and follow the verified amounts', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  let api = await start(db);
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const { trip: { id } } = await formalExample(api, a);
  const sheet = sheetEndpoint(api, a, id, 'sheet-a');
  const foreign = sheetEndpoint(api, b, id, 'sheet-a');
  const otherSheet = sheetEndpoint(api, a, id, 'sheet-b');
  assert.equal((await foreign('ledger')).status, 404);
  assert.equal((await sheet('receipt/preview', { requestId: 'not-reviewed', amount: '100' })).data.error, 'sheet_not_reviewed');
  const checked = await deliverAndReview(sheet, 'order-a');

  const opening = { requestId: 'preview-opening', amount: '60', day: '2026-10-31', source: '前次送货' };
  assert.equal((await sheet('opening/preview', { ...opening, day: '2026-02-30' })).status, 409);
  const openingPreview = await sheet('opening/preview', opening);
  assert.equal(openingPreview.status, 200);
  assert.equal((await sheet('ledger')).data.ledger.remainingCents, 16400);
  const openingConfirm = { previewId: openingPreview.data.preview.id, requestId: 'confirm-opening' };
  const old = await sheet('opening/confirm', openingConfirm);
  assert.equal(old.status, 200);
  assert.deepEqual(await sheet('opening/confirm', openingConfirm), old);
  assert.equal((await sheet('opening/preview', { ...opening, requestId: 'same-opening-different-preview' })).data.error, 'opening_rejected');
  const debtId = 'opening:' + old.data.opening.id;
  const orderId = 'order:' + JSON.stringify([id, 'sheet-a']);

  const delivery = await sheet('delivery/preview', { requestId: 'undo-before-payment', version: 1,
    statusRevision: checked.statusRevision, lineId: 'line-a', status: 'pending' });
  assert.equal(delivery.status, 200);
  assert.equal((await sheet('receipt/preview', { requestId: 'invalid-price', amount: '12.001' })).status, 400);
  assert.equal((await sheet('receipt/preview', { requestId: 'too-much', amount: '225' })).data.error, 'receipt_rejected');
  const pay = await sheet('receipt/preview', { requestId: 'preview-100', amount: '100' });
  assert.equal(pay.status, 200);
  assert.deepEqual(pay.data.preview.allocations.map(({ debtId, cents, remaining }) => [debtId, cents, remaining]),
    [[debtId, 6000, 0], [orderId, 4000, 12400]]);
  assert.deepEqual((await sheet('ledger')).data.ledger.receipts, []);
  const concurrentPreview = await sheet('receipt/preview', { requestId: 'other-preview', amount: '100' });
  assert.equal(concurrentPreview.status, 200);
  const confirmation = { requestId: 'pay-100', previewId: pay.data.preview.id };
  assert.equal((await foreign('receipt/confirm', confirmation)).status, 404);
  assert.equal((await otherSheet('receipt/confirm', confirmation)).status, 404);

  await db.admin.query('ALTER TABLE dispatch.receipt_allocations ADD CONSTRAINT test_split_failed CHECK (cents <> 4000)');
  assert.equal((await sheet('receipt/confirm', confirmation)).status, 500);
  assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM dispatch.receipts')).rows[0].count, 0);
  assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM dispatch.receipt_allocations')).rows[0].count, 0);
  assert.equal((await sheet()).data.sheet.amounts.paid, 0);
  await db.admin.query('ALTER TABLE dispatch.receipt_allocations DROP CONSTRAINT test_split_failed');
  const paid = await sheet('receipt/confirm', confirmation);
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.deepEqual(await sheet('receipt/confirm', confirmation), paid);
  assert.deepEqual(await sheet('receipt/confirm', { ...confirmation, requestId: 'same-preview-fresh-request' }), paid);
  const stale = await sheet('receipt/confirm', { requestId: 'stale-payment', previewId: concurrentPreview.data.preview.id });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'ledger_changed');
  const staleDelivery = await sheet('delivery/confirm', { requestId: 'stale-delivery', previewId: delivery.data.preview.previewId });
  assert.equal(staleDelivery.status, 409);
  assert.equal(staleDelivery.data.error, 'delivery_changed');

  const partial = await sheet();
  assert.deepEqual(partial.data.sheet.amounts, { due: 16400, paid: 4000, remaining: 12400, excess: 0 });
  const rest = await sheet('receipt/preview', { requestId: 'preview-rest', amount: '124' });
  assert.equal(rest.status, 200);
  const last = await sheet('receipt/confirm', { requestId: 'pay-rest', previewId: rest.data.preview.id });
  assert.equal(last.status, 200);
  assert.deepEqual(last.data.receipt.allocations, [{ debtId: orderId, cents: 12400 }]);

  await api.stop();
  api = await start(db);
  const resumed = sheetEndpoint(api, await login(api, 'a'), id, 'sheet-a');
  const ledger = (await resumed('ledger')).data.ledger;
  assert.equal(ledger.remainingCents, 0);
  assert.equal(ledger.otherRemainingCents, 0);
  assert.deepEqual(ledger.receipts, [paid.data.receipt, last.data.receipt]);
  assert.deepEqual((await resumed()).data.sheet.amounts, { due: 16400, paid: 16400, remaining: 0, excess: 0 });
});

test('a receipt opened from a newer sheet pays earlier reviewed sheets of that party first', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db);
  const a = await login(api, 'a');
  const formal = await formalExample(api, a);
  const id = formal.trip.id;
  const older = sheetEndpoint(api, a, id, 'sheet-a');
  const oldest = await deliverAndReview(older, 'older');
  const newDraft = await tripCommand(api, a, 'next-draft', { requestId: 'next', draftId: id });
  assert.equal(newDraft.status, 200);
  const [customer] = exampleCustomers();
  const draft = await putCustomers(api, a, newDraft.data.draft, 'save-next', [{ ...customer, partyId: oldest.partyId }]);
  const review = await preview(api, a, draft, 'preview-next');
  assert.equal(review.status, 200);
  assert.equal((await confirm(api, a, review.data.preview.previewId, 'confirm-next')).status, 200);
  const newer = sheetEndpoint(api, a, draft.id, 'sheet-a');
  await deliverAndReview(newer, 'newer');

  const ledger = (await newer('ledger')).data.ledger;
  assert.equal(ledger.otherRemainingCents, 16400);
  const payment = await newer('receipt/preview', { requestId: 'preview-both', amount: '200' });
  assert.equal(payment.status, 200);
  assert.deepEqual(payment.data.preview.allocations.map(({ debtId, cents }) => [JSON.parse(debtId.slice(6)), cents]),
    [[[id, 'sheet-a'], 16400], [[draft.id, 'sheet-a'], 3600]]);
  const confirmations = await Promise.all(['first', 'duplicate'].map(requestId =>
    newer('receipt/confirm', { requestId, previewId: payment.data.preview.id })));
  assert.equal(confirmations[0].status, 200);
  assert.deepEqual(confirmations[0], confirmations[1]);
  assert.equal((await older()).data.sheet.amounts.remaining, 0);
  assert.equal((await newer()).data.sheet.amounts.remaining, 12800);
  assert.equal((await newer('ledger')).data.ledger.otherRemainingCents, 0);
});

test('amending a settled historical sheet preserves allocations and leaves current picking on the current trip', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  let api = await start(db);
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const formal = await formalExample(api, a);
  const id = formal.trip.id;
  const older = sheetEndpoint(api, a, id, 'sheet-a');
  const checked = await deliverAndReview(older, 'older');
  const payment = await older('receipt/preview', { requestId: 'pay-preview', amount: '164' });
  assert.equal(payment.status, 200);
  const paid = await older('receipt/confirm', { requestId: 'pay-confirm', previewId: payment.data.preview.id });
  assert.equal(paid.status, 200);

  const fresh = await tripCommand(api, a, 'next-draft', { requestId: 'next', draftId: id });
  assert.equal(fresh.status, 200);
  const [customer] = exampleCustomers();
  const draft = await putCustomers(api, a, fresh.data.draft, 'save-next', [{
    ...customer, partyId: checked.partyId, items: [line('line-next', '安井', '箱', '1', '50')],
  }]);
  const next = await preview(api, a, draft, 'preview-next');
  assert.equal(next.status, 200);
  const current = await confirm(api, a, next.data.preview.previewId, 'confirm-next');
  assert.equal(current.status, 200);
  const newer = sheetEndpoint(api, a, draft.id, 'sheet-a');
  await deliverAndReview(newer, 'newer');

  const base = { version: 1, statusRevision: checked.statusRevision, items: [line('line-a', '安井', '箱', '2', '110')] };
  const foreign = sheetEndpoint(api, b, id, 'sheet-a');
  assert.equal((await foreign('amendment/preview', { ...base, requestId: 'foreign' })).status, 404);
  const edited = await older('amendment/preview', { ...base, requestId: 'change-price' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const { preview: correction } = edited.data;
  assert.deepEqual(correction.orderCents, { before: 16400, after: 22000 });
  assert.deepEqual(correction.before, { due: 16400, paid: 16400, remaining: 0, excess: 0 });
  assert.deepEqual(correction.after, { due: 22000, paid: 16400, remaining: 5600, excess: 0 });
  assert.deepEqual(correction.picking, []);
  assert.equal(correction.changes[0].afterStatus, 'delivered');
  const parked = (await older()).data.sheet;
  assert.equal(parked.version, 1);
  assert.equal(parked.amounts.remaining, 0);

  const apply = { requestId: 'apply-amendment', previewId: correction.previewId };
  assert.equal((await foreign('amendment/confirm', apply)).status, 404);
  assert.equal((await newer('amendment/confirm', apply)).status, 404);
  const saved = await older('amendment/confirm', apply);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.version.version, 2);
  assert.equal(saved.data.version.totalCents, 59500);
  assert.deepEqual(await older('amendment/confirm', apply), saved);
  assert.deepEqual(await older('amendment/confirm', { ...apply, requestId: 'confirm-already-saved' }), saved);

  await api.stop();
  api = await start(db);
  const resumed = await login(api, 'a');
  const original = (await api.request(`/v1/trips/${id}`, { token: resumed })).data;
  assert.deepEqual(original.trip.versions, [formal.trip.versions[0], saved.data.version]);
  assert.deepEqual(original.picking, formal.picking);
  const oldSheet = sheetEndpoint(api, resumed, id, 'sheet-a');
  assert.deepEqual((await oldSheet()).data.sheet.amounts, correction.after);
  assert.deepEqual((await oldSheet('ledger')).data.ledger.receipts, [paid.data.receipt]);
  const latest = (await api.request('/v1/workspace', { token: resumed })).data;
  assert.deepEqual(latest.currentTrip, { id: draft.id, totalCents: 5000, version: 1 });
  const nextTrip = (await api.request(`/v1/trips/${draft.id}`, { token: resumed })).data;
  assert.deepEqual(nextTrip.picking, current.data.picking);
  assert.equal((await sheetEndpoint(api, resumed, draft.id, 'sheet-a')('ledger')).data.ledger.otherRemainingCents, 5600);
});

test('amendment rejects changed delivery and receipts and writes the new version atomically', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db);
  const a = await login(api, 'a');
  const { trip: { id } } = await formalExample(api, a);
  const sheet = sheetEndpoint(api, a, id, 'sheet-a');
  const sheetB = sheetEndpoint(api, a, id, 'sheet-b');
  const checked = await deliverAndReview(sheet, 'review-a');
  const basis = { version: 1, statusRevision: checked.statusRevision };
  const replacement = [line('line-a', '三全', '箱', '2', '50'), line('line-extra', '安井', '袋', '1', '10')];
  const edit = { ...basis, items: replacement, replacementStatuses: { 'line-a': 'pending' } };
  const requiresChoice = await sheet('amendment/preview', { ...edit, requestId: 'missing-choice', replacementStatuses: {} });
  assert.equal(requiresChoice.status, 400);
  assert.match(requiresChoice.data.message, /替换货品的配送状态/);
  const repeatedLine = await sheet('amendment/preview', { ...edit, requestId: 'foreign-line-id',
    items: [replacement[0], line('line-b-box', '安井', '袋', '1', '10')] });
  assert.equal(repeatedLine.status, 400);
  const deliveryStale = await sheet('amendment/preview', { ...edit, requestId: 'will-change-delivery' });
  assert.equal(deliveryStale.status, 200);
  const b = await deliverAndReview(sheetB, 'review-b', basis.statusRevision);
  const applyStale = preview => sheet('amendment/confirm', { requestId: 'stale-amendment', previewId: preview.data.preview.previewId });
  assert.equal((await applyStale(deliveryStale)).data.error, 'amendment_changed');

  const next = { ...edit, statusRevision: b.statusRevision };
  const receiptStale = await sheet('amendment/preview', { ...next, requestId: 'will-change-receipt' });
  assert.equal(receiptStale.status, 200);
  const paying = await sheet('receipt/preview', { requestId: 'planned-payment', amount: '90' });
  assert.equal(paying.status, 200);
  assert.equal((await sheet('receipt/confirm', { requestId: 'record-payment', previewId: paying.data.preview.id })).status, 200);
  assert.equal((await applyStale(receiptStale)).data.error, 'amendment_changed');

  const original = (await api.request(`/v1/trips/${id}`, { token: a })).data;
  const fresh = await sheet('amendment/preview', { ...next, requestId: 'fresh-amendment' });
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.data.preview.after, { due: 0, paid: 9000, remaining: 0, excess: 9000 });
  assert.equal(fresh.data.preview.picking.length, 3);
  const sameBase = await sheet('amendment/preview', { ...next, requestId: 'competing-amendment',
    replacementStatuses: { 'line-a': 'delivered' } });
  assert.equal(sameBase.status, 200);
  const submit = { requestId: 'save-amendment', previewId: fresh.data.preview.previewId };
  await db.admin.query("ALTER TABLE dispatch.request_results ADD CONSTRAINT test_amendment_failed CHECK (request_id <> 'save-amendment')");
  assert.equal((await sheet('amendment/confirm', submit)).status, 500);
  assert.deepEqual((await api.request(`/v1/trips/${id}`, { token: a })).data, original);
  await db.admin.query('ALTER TABLE dispatch.request_results DROP CONSTRAINT test_amendment_failed');

  const results = await Promise.all([
    sheet('amendment/confirm', submit),
    sheet('amendment/confirm', { ...submit, requestId: 'same-amendment-concurrent' }),
  ]);
  assert.equal(results[0].status, 200, JSON.stringify(results[0].data));
  assert.deepEqual(results[1], results[0]);
  const staleVersion = await applyStale(sameBase);
  assert.equal(staleVersion.status, 409);
  assert.equal(staleVersion.data.error, 'amendment_changed');
  const amended = (await api.request(`/v1/trips/${id}`, { token: a })).data;
  assert.equal(amended.trip.versions.length, 2);
  assert.equal(amended.trip.statuses['line-a'], 'pending');
  assert.equal(amended.trip.statuses['line-extra'], 'pending');
  assert.equal(amended.trip.statuses['line-b-box'], 'delivered');
  assert.deepEqual((await sheet()).data.sheet.amounts, fresh.data.preview.after);
});

test('a logical backup restores the S5 ledger, account policies and confirmation results into a fresh database', { timeout: 60_000 }, async t => {
  const source = await isolatedDatabase(t);
  const api = await start(source);
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const bytes = Buffer.from('private material fixture');
  const upload = await api.request('/v1/materials', { method: 'POST', token: a,
    body: materialInput(await read(api, a), bytes, 'backup-material') });
  assert.equal(upload.status, 201);
  const materialPath = `/v1/materials/${upload.data.material.id}`;
  const stored = await api.request(materialPath + '/chunks', { method: 'PUT', token: a, chunk: bytes, offset: 0 });
  assert.equal(stored.data.material.status, 'ready');
  const formal = await formalExample(api, a);
  const ownB = await formalExample(api, b);
  const tripId = formal.trip.id;
  const sheet = sheetEndpoint(api, a, tripId, 'sheet-a');
  const partial = sheetEndpoint(api, a, tripId, 'sheet-b');
  const checked = await deliverAndReview(sheet, 'backup-a');
  const boxes = await partial('delivery', {
    requestId: 'backup-b-boxes', version: 1, statusRevision: checked.statusRevision, lineId: 'line-b-box', status: 'delivered',
  });
  assert.equal(boxes.status, 200);
  const statusRevision = boxes.data.sheet.statusRevision;
  assert.equal((await partial('review', { requestId: 'backup-b-review', version: 1, statusRevision })).status, 200);

  const opening = await sheet('opening/preview', { requestId: 'opening-preview', day: '2020-01-01', amount: '60' });
  assert.equal(opening.status, 200);
  assert.equal((await sheet('opening/confirm', { requestId: 'opening-confirm', previewId: opening.data.preview.id })).status, 200);
  async function receive(amount, label) {
    const preview = await sheet('receipt/preview', { requestId: `preview-${label}`, amount });
    assert.equal(preview.status, 200);
    const body = { requestId: `confirm-${label}`, previewId: preview.data.preview.id };
    const result = await sheet('receipt/confirm', body);
    assert.equal(result.status, 200);
    return { body, result };
  }
  const first = await receive('100', 'first');
  const second = await receive('124', 'second');
  assert.deepEqual(first.result.data.receipt.allocations.map(({ cents }) => cents), [6000, 4000]);
  assert.deepEqual(second.result.data.receipt.allocations.map(({ cents }) => cents), [12400]);
  const edit = await sheet('amendment/preview', {
    requestId: 'preview-correction', version: 1, statusRevision, items: [line('line-a', '安井', '箱', '2', '110')],
  });
  assert.equal(edit.status, 200);
  const amendmentBody = { requestId: 'confirm-correction', previewId: edit.data.preview.previewId };
  const amendment = await sheet('amendment/confirm', amendmentBody);
  assert.equal(amendment.status, 200);
  assert.equal(amendment.data.version.version, 2);

  async function snapshot(service, token) {
    const aSheet = sheetEndpoint(service, token, tripId, 'sheet-a');
    const bSheet = sheetEndpoint(service, token, tripId, 'sheet-b');
    const results = await Promise.all([
      service.request(`/v1/trips/${tripId}`, { token }), aSheet(), bSheet(), aSheet('ledger'),
    ]);
    for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.data));
    const [trip, a, b, ledger] = results.map(result => result.data);
    return { trip, a: a.sheet, b: b.sheet, ledger: ledger.ledger };
  }
  const before = await snapshot(api, a);
  assert.deepEqual(before.a.amounts, { due: 22000, paid: 16400, remaining: 5600, excess: 0 });
  assert.deepEqual(before.b.amounts, { due: 24000, paid: 0, remaining: 24000, excess: 0 });
  assert.equal(before.b.lines.find(line => line.id === 'line-b-bag').status, 'pending');
  assert.deepEqual(before.trip.trip.versions, [formal.trip.versions[0], amendment.data.version]);
  assert.deepEqual(before.ledger.receipts, [first.result.data.receipt, second.result.data.receipt]);

  await api.stop();
  const archive = runPostgresClient('pg_dump', source.name, ['--format=custom', '--schema=dispatch']);
  assert.equal(archive.subarray(0, 5).toString(), 'PGDMP');
  const restored = await isolatedDatabase(t, async (admin, name) => {
    assert.notEqual(name, source.name);
    assert.equal((await admin.query("SELECT to_regnamespace('dispatch') AS schema")).rows[0].schema, null);
    runPostgresClient('pg_restore', name, ['--dbname', name, '--single-transaction', '--exit-on-error', '--no-owner'], archive);
  });

  const recoveryApi = await start(restored);
  const recoveredA = await login(recoveryApi, 'a');
  const recoveredB = await login(recoveryApi, 'b');
  assert.deepEqual(await recoveryApi.request(materialPath, { token: recoveredA }), {
    status: 200, data: { material: { ...stored.data.material, draftCurrent: false } },
  });
  assert.equal((await recoveryApi.request(materialPath, { token: recoveredB })).status, 404);
  assert.deepEqual((await restored.admin.query('SELECT content FROM dispatch.material_chunks')).rows, [{ content: bytes }]);
  assert.deepEqual(await snapshot(recoveryApi, recoveredA), before);
  const restoredB = await recoveryApi.request(`/v1/trips/${ownB.trip.id}`, { token: recoveredB });
  assert.deepEqual(restoredB, { status: 200, data: ownB });
  const foreign = sheetEndpoint(recoveryApi, recoveredB, tripId, 'sheet-a');
  assert.equal((await foreign('ledger')).status, 404);
  assert.equal((await foreign('receipt/confirm', first.body)).status, 404);
  assert.equal((await foreign('amendment/confirm', amendmentBody)).status, 404);

  const recoveredSheet = sheetEndpoint(recoveryApi, recoveredA, tripId, 'sheet-a');
  assert.deepEqual(await recoveredSheet('receipt/confirm', first.body), first.result);
  assert.deepEqual(await recoveredSheet('receipt/confirm', { ...first.body, requestId: 'receipt-after-recovery' }), first.result);
  assert.deepEqual(await recoveredSheet('amendment/confirm', amendmentBody), amendment);
  assert.deepEqual(await recoveredSheet('amendment/confirm', { ...amendmentBody, requestId: 'amendment-after-recovery' }), amendment);
  assert.deepEqual(await snapshot(recoveryApi, recoveredA), before);

  const { rows: [accountB] } = await restored.admin.query("SELECT id FROM dispatch.accounts WHERE identity_subject = 'b'");
  const restricted = restored.pool();
  try {
    const connection = await restricted.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('dispatch.account_id', $1, true)", [accountB.id]);
      assert.deepEqual((await connection.query('SELECT id FROM dispatch.trips')).rows, [{ id: ownB.trip.id }]);
      assert.equal((await connection.query('SELECT 1 FROM dispatch.receipt_allocations')).rowCount, 0);
      const update = await connection.query('UPDATE dispatch.trips SET status_revision = 999 WHERE id = $1', [tripId]);
      assert.equal(update.rowCount, 0);
      await connection.query('COMMIT');
    } finally {
      connection.release();
    }
  } finally {
    await restricted.end();
  }
});

test('WeChat code exchange restores an app-scoped workspace and keeps development sessions separate', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const codeRequest = (api, code, extra) => api.request('/v1/session/wechat', {
    method: 'POST', body: { code, ...extra },
  });
  let api = await start(db);
  const development = await login(api, 'a');
  assert.equal((await codeRequest(api, 'unused')).status, 404);
  await api.stop();

  const firstApp = 'wx1111111111111111';
  const otherApp = 'wx2222222222222222';
  const secret = 'mock-only-secret-for-test';
  const returnedKey = 'mock-wechat-session-key';
  const config = appId => ({ DISPATCH_WECHAT_APP_ID: appId, DISPATCH_WECHAT_APP_SECRET: secret });
  assert.throws(() => configuredWechatLogin({ DISPATCH_WECHAT_APP_ID: firstApp }), /DISPATCH_WECHAT_APP_SECRET/);
  const used = new Set();
  const mockWechat = appId => configuredWechatLogin(config(appId), async (url, options) => {
    assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
    assert.equal(url.searchParams.get('appid'), appId);
    assert.equal(url.searchParams.get('secret'), secret);
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
    assert.equal(options.redirect, 'error');
    const code = url.searchParams.get('js_code');
    if (code === 'upstream-error') throw new Error('simulated upstream error containing ' + secret);
    if (code === 'busy') return Response.json({ errcode: 45011 });
    if (code === 'invalid' || used.has(code)) return Response.json({ errcode: 40029, errmsg: secret });
    used.add(code);
    return Response.json({ openid: code.startsWith('a-') ? 'mock-openid-a' : 'mock-openid-b',
      session_key: returnedKey, unionid: 'mock-unionid' });
  });
  api = await start(db, mockWechat(firstApp));
  assert.equal((await api.request('/v1/session/development', { method: 'POST', body: { account: 'a' } })).status, 404);
  assert.equal((await api.request('/v1/workspace', { token: development })).status, 401);
  assert.equal((await codeRequest(api, '')).status, 400);
  assert.deepEqual(await codeRequest(api, 'invalid'), {
    status: 401, data: { error: 'wechat_code_rejected', message: '微信登录凭证不可用，请重新获取' },
  });
  const outage = await codeRequest(api, 'upstream-error');
  assert.equal(outage.status, 502);
  assert.ok(!JSON.stringify(outage).includes(secret));
  assert.equal((await codeRequest(api, 'busy')).status, 429);
  const bOnly = await db.admin.query("SELECT count(*)::int AS count FROM dispatch.accounts WHERE identity_provider = 'wechat'");
  assert.equal(bOnly.rows[0].count, 0);

  const initial = await codeRequest(api, 'a-first', { openid: 'not-a-trusted-identity', appId: otherApp });
  assert.equal(initial.status, 201, JSON.stringify(initial.data));
  assert.deepEqual(Object.keys(initial.data).sort(), ['expiresAt', 'token']);
  const { token: a } = initial.data;
  assert.equal((await codeRequest(api, 'a-first')).status, 401);
  const aTrip = await formalExample(api, a);
  const next = await tripCommand(api, a, 'next-draft', { requestId: 'wx-next', draftId: aTrip.trip.id });
  assert.equal(next.status, 200);
  const saved = await save(api, a, next.data.draft, 'wx-save', '微信试用草稿');
  assert.equal(saved.status, 200);
  const bLogin = await codeRequest(api, 'b-first');
  assert.equal(bLogin.status, 201);
  const b = bLogin.data.token;
  assert.notEqual((await read(api, b)).id, saved.data.draft.id);
  assert.equal((await api.request(`/v1/trips/${aTrip.trip.id}`, { token: b })).status, 404);
  assert.equal((await save(api, b, saved.data.draft, 'wx-foreign', '跨账号写入')).status, 404);
  const accounts = await db.admin.query("SELECT identity_subject FROM dispatch.accounts WHERE identity_provider = 'wechat' ORDER BY identity_subject");
  assert.deepEqual(accounts.rows.map(row => row.identity_subject), [
    firstApp + ':mock-openid-a', firstApp + ':mock-openid-b',
  ]);
  assert.ok(!JSON.stringify(accounts.rows).includes(returnedKey));
  const expiry = await db.admin.query(`UPDATE dispatch.sessions SET expires_at = now() - interval '1 second'
    WHERE account_id IN (SELECT id FROM dispatch.accounts WHERE identity_subject = $1)`, [firstApp + ':mock-openid-a']);
  assert.equal(expiry.rowCount, 1);
  assert.equal((await api.request('/v1/workspace', { token: a })).status, 401);

  await api.stop();
  api = await start(db, mockWechat(firstApp));
  const resumed = await codeRequest(api, 'a-second');
  assert.equal(resumed.status, 201);
  const newToken = resumed.data.token;
  assert.notEqual(newToken, a);
  assert.deepEqual(await read(api, newToken), saved.data.draft);
  assert.deepEqual((await api.request(`/v1/trips/${aTrip.trip.id}`, { token: newToken })).data, aTrip);
  assert.equal((await api.request('/v1/session', { method: 'DELETE', token: newToken })).status, 204);
  assert.equal((await api.request('/v1/workspace', { token: newToken })).status, 401);
  const again = await codeRequest(api, 'a-third');
  assert.equal(again.status, 201);

  await api.stop();
  api = await start(db, mockWechat(otherApp));
  assert.equal((await api.request('/v1/workspace', { token: again.data.token })).status, 401);
  const separate = await codeRequest(api, 'a-another-app');
  assert.equal(separate.status, 201);
  assert.notEqual((await read(api, separate.data.token)).id, saved.data.draft.id);
  assert.equal((await api.request(`/v1/trips/${aTrip.trip.id}`, { token: separate.data.token })).status, 404);
});

function sendText(api, token, draft, requestId, text) {
  return api.request('/v1/text-orders', { method: 'POST', token, body: { requestId, draftId: draft.id, revision: draft.revision, text } });
}

function fixtureLine(customer, brand, unit, quantity, price = '') {
  return { action: 'add', customer, product: '水饺', brand, specification: '500g', unit, quantity, price };
}

test('S6 Harness: fixed trip from text through draft, picking and delivery', { timeout: 105_000 }, async t => {
  const live = process.env.DISPATCH_S6_EVAL_LIVE === '1';
  const runId = randomUUID();
  const diagnostic = event => t.diagnostic(JSON.stringify({ runId, caseVersion: s6.version, promptVersion: textPromptVersion,
    mode: live ? 'live' : 'fixture', ...event }));
  let calls = 0;
  let step;
  const liveModel = live && configuredTextModel(process.env, trace => diagnostic({ step, ...trace }));
  if (live) assert.ok(liveModel, '请在本机进程中配置 DISPATCH_TEXT_MODEL_KEY');
  const fixture = new Map([
    [s6.initial, { operations: [fixtureLine('老王', '安井', '箱', '2')] }],
    [s6.supplement, { operations: [{ action: 'fill', target: 1, price: '82' }] }],
    [s6.ambiguous, { operations: [], question: '请确认是追加还是把数量改为三箱。' }],
    [s6.remaining, { operations: [fixtureLine('小李', '安井', '箱', '3', '80'),
      fixtureLine('小李', '安井', '袋', '3', '20'), fixtureLine('赵记', '三全', '箱', '1', '75')] }],
  ]);
  const model = async context => {
    calls += 1;
    if (liveModel) return liveModel(context);
    const output = fixture.get(context.text);
    diagnostic({ step, tool: 'extract_text', model: 'fixture/s6-v1', outcome: output ? 'received_json' : 'unmapped_input' });
    assert.ok(output);
    return output;
  };
  const db = await isolatedDatabase(t);
  let api = await start(db, undefined, model);
  const token = await login(api, 'a');
  const blank = await read(api, token);
  const check = (rule, actual, expected) => {
    diagnostic({ step, rule, score: Number(isDeepStrictEqual(actual, expected)), actual, expected });
    assert.deepEqual(actual, expected, rule);
  };
  const extract = async (name, draft, text, status) => {
    step = name;
    const response = await sendText(api, token, draft, name, text);
    check('text_order_status', response.status, status);
    return response.data.draft;
  };
  const missing = await extract('initial', blank, s6.initial, 200);
  const { id, ...missingLine } = missing.customers[0].items[0];
  check('missing_price', [missing.customers[0].customer, ...['product', 'brand', 'specification', 'unit', 'quantity', 'price']
    .map(field => missingLine[field])], [...s6.expected[0].slice(0, -1), null]);
  const unpriced = await preview(api, token, missing, 'no-price');
  check('preview_allows_missing_price', unpriced.status, 200);
  check('unpriced_subtotal_is_null', unpriced.data.preview.customers[0].items[0].amountCents, null);
  await api.stop();
  api = await start(db, undefined, model);
  check('same_request_replays_after_restart', (await sendText(api, token, blank, 'initial', s6.initial)).data.draft, missing);
  check('same_text_new_request_rejected', (await sendText(api, token, missing, 'duplicate', s6.initial)).data.error, 'duplicate_order_text');
  check('duplicate_does_not_call_model', calls, 1);

  const filled = await extract('supplement', missing, s6.supplement, 200);
  check('supplement_preserves_line', filled.customers[0].items[0].id, id);
  check('explicit_price', filled.customers[0].items[0].price, '82');
  const earlierPreview = await preview(api, token, filled, 'old-preview');
  check('initial_preview_cents', earlierPreview.data.preview?.totalCents, 16400);
  await extract('ambiguous', filled, s6.ambiguous, 422);
  check('ambiguity_leaves_draft_unchanged', await read(api, token), filled);
  const full = await extract('remaining', filled, s6.remaining, 200);
  const rows = customers => customers.flatMap(customer => customer.items.map(item => [customer.customer,
    ...['product', 'brand', 'specification', 'unit', 'quantity', 'price'].map(field => item[field])]));
  check('draft_fields', rows(full.customers), s6.expected);
  check('prior_preview_no_longer_confirms', (await confirm(api, token, earlierPreview.data.preview.previewId, 'confirm-old')).status, 409);
  const reviewed = await preview(api, token, full, 'eval-preview');
  check('preview_amount_cents', reviewed.data.preview?.totalCents, s6.orderCents);
  check('no_formal_trip_before_confirmation', (await api.request(`/v1/trips/${blank.id}`, { token })).status, 404);
  step = 'formal';
  const confirmed = await confirm(api, token, reviewed.data.preview.previewId, 'eval-confirm');
  check('confirm_status', confirmed.status, 200);
  const formal = confirmed.data.trip.versions[0];
  check('formal_fields', rows(formal.customers), s6.expected);
  check('formal_amount_cents', formal.totalCents, s6.orderCents);
  check('customer_order_cents', formal.customers.map(customer => customer.totalCents), s6.customerOrderCents);
  check('picking_separates_brand_and_unit', confirmed.data.picking.map(line => [line.brand, line.unit, line.quantity]), s6.picking);
  const [a, b] = formal.customers;
  const sheetA = sheetEndpoint(api, token, blank.id, a.id);
  check('full_delivery_due_cents', (await deliverAndReview(sheetA, 'eval-a')).amounts.due, s6.dueA);
  const sheetB = sheetEndpoint(api, token, blank.id, b.id);
  const marked = await sheetB('delivery', { requestId: 'eval-b', version: 1, statusRevision: 1,
    lineId: b.items[0].id, status: 'delivered' });
  check('partial_delivery_due_cents', marked.data.sheet?.amounts.due, s6.partialDueB);
  check('four_model_calls', calls, 4);
});

for (const kind of ['text', 'image']) {
  test(`S6 Harness: S7d unpriced ${kind} order through confirmation and picking`, { timeout: 30_000 }, async t => {
    const live = process.env.DISPATCH_S6_EVAL_LIVE === '1';
    const runId = randomUUID();
    const promptVersion = kind === 'text' ? textPromptVersion : imagePromptVersion;
    const diagnostic = event => t.diagnostic(JSON.stringify({ runId, caseVersion: 's7d-unpriced-v1', promptVersion,
      mode: live ? 'live' : 'fixture', ...event }));
    const configure = kind === 'text' ? configuredTextModel : configuredImageModel;
    const input = '老王来两箱水饺，小李也要三箱水饺。';
    const png = kind === 'image' ? await readFile(resolve(__dirname, '../fixtures/s7d-unpriced-order.png')) : null;
    const fixture = async context => {
      if (kind === 'text') assert.equal(context.text, input);
      else assert.deepEqual(context, { content: png, mime: 'image/png' });
      diagnostic({ tool: `extract_${kind}`, model: 'fixture/s7d-unpriced-v1', outcome: 'received_json' });
      return { operations: [
        { action: 'add', customer: '老王', product: '水饺', unit: '箱', quantity: '2' },
        { action: 'add', customer: '小李', product: '水饺', unit: '箱', quantity: '3', brand: '', specification: '', price: '' },
      ] };
    };
    const model = live ? configure(process.env, diagnostic) : fixture;
    assert.ok(model, '请在本机进程中配置 DISPATCH_TEXT_MODEL_KEY');
    const db = await isolatedDatabase(t);
    const api = await start(db, undefined, kind === 'text' ? model : undefined, kind === 'image' ? model : undefined);
    const token = await login(api, 'a');
    const blank = await read(api, token);
    const check = (rule, actual, expected) => {
      diagnostic({ rule, score: Number(isDeepStrictEqual(actual, expected)), actual, expected });
      assert.deepEqual(actual, expected, rule);
    };
    let extracted;
    if (kind === 'text') {
      extracted = await sendText(api, token, blank, 's7d-extract', input);
    } else {
      const registered = await api.request('/v1/materials', { method: 'POST', token, body: materialInput(blank, png, 's7d-register') });
      check('register_image_status', registered.status, 201);
      const materialId = registered.data.material.id;
      const uploaded = await api.request(`/v1/materials/${materialId}/chunks`, { method: 'PUT', token, chunk: png, offset: 0 });
      check('image_ready', uploaded.data.material?.status, 'ready');
      extracted = await api.request('/v1/image-orders', { method: 'POST', token,
        body: { draftId: blank.id, revision: blank.revision, materialId, requestId: 's7d-extract' } });
    }
    check('order_status', extracted.status, 200);
    const draft = await read(api, token);
    const rows = customers => customers.flatMap(({ customer, items }) => items.map(item => [customer,
      item.product, item.brand, item.specification, item.unit, item.quantity, item.price]));
    const expected = [['老王', '水饺', '', '', '箱', '2', null], ['小李', '水饺', '', '', '箱', '3', null]];
    check('persisted_draft_fields', rows(draft.customers), expected);
    const reviewed = await preview(api, token, draft, 's7d-preview');
    check('preview_status', reviewed.status, 200);
    const prices = customers => customers.flatMap(({ items }) => items.map(item => [item.unitPriceCents, item.amountCents]));
    check('preview_unpriced_items', prices(reviewed.data.preview.customers), [[null, null], [null, null]]);
    check('preview_known_total_cents', reviewed.data.preview.totalCents, 0);
    const confirmed = await confirm(api, token, reviewed.data.preview.previewId, 's7d-confirm');
    check('confirm_status', confirmed.status, 200);
    const formal = confirmed.data.trip.versions[0];
    check('formal_fields', rows(formal.customers), expected);
    check('formal_unpriced_items', prices(formal.customers), [[null, null], [null, null]]);
    check('picking_merges_unbranded_and_unsized', confirmed.data.picking.map(line =>
      [line.product, line.brand, line.specification, line.unit, line.quantity]), [['水饺', '', '', '箱', 5]]);
  });
}

test('S6 rejects invalid results, cross-account drafts, revoked sessions and late results', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const started = new Map();
  let attempts = 0;
  const wait = key => new Promise(resolve => started.set(key, resolve));
  let release;
  const model = async ({ text }) => {
    attempts += 1;
    if (text === '失败' && attempts === 1) throw new HttpError(502, 'text_model_failed', '模型暂不可用');
    if (text === '格式错误') return { operations: [fixtureLine('老王', '安井', '袋', '3.5', '20')] };
    if (text === '有歧义的补价') return { operations: [{ action: 'fill', target: 1, price: '82' }] };
    if (text === '超时' || text === '退出') {
      await new Promise(resolve => {
        release = resolve;
        started.get(text)();
      });
    }
    if (text === '两条待补价') return { operations: [fixtureLine('老王', '安井', '箱', '2'), fixtureLine('小李', '安井', '箱', '2')] };
    return { operations: [fixtureLine('老王', '安井', '袋', '3', '20')] };
  };
  const disabled = await start(db);
  const a = await login(disabled, 'a');
  const b = await login(disabled, 'b');
  const original = await read(disabled, a);
  assert.equal((await sendText(disabled, a, original, 'disabled', '样例')).status, 503);
  await disabled.stop();
  const api = await start(db, undefined, model);
  assert.equal((await sendText(api, b, original, 'cross-account', '样例')).status, 404);
  assert.equal(attempts, 0);
  assert.equal((await sendText(api, a, original, 'failed-model', '失败')).status, 502);
  assert.deepEqual(await read(api, a), original);
  assert.equal((await sendText(api, a, original, 'invalid-response', '格式错误')).status, 502);
  assert.deepEqual(await read(api, a), original);
  const beforeLate = wait('超时');
  const late = sendText(api, a, original, 'late', '超时');
  await beforeLate;
  const newer = (await save(api, a, original, 'manual-first', '新版客户')).data.draft;
  release();
  assert.equal((await late).data.error, 'draft_changed');
  assert.deepEqual(await read(api, a), newer);
  const beforeLogout = wait('退出');
  const logoutResult = sendText(api, a, newer, 'logged-out', '退出');
  await beforeLogout;
  await api.request('/v1/session', { method: 'DELETE', token: a });
  release();
  assert.equal((await logoutResult).status, 401);
  const another = await login(api, 'a');
  assert.deepEqual(await read(api, another), newer);
  assert.equal((await sendText(api, another, newer, 'failed-model', '失败')).status, 200);
  const other = await read(api, b);
  const two = await sendText(api, b, other, 'two', '两条待补价');
  assert.equal(two.status, 200);
  assert.equal((await sendText(api, b, two.data.draft, 'ambiguous-fill', '有歧义的补价')).status, 422);
  assert.deepEqual(await read(api, b), two.data.draft);
});

test('S7a organizes a private image once, retries failures and protects newer drafts', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lRJ0AAAAASUVORK5CYII=', 'base64');
  const nextImage = Buffer.concat([png, Buffer.from('next')]);
  const originalFetch = global.fetch;
  const calls = [];
  const longOrder = [
    fixtureLine('', '安井', '箱', '2'),
    fixtureLine('', '安井', '袋', '3'),
    ...Array.from({ length: 37 }, (_, index) => ({ action: 'add', product: `手写货品 ${index + 1}`, quantity: '1', unit: '斤' })),
    { action: 'add', quantity: '2', unit: '件' },
  ];
  let notifyStarted;
  let release;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  t.after(() => { release(); global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    if (url !== 'https://api.deepseek.com/chat/completions') return originalFetch(url, options);
    const body = JSON.parse(options.body);
    calls.push(body);
    if (calls.length === 1) return new Response('{}', { status: 503 });
    if (calls.length === 3) {
      notifyStarted();
      await finish;
    }
    const extracted = { operations: calls.length === 2
      ? [fixtureLine('老王', '安井', '箱', '2')]
      : longOrder };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(extracted) } }] });
  };
  const api = await start(db, undefined, undefined, configuredImageModel({ DISPATCH_TEXT_MODEL_KEY: 'fixture' }));
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const draft = await read(api, a);
  const other = await read(api, b);
  const post = (path, token, body) => api.request(path, { method: 'POST', token, body });
  const organize = (token, basis, materialId, requestId) => post('/v1/image-orders', token,
    { draftId: basis.id, revision: basis.revision, materialId, requestId });
  const register = async (bytes, key) => {
    const result = await post('/v1/materials', a, materialInput(draft, bytes, key));
    assert.equal(result.status, 201);
    return result.data.material;
  };
  const upload = (material, bytes) => api.request(`/v1/materials/${material.id}/chunks`,
    { method: 'PUT', token: a, chunk: bytes, offset: 0 });
  const original = await register(png, 'image-register');
  assert.equal((await organize(b, other, original.id, 'cross-account-image')).status, 404);
  assert.equal((await organize(a, draft, original.id, 'upload-pending')).data.error, 'material_incomplete');
  assert.equal((await upload(original, png)).data.material.organized, false);
  const duplicate = await register(png, 'duplicate-image-register');
  await upload(duplicate, png);
  const another = await register(nextImage, 'next-image-register');
  await upload(another, nextImage);
  const unreadable = Buffer.from('not an image');
  const invalid = await register(unreadable, 'invalid-image-register');
  await upload(invalid, unreadable);
  assert.equal((await organize(a, draft, invalid.id, 'invalid-image')).data.error, 'unsupported_order_image');
  assert.equal(calls.length, 0);
  assert.equal((await organize(a, draft, original.id, 'image-order')).data.error, 'image_model_failed');
  assert.deepEqual(await read(api, a), draft);
  const applied = await organize(a, draft, original.id, 'image-order');
  assert.equal(applied.status, 200);
  const { draft: recognized } = applied.data;
  assert.equal(recognized.revision, draft.revision + 1);
  assert.equal(recognized.customers[0].customer, '老王');
  assert.equal(recognized.customers[0].items[0].price, null);
  assert.equal((await api.request(`/v1/trips/${draft.id}`, { token: a })).status, 404);
  assert.deepEqual(await organize(a, draft, original.id, 'image-order'), applied);
  assert.equal((await organize(a, recognized, duplicate.id, 'duplicate-image')).data.error, 'duplicate_order_image');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, 'deepseek-flash');
  assert.equal(calls[1].max_tokens, 5000);
  assert.equal(calls[1].response_format.type, 'json_object');
  assert.equal(calls[1].messages[1].content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  const listed = (await api.request('/v1/materials', { token: a })).data.materials;
  assert.deepEqual(listed.filter(row => row.organized).map(row => row.id).sort(), [original.id, duplicate.id].sort());

  const late = organize(a, recognized, another.id, 'late-image');
  await started;
  const saved = await save(api, a, recognized, 'manual-draft-first', '手工修改').finally(release);
  assert.equal(saved.status, 200);
  assert.equal((await late).data.error, 'draft_changed');
  assert.deepEqual(await read(api, a), saved.data.draft);
  assert.equal((await api.request(`/v1/materials/${another.id}`, { token: a })).data.material.organized, false);
  const continued = await organize(a, saved.data.draft, another.id, 'retry-after-edit');
  assert.equal(continued.status, 200);
  assert.deepEqual(continued.data.draft.customers.map(customer => customer.customer), ['手工修改', '']);
  const items = continued.data.draft.customers[1].items;
  assert.equal(items.length, 40);
  assert.deepEqual(items.slice(0, 2).map(item => item.unit), ['箱', '袋']);
  assert.deepEqual([items[39].product, items[39].quantity, items[39].unit, items[39].price], ['', '2', '件', null]);
  assert.equal((await preview(api, a, continued.data.draft, 'handwritten-needs-review')).status, 400);
});

function pcmWave(pcmSize) {
  const wave = Buffer.alloc(44 + pcmSize);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(16000, 24);
  wave.writeUInt32LE(32000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(pcmSize, 40);
  return wave;
}

test('S7b transcribes WAV without changing a draft and rejects stale results', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const wave = pcmWave(640_000);

  const originalFetch = global.fetch;
  const calls = [];
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  t.after(() => { release(); global.fetch = originalFetch; });
  global.fetch = async (url, options) => {
    if (url !== 'https://api.deepseek.com/v1/tools/asr') return originalFetch(url, options);
    calls.push(options);
    assert.equal(options.headers.Authorization, 'Bearer fixture');
    const file = options.body.get('file');
    assert.equal(file.name, 'recording.wav');
    assert.equal(file.type, 'audio/wav');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), wave);
    if (calls.length === 1) return new Response('{}', { status: 503 });
    if (calls.length === 3) {
      entered();
      await finish;
    }
    return Response.json({ request_id: 'asr-fixture', text: '老王需要两箱安井水饺。', duration_ms: 10 });
  };

  const api = await start(db, undefined, undefined, undefined, configuredSpeechModel({ DISPATCH_TEXT_MODEL_KEY: 'fixture' }));
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const draft = await read(api, a);
  const transcribe = (token, basis, chunk = wave) => api.request(`/v1/drafts/${basis.id}/transcription`, {
    method: 'POST', token, chunk, headers: { 'content-type': 'audio/wav', 'x-draft-revision': String(basis.revision) },
  });
  const transcribeJson = (token, basis, audio = wave.toString('base64')) => api.request(`/v1/drafts/${basis.id}/transcription`, {
    method: 'POST', token, body: { wave: audio }, headers: { 'x-draft-revision': String(basis.revision) },
  });
  assert.equal((await transcribe('', draft)).status, 401);
  assert.equal((await transcribe(b, draft)).status, 404);
  assert.equal((await transcribe(a, draft, Buffer.from('invalid'))).data.error, 'invalid_voice');
  assert.equal((await transcribe(a, draft, wave.subarray(0, wave.length - 44))).data.error, 'invalid_voice');
  assert.equal((await transcribeJson(a, draft, 'AAAA?')).data.error, 'invalid_voice');
  const oversized = await transcribe(a, draft, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal(oversized.status, 413);
  assert.equal(calls.length, 0);
  assert.equal((await transcribe(a, draft)).data.error, 'voice_model_failed');
  assert.deepEqual(await transcribeJson(a, draft), {
    status: 200, data: { draftId: draft.id, revision: 0, text: '老王需要两箱安井水饺。' },
  });
  assert.deepEqual(await read(api, a), draft);
  assert.equal((await api.request(`/v1/trips/${draft.id}`, { token: a })).status, 404);
  assert.deepEqual((await api.request('/v1/materials', { token: a })).data, { materials: [] });

  const late = transcribe(a, draft);
  await started;
  const saved = await save(api, a, draft, 'newer-draft', '用户新编辑').finally(release);
  assert.equal(saved.status, 200);
  assert.equal((await late).data.error, 'draft_changed');
  assert.equal((await transcribe(a, draft)).data.error, 'draft_changed');
  assert.equal(calls.length, 3);
  assert.deepEqual(await read(api, a), saved.data.draft);
});

test('S7c merges image, text and speech and isolates late results by revision and trip', { timeout: 20_000 }, async t => {
  function delayModel() {
    let notify;
    let release;
    const started = new Promise(resolve => { notify = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    t.after(release);
    return { started, release, async pause() { notify(); await wait; } };
  }
  const lateText = delayModel();
  const lateImage = delayModel();
  const lateVoice = delayModel();
  const db = await isolatedDatabase(t);
  const item = fixtureLine('老王', '安井', '箱', '2');
  let imageCalls = 0;
  let voiceCalls = 0;
  const api = await start(db, undefined, async ({ text, current }) => {
    if (text === '补另一个客户的订单') {
      await lateText.pause();
      return { operations: [fixtureLine('另一客户', '安井', '箱', '1', '82')] };
    }
    assert.equal(text, '老王的安井水饺是500g\n每箱八十二元');
    assert.deepEqual(current.map(({ customer, product, quantity, specification, price }) =>
      [customer, product, quantity, specification, price]), [['老王', '水饺', '2', '', null]]);
    return { operations: [{ action: 'fill', target: 1, specification: '500g', price: '82' }] };
  }, async () => {
    if (++imageCalls === 2) await lateImage.pause();
    return { operations: [{ ...item, specification: '', ...(imageCalls === 2 ? { customer: '另一客户' } : {}) }] };
  }, async () => {
    if (++voiceCalls === 2) await lateVoice.pause();
    return { text: '每箱八十二元' };
  });
  const a = await login(api, 'a');
  const second = await login(api, 'a');
  const original = await read(api, a);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lRJ0AAAAASUVORK5CYII=', 'base64');
  const post = (path, body) => api.request(path, { method: 'POST', token: a, body });
  const register = async (draft, bytes, requestId) => {
    const upload = await post('/v1/materials', materialInput(draft, bytes, requestId));
    assert.equal(upload.status, 201);
    const { id } = upload.data.material;
    assert.equal((await api.request(`/v1/materials/${id}/chunks`, { method: 'PUT', token: a, chunk: bytes, offset: 0 })).status, 200);
    return id;
  };
  const organize = (draft, materialId, requestId) => post('/v1/image-orders',
    { draftId: draft.id, revision: draft.revision, materialId, requestId });
  const transcribe = draft => api.request(`/v1/drafts/${draft.id}/transcription`, {
    method: 'POST', token: a, body: { wave: pcmWave(32_000).toString('base64') },
    headers: { 'x-draft-revision': String(draft.revision) },
  });

  const image = await register(original, png, 'mixed-register');
  const extracted = await organize(original, image, 'mixed-image');
  assert.equal(extracted.status, 200);
  const draft = extracted.data.draft;
  assert.equal(draft.revision, original.revision + 1);
  assert.equal(draft.customers[0].items[0].price, null);
  assert.equal((await preview(api, a, draft, 'mixed-incomplete')).status, 200);
  const voice = await transcribe(draft);
  assert.equal(voice.status, 200);
  assert.deepEqual(await read(api, a), draft);
  const originalItemId = draft.customers[0].items[0].id;
  const filled = await sendText(api, a, draft, 'mixed-supplement', `老王的安井水饺是500g\n${voice.data.text}`);
  assert.equal(filled.status, 200);
  const complete = filled.data.draft;
  assert.equal(complete.revision, draft.revision + 1);
  assert.equal(complete.customers[0].items.length, 1);
  assert.deepEqual(complete.customers[0].items[0], { id: originalItemId, product: '水饺', brand: '安井',
    specification: '500g', unit: '箱', quantity: '2', price: '82' });
  const firstPreview = await preview(api, a, complete, 'mixed-preview');
  assert.equal(firstPreview.data.preview.totalCents, 16400);
  assert.equal((await api.request(`/v1/trips/${complete.id}`, { token: a })).status, 404);

  const pendingText = sendText(api, a, complete, 'mixed-late-text', '补另一个客户的订单');
  await lateText.started;
  const customers = structuredClone(complete.customers);
  customers[0].items[0].quantity = '3';
  const edited = await api.request(`/v1/drafts/${complete.id}`, { method: 'PUT', token: second,
    body: { requestId: 'mixed-edit', revision: complete.revision, customers } }).finally(lateText.release);
  assert.equal(edited.status, 200);
  assert.equal((await pendingText).data.error, 'draft_changed');
  const updated = edited.data.draft;
  assert.deepEqual(await read(api, a), updated);
  assert.equal((await confirm(api, second, firstPreview.data.preview.previewId, 'mixed-old-confirm')).data.error, 'draft_changed');

  const another = await register(updated, Buffer.concat([png, Buffer.from('another image')]), 'mixed-register-late');
  const pendingImage = organize(updated, another, 'mixed-late-image');
  const pendingVoice = transcribe(updated);
  await Promise.all([lateImage.started, lateVoice.started]);
  const revised = await preview(api, second, updated, 'mixed-preview-revised');
  assert.equal(revised.data.preview.totalCents, 24600);
  const confirmed = await confirm(api, second, revised.data.preview.previewId, 'mixed-confirm');
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.picking[0].quantity, 3);
  const next = await tripCommand(api, second, 'next-draft', { draftId: updated.id, requestId: 'mixed-next' });
  assert.equal(next.status, 200);
  lateImage.release();
  lateVoice.release();
  assert.equal((await pendingImage).data.error, 'draft_not_found');
  assert.equal((await pendingVoice).data.error, 'draft_not_found');
  assert.deepEqual(await read(api, a), next.data.draft);
  assert.notEqual(next.data.draft.id, updated.id);
  assert.equal((await api.request(`/v1/materials/${another}`, { token: a })).data.material.organized, false);
  assert.deepEqual((await api.request(`/v1/trips/${updated.id}`, { token: a })).data, confirmed.data);
});

test('flexible issue keeps pending prices null and groups empty brands and specs in picking', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db);
  const token = await login(api, 'a');
  const entry = (id, fields = {}) => ({ id, product: '水饺', brand: '', specification: '', unit: '箱',
    quantity: '5', price: null, ...fields });
  const customers = [
    { id: 'market', customer: '王记', partyId: null, items: [
      entry('unpriced', { brand: null, specification: ' ' }),
      entry('priced', { specification: null, quantity: '2', price: '1.23' }),
    ] },
    { id: 'second', customer: '李记', partyId: null, items: [
      entry('branded', { brand: '安井', specification: undefined, price: undefined }),
      entry('sized', { specification: '500g' }),
      entry('bag', { unit: '袋', price: '  ' }),
    ] },
  ];
  let draft = await read(api, token);
  for (const [key, value, message] of [
    ['customer', '', /第 1 位客户.*客户名称/], ['product', '', /第 1 条.*货品/],
    ['unit', '', /第 1 条.*单位/], ['quantity', '0', /第 1 条.*正整数/],
    ['quantity', '1.5', /第 1 条.*正整数/], ['price', '0', /第 1 条.*单价/],
  ]) {
    const invalid = structuredClone(customers);
    (key === 'customer' ? invalid[0] : invalid[0].items[0])[key] = value;
    draft = await putCustomers(api, token, draft, `save-invalid-${draft.revision}`, invalid);
    const blocked = await preview(api, token, draft, `invalid-${draft.revision}`);
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.message, message);
  }
  draft = await putCustomers(api, token, draft, 'save-flexible', customers);
  assert.equal(draft.customers[1].items[0].price, null);
  assert.equal(draft.customers[1].items[0].specification, '');
  assert.equal(draft.customers[1].items[2].price, null);
  const result = await preview(api, token, draft, 'flexible-preview');
  assert.equal(result.status, 200);
  const { previewId, totalCents } = result.data.preview;
  assert.equal(totalCents, 246);
  assert.deepEqual(result.data.preview.customers[0].items.map(line => [line.unitPriceCents, line.amountCents]), [[null, null], [123, 246]]);
  assert.equal((await api.request(`/v1/trips/${draft.id}`, { token })).status, 404);
  const confirmed = await confirm(api, token, previewId, 'flexible-confirm');
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirm(api, token, previewId, 'flexible-confirm'), confirmed);
  assert.deepEqual(confirmed.data.picking.map(row => [row.brand, row.specification, row.unit, row.quantity]), [
    ['', '', '箱', 7], ['安井', '', '箱', 5], ['', '500g', '箱', 5], ['', '', '袋', 5],
  ]);
  const { rows: [stored] } = await db.admin.query('SELECT customers FROM dispatch.trip_versions');
  assert.equal(stored.customers[0].items[0].unitPriceCents, null);
  assert.equal(stored.customers[0].items[0].amountCents, null);
});

test('onsite updates persist and lock exact receivables without changing formal snapshots or picking', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  let api = await start(db);
  const token = await login(api, 'a');
  const other = await login(api, 'b');
  const initial = await read(api, token);
  const items = [
    { id: 'boxes', product: '水饺', quantity: '5', price: null },
    { id: 'rejected', product: '馄饨', quantity: '2', price: null },
    { id: 'priced', product: '包子', quantity: '2', price: '1.23' },
  ].map(item => ({ brand: '', specification: '', unit: '箱', ...item }));
  const draft = await putCustomers(api, token, initial, 'field-save', [{ id: 'market', customer: '王记', partyId: null, items }]);
  const unpricedOnly = await putCustomers(api, token, draft, 'all-unpriced', [{
    ...draft.customers[0], items: items.map(item => ({ ...item, price: null })),
  }]);
  const { data: { preview: order } } = await preview(api, token, unpricedOnly, 'all-unpriced-preview');
  assert.equal(order.totalCents, 0);
  const confirmed = await confirm(api, token, order.previewId, 'field-confirm');
  assert.equal(confirmed.status, 200);
  const sheet = sheetEndpoint(api, token, draft.id, 'market');
  const complete = { version: 1, statusRevision: 0, requestId: 'field-complete' };
  const blocked = await sheet('delivery/complete', complete);
  assert.equal(blocked.data.error, 'delivery_price_required');
  assert.match(blocked.data.message, /水饺.*馄饨.*包子/);
  const first = { version: 1, statusRevision: 0, requestId: 'edit-boxes', lineId: 'boxes', receivedQuantity: '3', price: '12.34' };
  assert.equal((await sheetEndpoint(api, other, draft.id, 'market')('delivery/line', first)).status, 404);
  assert.equal((await sheet('delivery/line', { ...first, lineId: 'new-line' })).status, 404);
  assert.equal((await sheet('delivery/line', { ...first, receivedQuantity: '-1' })).data.error, 'invalid_delivery_quantity');
  assert.equal((await sheet('delivery/line', { ...first, price: '0' })).data.error, 'invalid_delivery_price');
  const [saved, conflict] = await Promise.all([
    sheet('delivery/line', first),
    sheet('delivery/line', { ...first, requestId: 'edit-concurrent', receivedQuantity: '4' }),
  ]).then(results => results.sort((left, right) => left.status - right.status));
  assert.equal(saved.status, 200);
  assert.equal(conflict.data.error, 'delivery_changed');
  const accepted = saved.data.sheet.lines.find(line => line.id === 'boxes');
  const acceptedInput = accepted.receivedQuantity === 3 ? first : { ...first, requestId: 'edit-concurrent', receivedQuantity: '4' };
  assert.deepEqual(await sheet('delivery/line', acceptedInput), saved);
  assert.equal((await sheet('delivery/line', { ...acceptedInput, price: '12.35' })).data.error, 'request_conflict');
  const adjusted = await sheet('delivery/line', { ...first, requestId: 'edit-final', statusRevision: 1 });
  assert.deepEqual(adjusted.data.sheet.execution, { totalCents: 3702, pendingPrices: 2 });
  const repriced = await sheet('delivery/line', { ...first, requestId: 'reprice', statusRevision: 2, price: '12.35' });
  assert.deepEqual(repriced.data.sheet.execution, { totalCents: 3705, pendingPrices: 2 });
  const refused = await sheet('delivery/line', { ...first, requestId: 'refused', statusRevision: 3,
    lineId: 'rejected', receivedQuantity: '0', price: null });
  assert.deepEqual(refused.data.sheet.execution, { totalCents: 3705, pendingPrices: 1 });
  assert.equal(refused.data.sheet.lines[1].amountCents, 0);
  assert.equal(refused.data.sheet.lines[1].unitPriceCents, null);
  const last = await sheet('delivery/line', { ...first, requestId: 'price-buns', statusRevision: 4,
    lineId: 'priced', receivedQuantity: '2', price: '1.23' });
  assert.deepEqual(last.data.sheet.execution, { totalCents: 3951, pendingPrices: 0 });
  assert.equal((await sheet('delivery/complete', complete)).data.error, 'delivery_changed');
  const lock = { ...complete, statusRevision: 5 };
  await db.admin.query("ALTER TABLE dispatch.request_results ADD CONSTRAINT fail_delivery_lock CHECK (request_id <> 'field-complete')");
  assert.equal((await sheet('delivery/complete', lock)).status, 500);
  const afterFailure = (await sheet()).data.sheet;
  assert.equal(afterFailure.deliveryCompleted, false);
  assert.equal(afterFailure.statusRevision, 5);
  await db.admin.query('ALTER TABLE dispatch.request_results DROP CONSTRAINT fail_delivery_lock');
  const done = await sheet('delivery/complete', lock);
  assert.equal(done.status, 200);
  assert.equal(done.data.sheet.amounts.due, 3951);
  assert.equal(done.data.sheet.deliveryCompleted, true);
  assert.deepEqual(done.data.sheet.lines.map(line => [line.originalQuantity, line.receivedQuantity, line.status]),
    [['5', 3, 'delivered'], ['2', 0, 'pending'], ['2', 2, 'delivered']]);
  assert.equal((await sheet('delivery/line', { ...first, requestId: 'after-lock', statusRevision: 6 })).data.error, 'delivery_completed');
  assert.equal((await sheet('delivery/preview', { ...lock, requestId: 'status-after-lock', statusRevision: 6,
    lineId: 'boxes', status: 'pending' })).data.error, 'delivery_completed');
  assert.equal((await sheet('ledger')).data.ledger.debts[0].cents, 3951);

  await api.stop();
  api = await start(db);
  const reopened = sheetEndpoint(api, token, draft.id, 'market');
  assert.deepEqual((await reopened()).data.sheet, done.data.sheet);
  assert.deepEqual(await reopened('delivery/complete', lock), done);
  const after = (await api.request(`/v1/trips/${draft.id}`, { token })).data;
  assert.deepEqual(after.picking, confirmed.data.picking);
  assert.deepEqual(after.trip.versions, confirmed.data.trip.versions);
  assert.equal(after.deliveryEdits.boxes.unitPriceCents, 1235);
});
