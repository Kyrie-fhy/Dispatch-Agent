const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { Pool } = require('pg');
const { migrate } = require('../../code/server-dist/server/migrate');
const { startLocalServer } = require('../../code/server-dist/server/main');

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
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  migrationPool = new Pool({ connectionString: url.href });
  if (beforeMigrate) await beforeMigrate(migrationPool);
  await migrate(migrationPool);
  await migrate(migrationPool);
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
  await admin.query(`GRANT dispatch_app TO ${name}`);
  url.username = name;
  url.password = password;

  return { admin: migrationPool, services, pool: () => new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 }) };
}

async function start(db) {
  const pool = db.pool();
  let server;
  try {
    server = await startLocalServer(pool, 0);
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
    async request(path, { method = 'GET', token, body } = {}) {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(origin + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: response.status === 204 ? null : await response.json() };
    },
    stop,
  };
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
