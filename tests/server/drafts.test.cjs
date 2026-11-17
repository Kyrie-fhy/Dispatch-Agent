const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { Pool } = require('pg');
const { migrate } = require('../../code/server-dist/server/migrate');
const { startLocalServer } = require('../../code/server-dist/server/main');
const { configuredWechatLogin } = require('../../code/server-dist/server/wechat-login');
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

  return { name, admin: migrationPool, services, pool: () => new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }) };
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

async function start(db, wechat) {
  const pool = db.pool();
  let server;
  try {
    server = await startLocalServer(pool, 0, wechat);
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
    async request(path, { method = 'GET', token, body, chunk, offset } = {}) {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (chunk) {
        headers['content-type'] = 'application/octet-stream';
        headers['x-material-offset'] = String(offset);
      }
      const response = await fetch(origin + path, {
        method, headers, body: chunk ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      return { status: response.status, data: response.status === 204 ? null : await response.json() };
    },
    stop,
  };
}

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
  assert.equal((await sheet('receipt/preview', { requestId: 'too-much', amount: '225' })).data.preview.pendingCents, 100);
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

test('S5 keeps pending excess and corrects receipts atomically without rewriting later distributions', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db);
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const [first, second] = await Promise.all([formalExample(api, a), formalExample(api, b)]);
  const sheet = sheetEndpoint(api, a, first.trip.id, 'sheet-a');
  const other = sheetEndpoint(api, b, second.trip.id, 'sheet-a');
  await deliverAndReview(sheet, 'correct');
  await deliverAndReview(other, 'excess');
  const debt = await sheet('opening/preview', { requestId: 'old-preview', amount: '60', day: '2020-01-01' });
  assert.equal((await sheet('opening/confirm', { requestId: 'old-confirm', previewId: debt.data.preview.id })).status, 200);

  async function receive(target, amount, key) {
    const result = await target('receipt/preview', { requestId: `preview-${key}`, amount });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const saved = await target('receipt/confirm', { requestId: `confirm-${key}`, previewId: result.data.preview.id });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    return saved.data.receipt;
  }
  const excess = await receive(other, '170', 'excess');
  assert.deepEqual(excess.allocations.map(row => row.cents), [16400]);
  assert.equal(excess.pendingCents, 600);
  const whollyPending = await receive(other, '1', 'pending');
  assert.deepEqual(whollyPending.allocations, []);
  assert.equal((await other('ledger')).data.ledger.pendingCents, 700);

  const original = await receive(sheet, '100', 'original');
  const correction = (receiptId, amount, requestId) => sheet('receipt-correction/preview', { receiptId, amount, requestId });
  assert.equal((await correction(excess.id, '90', 'foreign')).status, 404);
  const before = await sheet('ledger');
  const change = await correction(original.id, '90', 'correction');
  assert.equal(change.status, 200, JSON.stringify(change.data));
  const plan = change.data.preview;
  assert.equal(plan.canConfirm, true);
  assert.deepEqual(plan.allocations.map(row => row.cents), [6000, 3000]);
  assert.deepEqual(await sheet('ledger'), before);
  const write = { requestId: 'replace', previewId: plan.id };
  assert.equal((await other('receipt-correction/confirm', write)).status, 404);
  await db.admin.query('ALTER TABLE dispatch.receipt_reversals ADD CONSTRAINT test_failed_reversal CHECK (false)');
  assert.equal((await sheet('receipt-correction/confirm', write)).status, 500);
  assert.deepEqual(await sheet('ledger'), before);
  await db.admin.query('ALTER TABLE dispatch.receipt_reversals DROP CONSTRAINT test_failed_reversal');
  const confirmed = await Promise.all([sheet('receipt-correction/confirm', write), sheet('receipt-correction/confirm', write)]);
  assert.equal(confirmed[0].status, 200, JSON.stringify(confirmed[0].data));
  assert.deepEqual(confirmed[0], confirmed[1]);
  const replacement = confirmed[0].data.receipt;
  assert.equal(replacement.replaces, original.id);
  assert.equal((await sheet()).data.sheet.amounts.remaining, 13400);
  assert.deepEqual((await sheet('ledger')).data.ledger.receipts, [{ ...original, reversedBy: replacement.id }, replacement]);

  const stale = await correction(replacement.id, '85', 'before-later');
  const later = await receive(sheet, '20', 'later');
  const rejected = await sheet('receipt-correction/confirm', { requestId: 'stale', previewId: stale.data.preview.id });
  assert.equal(rejected.data.error, 'ledger_changed');
  const permitted = (await correction(replacement.id, '85', 'unchanged-later')).data.preview;
  assert.equal(permitted.canConfirm, true);
  const updated = await sheet('receipt-correction/confirm', { requestId: 'allowed', previewId: permitted.id });
  assert.equal(updated.status, 200);
  assert.equal((await sheet()).data.sheet.amounts.remaining, 11900);
  assert.deepEqual((await sheet('ledger')).data.ledger.receipts.find(receipt => receipt.id === later.id), later);
  const blocked = (await correction(updated.data.receipt.id, '50', 'moves-later')).data.preview;
  assert.equal(blocked.canConfirm, false);
  assert.deepEqual(blocked.laterChanges[0].after.allocations.map(row => row.cents), [1000, 1000]);
  const unchanged = await sheet('ledger');
  assert.equal((await sheet('receipt-correction/confirm', { requestId: 'blocked', previewId: blocked.id })).data.error, 'later_receipt_change');
  assert.deepEqual(await sheet('ledger'), unchanged);
});

