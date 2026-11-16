const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { Pool } = require('pg');
const { migrate } = require('../../code/server-dist/server/migrate');
const { startLocalServer } = require('../../code/server-dist/server/main');

async function isolatedDatabase(t) {
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