test('S5 history paginates formal trips within the account by their first issue time', { timeout: 20_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db);
  const a = await login(api, 'a');
  const b = await login(api, 'b');
  const ids = [];
  let draft = await read(api, a);
  for (let index = 0; index < 22; index++) {
    draft = await putCustomers(api, a, draft, `save-${index}`, exampleCustomers());
    const planned = await preview(api, a, draft, `preview-${index}`);
    assert.equal(planned.status, 200);
    const issued = await confirm(api, a, planned.data.preview.previewId, `issue-${index}`);
    assert.equal(issued.status, 200);
    ids.push(draft.id);
    const next = await tripCommand(api, a, 'next-draft', { requestId: `next-${index}`, draftId: draft.id });
    assert.equal(next.status, 200);
    draft = next.data.draft;
  }
  const first = await api.request('/v1/trips', { token: a });
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.trips.map(trip => trip.id), ids.slice(1, -1).reverse());
  assert.equal(first.data.nextCursor, ids[1]);
  const second = await api.request('/v1/trips?cursor=' + first.data.nextCursor, { token: a });
  assert.deepEqual(second.data.trips.map(trip => trip.id), [ids[0]]);
  assert.equal(second.data.nextCursor, null);
  assert.deepEqual((await api.request('/v1/trips?cursor=' + first.data.nextCursor, { token: b })).data,
    { trips: [], nextCursor: null });
  assert.equal((await api.request('/v1/trips/' + ids[0], { token: b })).status, 404);
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
  const fix = await sheet('receipt-correction/preview', {
    requestId: 'backup-fix-preview', receiptId: second.result.data.receipt.id, amount: '120',
  });
  assert.equal(fix.status, 200);
  const fixBody = { requestId: 'backup-fix-confirm', previewId: fix.data.preview.id };
  const fixed = await sheet('receipt-correction/confirm', fixBody);
  assert.equal(fixed.status, 200);
  const extra = await receive('66', 'extra');
  const beforeBackup = await snapshot(api, a);
  assert.equal(beforeBackup.a.amounts.remaining, 0);
  assert.equal(beforeBackup.ledger.pendingCents, 600);
  assert.deepEqual(beforeBackup.ledger.receipts, [
    first.result.data.receipt, { ...second.result.data.receipt, reversedBy: fixed.data.receipt.id },
    fixed.data.receipt, extra.result.data.receipt,
  ]);

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
  assert.deepEqual(await snapshot(recoveryApi, recoveredA), beforeBackup);
  const restoredB = await recoveryApi.request(`/v1/trips/${ownB.trip.id}`, { token: recoveredB });
  assert.deepEqual(restoredB, { status: 200, data: ownB });
  const foreign = sheetEndpoint(recoveryApi, recoveredB, tripId, 'sheet-a');
  assert.equal((await foreign('ledger')).status, 404);
  assert.equal((await foreign('receipt/confirm', first.body)).status, 404);
  assert.equal((await foreign('amendment/confirm', amendmentBody)).status, 404);

  const recoveredSheet = sheetEndpoint(recoveryApi, recoveredA, tripId, 'sheet-a');
  assert.deepEqual(await recoveredSheet('receipt/confirm', first.body), first.result);
  assert.deepEqual(await recoveredSheet('receipt/confirm', { ...first.body, requestId: 'receipt-after-recovery' }), first.result);
  assert.deepEqual(await recoveredSheet('receipt-correction/confirm', fixBody), fixed);
  assert.deepEqual(await recoveredSheet('amendment/confirm', amendmentBody), amendment);
  assert.deepEqual(await recoveredSheet('amendment/confirm', { ...amendmentBody, requestId: 'amendment-after-recovery' }), amendment);
  assert.deepEqual(await snapshot(recoveryApi, recoveredA), beforeBackup);

  const { rows: [accountB] } = await restored.admin.query("SELECT id FROM dispatch.accounts WHERE identity_subject = 'b'");
  const restricted = restored.pool();
  try {
    const connection = await restricted.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('dispatch.account_id', $1, true)", [accountB.id]);
      assert.deepEqual((await connection.query('SELECT id FROM dispatch.trips')).rows, [{ id: ownB.trip.id }]);
      assert.equal((await connection.query('SELECT 1 FROM dispatch.receipt_allocations')).rowCount, 0);
      assert.equal((await connection.query('SELECT 1 FROM dispatch.receipt_reversals')).rowCount, 0);
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
