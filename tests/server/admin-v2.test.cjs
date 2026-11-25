const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { readdir, readFile } = require('node:fs/promises');
const { setTimeout: pause } = require('node:timers/promises');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { Pool } = require('pg');
const { catalogCsvColumns, parseCatalogCsv } = require('../../code/server-dist/miniprogram/core/catalog');
const { emptyTrip } = require('../../code/server-dist/miniprogram/core/trips');
const { businessSession, lockAccountActivity, writeAccount } = require('../../code/server-dist/server/account-workspace');
const { configuredActivation } = require('../../code/server-dist/server/activation');
const { handleAdmin } = require('../../code/server-dist/server/admin');
const { AgentStore } = require('../../code/server-dist/server/agent/store');
const { CatalogStore } = require('../../code/server-dist/server/catalog');
const { setAccount, transaction } = require('../../code/server-dist/server/database');
const { DraftStore } = require('../../code/server-dist/server/drafts');
const { startLocalServer } = require('../../code/server-dist/server/main');
const { MaterialStore } = require('../../code/server-dist/server/materials');
const { migrate } = require('../../code/server-dist/server/migrate');

const adminToken = 'test-admin-v2-isolated-secret';
const appId = 'wx0123456789abcdef';
const legacyToken = 'A'.repeat(43);
const apiPrefix = '/admin/api';
const formalTables = ['trips', 'trip_versions', 'sheets', 'trip_previews', 'workspaces'];
const sha256 = value => createHash('sha256').update(value).digest();

function asCsv(rows) {
  return [catalogCsvColumns, ...rows].map(row => row.map(value => '"' + value.replace(/"/g, '""') + '"').join(',')).join('\r\n');
}

const baseRow = ['FISH', '500', '冻品', '原安井鱼豆腐', '安井', '鱼豆腐', '500g', '单规格', '箱', '19.80',
  '在售', '已核实', '别名「鱼腐」'];
const secondRow = ['RICE', '1', '主食', '糯米团', '', '糯米团', '1kg', '单规格', '', '9.90', '在售', '', ''];

async function isolatedDatabase(t) {
  const url = new URL(process.env.DISPATCH_TEST_ADMIN_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.notEqual(url.pathname, '/dispatch_local');
  const name = 'dispatch_test_' + randomBytes(8).toString('hex');
  const password = randomBytes(24).toString('hex');
  const admin = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  let owner;
  let app;
  t.after(async () => {
    try {
      await app?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
    } finally {
      await admin.end();
    }
  });
  try {
    await admin.query('CREATE ROLE dispatch_app NOLOGIN');
  } catch (error) {
    if (error.code !== '42710' && error.constraint !== 'pg_authid_rolname_index') throw error;
  }
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
  await admin.query(`GRANT dispatch_app TO ${name}`);
  url.pathname = '/' + name;
  owner = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const directory = new URL('../../code/server/migrations/', pathToFileURL(__filename));
  const files = (await readdir(directory)).filter(file => /^0(?:0[1-9]|1[0-2])_/.test(file)).sort();
  const legacyAccount = randomUUID();
  const legacyDraft = emptyTrip(randomUUID);
  await transaction(owner, async client => {
    await client.query('CREATE SCHEMA dispatch');
    await client.query(`CREATE TABLE dispatch.schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const file of files) {
      await client.query(await readFile(new URL(file, directory), 'utf8'));
      await client.query('INSERT INTO dispatch.schema_migrations (name) VALUES ($1)', [file]);
    }
    await client.query("INSERT INTO dispatch.accounts (id, identity_provider, identity_subject) VALUES ($1, 'wechat', $2)",
      [legacyAccount, appId + ':legacy']);
    await client.query('INSERT INTO dispatch.workspaces (account_id, draft_id, draft_customers) VALUES ($1,$2,$3)',
      [legacyAccount, legacyDraft.id, JSON.stringify(legacyDraft.customers)]);
    await client.query("INSERT INTO dispatch.sessions VALUES ($1, $2, now() + interval '1 hour')", [sha256(legacyToken), legacyAccount]);
  });
  await migrate(owner);
  url.username = name;
  url.password = password;
  app = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  return { owner, app, legacyAccount };
}

async function start(db, wechat, options) {
  // The parallel catalog test file may already be using DISPATCH_API_PORT.
  const server = await startLocalServer(db.app, 0, wechat, undefined, undefined, undefined, undefined, undefined, undefined,
    adminToken, undefined, options);
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
    const response = await fetch(origin + path, { method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, raw,
      data: raw.length && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw.toString('utf8')) : raw.toString('utf8') };
  };
  return {
    origin, request,
    admin: (path, method = 'GET', body, headers) => request(apiPrefix + path, { method, token: adminToken, body, headers }),
    login: (code, activationCode) => request('/v1/session/wechat', { method: 'POST', body: { code, activationCode } }),
    async stop() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      await closed;
    },
  };
}

function expect(response, status = 200, error) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  if (error) assert.equal(response.data.error, error);
  return response.data;
}

function issue(api, remarkName, requestId) {
  return api.admin('/activation-codes', 'POST', { remarkName, requestId }).then(response => expect(response));
}

async function waitForAdvisoryWaiter(owner, mode) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const { rowCount } = await owner.query(`SELECT 1 FROM pg_locks
      WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND locktype = 'advisory' AND NOT granted AND mode = $1`, [mode]);
    if (rowCount) return;
    await pause(25);
  }
  assert.fail('Timed out waiting for advisory lock mode ' + mode);
}

async function protectFormalTables(owner) {
  await owner.query(`CREATE FUNCTION dispatch.reject_admin_formal_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'admin cannot write %', TG_TABLE_NAME; END $$`);
  for (const table of formalTables) {
    await owner.query(`CREATE TRIGGER reject_admin_formal_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON dispatch.${table}
      FOR EACH STATEMENT EXECUTE FUNCTION dispatch.reject_admin_formal_write()`);
  }
}

async function addTurn(owner, accountId, draft, { status = 'completed', text = '', events = [], timestamp = new Date(), undone = false } = {}) {
  const id = randomUUID();
  await owner.query(`INSERT INTO dispatch.agent_turns
    (account_id,id,draft_id,start_revision,end_revision,before_customers,status,created_at,undone)
    VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8)`, [accountId, id, draft.id, draft.revision, JSON.stringify(draft.customers), status, timestamp, undone]);
  await owner.query(`INSERT INTO dispatch.agent_messages (account_id,turn_id,role,content)
    SELECT $1, $2, role, $3 FROM unnest($4::text[]) role`,
  [accountId, id, text, status === 'running' ? ['user'] : ['user', 'assistant']]);
  for (const [kind, payload] of events) {
    await owner.query('INSERT INTO dispatch.agent_events (account_id,draft_id,turn_id,kind,payload) VALUES ($1,$2,$3,$4,$5)',
      [accountId, draft.id, id, kind, JSON.stringify(payload)]);
  }
  return id;
}

test('activation configuration preserves explicit local and trial choices', () => {
  assert.equal(configuredActivation({}).requireActivation, false);
  assert.equal(configuredActivation({ DISPATCH_REQUIRE_ACTIVATION: 'true' }).requireActivation, true);
  assert.equal(configuredActivation({ DISPATCH_SERVER_MODE: 'trial' }).requireActivation, true);
  assert.equal(configuredActivation({ DISPATCH_SERVER_MODE: 'trial', DISPATCH_REQUIRE_ACTIVATION: '0' }).requireActivation, false);
  assert.equal(configuredActivation({ DISPATCH_SERVER_MODE: 'trial', DISPATCH_REQUIRE_ACTIVATION: 'false' }).requireActivation, false);
  assert.equal(configuredActivation({ DISPATCH_ADMIN_TOKEN: 'fallback', DISPATCH_ACTIVATION_PEPPER: 'explicit' }).activationPepper, 'explicit');
});

test('admin dispatch rejects methods, authentication and cross-origin writes before database access', async () => {
  const pool = { query: () => assert.fail('guarded routes must not reach PostgreSQL') };
  const call = async (url, method, headers = {}, token = adminToken) => {
    const request = Object.assign(Readable.from([Buffer.from('{}')]), { method, url,
      headers: { host: '127.0.0.1:8788', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    const result = {};
    const response = {
      writeHead: (status, responseHeaders) => Object.assign(result, { status, headers: responseHeaders }),
      end: content => Object.assign(result, { content }),
    };
    assert.equal(await handleAdmin(pool, token, request, response), true);
    return result;
  };
  const page = await call('/admin', 'GET');
  assert.equal(page.status, 200);
  const scripts = [...page.content.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  for (const script of scripts) new vm.Script(script[1]);
  await assert.rejects(call('/admin/api/accounts', 'GET'), { status: 401, code: 'admin_auth_required' });
  await assert.rejects(call('/admin/api/prompts', 'POST'), { status: 405, code: 'method_not_allowed' });
  const account = '/admin/api/accounts/' + randomUUID();
  const authorization = 'Bearer ' + adminToken;
  await assert.rejects(call(account, 'PATCH', { authorization, origin: 'http://other.test' }),
    { status: 403, code: 'admin_origin_rejected' });
  await assert.rejects(call(account, 'PATCH', { authorization, 'content-type': 'text/plain' }),
    { status: 415, code: 'invalid_content_type' });
  await assert.rejects(call('/admin', 'GET', {}, ''), { status: 404, code: 'not_found' });
});

test('admin v2 through the normal routes on an isolated PostgreSQL database', { timeout: 120_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db, { appId, exchange: async code => code }, { requireActivation: true, activationPepper: 'isolated-pepper' });
  let active = true;
  t.after(async () => { if (active) await api.stop(); });
  let account;
  let otherAccount;
  let customerId;
  let otherCustomer;
  let activeToken;
  let draft;
  let firstVariant;
  let mistake;

  await t.test('migration backfills legacy accounts and leaves the generation-zero session valid', async () => {
    const { rows: [legacy] } = await db.owner.query('SELECT activated_at, session_epoch FROM dispatch.accounts WHERE id = $1', [db.legacyAccount]);
    assert.ok(legacy.activated_at instanceof Date);
    assert.equal(legacy.session_epoch, 0);
    expect(await api.request('/v1/workspace', { token: legacyToken }));
    assert.equal(expect(await api.login('legacy'), 201).remarkName, '');
    const status = expect(await api.admin('/system/status'));
    assert.deepEqual(status.wechat, { configured: true, requireActivation: true });
    assert.equal(status.database.reachable, true);
    assert.equal(status.models.text.configured, false);
    assert.equal(JSON.stringify(status).includes('isolated-pepper'), false);
  });

  await t.test('opens accounts once, with rollback, digest-only storage and race-safe redemption', async () => {
    expect(await api.login('courier'), 403, 'activation_required');
    assert.equal((await db.owner.query("SELECT 1 FROM dispatch.accounts WHERE identity_subject = $1", [appId + ':courier'])).rowCount, 0);
    expect(await api.login('courier', 'invalid'), 403, 'invalid_activation_code');
    const first = await issue(api, '  配送员甲  ', 'issue-first');
    const second = await issue(api, '配送员甲备用');
    assert.match(first.code, /^DZ-[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
    const retry = await issue(api, '配送员甲', 'issue-first');
    assert.equal(retry.code, null);
    assert.equal(retry.record.id, first.record.id);
    expect(await api.admin('/activation-codes', 'POST', { remarkName: '他人', requestId: 'issue-first' }), 409, 'request_conflict');
    const concurrent = await Promise.all([api.login('courier', first.code.toLowerCase().replace(/-/g, ' ')),
      api.login('courier', second.code.slice(3).replace('-', ''))]);
    const sessions = concurrent.map(reply => expect(reply, 201));
    assert.equal(sessions[0].remarkName, sessions[1].remarkName);
    assert.notEqual(sessions[0].token, sessions[1].token);
    activeToken = sessions[0].token;
    const list = expect(await api.admin('/activation-codes')).records;
    const used = list.find(row => row.redeemedAccountId && [first.record.id, second.record.id].includes(row.id));
    const unused = list.find(row => row.status === 'unused' && [first.record.id, second.record.id].includes(row.id));
    assert.ok(used && unused);
    assert.equal(used.redeemedAccountRemark, sessions[0].remarkName);
    assert.equal(list.some(row => 'code' in row || 'codeDigest' in row), false);
    assert.equal(JSON.stringify(list).includes(first.code), false);
    account = used.redeemedAccountId;
    const { rows: [stored] } = await db.owner.query('SELECT code_digest, code_hint FROM dispatch.activation_codes WHERE id = $1', [first.record.id]);
    assert.equal(stored.code_digest.length, 32);
    assert.notEqual(stored.code_hint, first.code);
    expect(await api.admin('/activation-codes/' + used.id + '/revoke', 'POST'), 409, 'activation_code_not_unused');
    const reissued = expect(await api.admin('/activation-codes/' + unused.id + '/reissue', 'POST'));
    assert.equal(reissued.revokedId, unused.id);
    assert.equal(reissued.record.remarkName, unused.remarkName);
    expect(await api.login('revoked', unused.id === first.record.id ? first.code : second.code), 403, 'invalid_activation_code');
    const raced = await Promise.all([api.login('claimant-a', reissued.code), api.login('claimant-b', reissued.code)]);
    assert.deepEqual(raced.map(result => result.status).sort(), [201, 403]);
    const loser = raced[0].status === 403 ? 'claimant-a' : 'claimant-b';
    assert.equal((await db.owner.query('SELECT 1 FROM dispatch.accounts WHERE identity_subject = $1', [appId + ':' + loser])).rowCount, 0);
    const claims = expect(await api.admin('/activation-codes')).records;
    otherAccount = claims.find(row => row.id === reissued.record.id).redeemedAccountId;
    for (let attempt = 0; attempt < 8; attempt++) expect(await api.login('guessing', 'DZ-0000-0000'), 403, 'invalid_activation_code');
    expect(await api.login('guessing', 'DZ-0000-0000'), 429, 'activation_rate_limited');
    const unusedCode = await issue(api, '作废用码');
    assert.equal(expect(await api.admin('/activation-codes/' + unusedCode.record.id + '/revoke', 'POST')).record.status, 'revoked');
  });

  await t.test('linearizes disable before the in-flight cached write and revokes both sessions', async () => {
    const root = '/accounts/' + account;
    const workspace = expect(await api.request('/v1/workspace', { token: activeToken }));
    const command = { requestId: randomUUID(), revision: workspace.draft.revision, customers: workspace.draft.customers };
    const path = '/v1/drafts/' + workspace.draft.id;
    const save = () => api.request(path, { method: 'PUT', token: activeToken, body: command });
    expect(await save());
    const blocker = await db.owner.connect();
    let stopping;
    let saving;
    try {
      await blocker.query('BEGIN');
      await lockAccountActivity(blocker, account);
      stopping = api.admin(root + '/disable', 'POST');
      await waitForAdvisoryWaiter(db.owner, 'ExclusiveLock');
      saving = save();
      await waitForAdvisoryWaiter(db.owner, 'ShareLock');
      await blocker.query('COMMIT');
      assert.equal(expect(await stopping).disabled, true);
      expect(await saving, 403, 'account_disabled');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled([stopping, saving]);
    }
    expect(await api.request('/v1/workspace', { token: activeToken }), 401, 'session_required');
    const spare = await issue(api, '停用账号备用');
    expect(await api.login('courier', spare.code), 403, 'account_disabled');
    const invalidKey = { account, id: randomUUID(), draftId: workspace.draft.id };
    await assert.rejects(new AgentStore(db.app).append(invalidKey, 'step', {}), { code: 'account_disabled' });
    await assert.rejects(new MaterialStore(db.app).append(account, randomUUID(), 0, Buffer.from([1])), { code: 'account_disabled' });
    await db.owner.query(`INSERT INTO dispatch.sessions (token_digest, account_id, expires_at)
      VALUES ($1, $2, now() + interval '1 hour')`, [sha256(activeToken), account]);
    expect(await api.request('/v1/workspace', { token: activeToken }), 403, 'account_disabled');
    assert.equal(expect(await api.admin(root + '/enable', 'POST')).disabled, false);
    expect(await api.request('/v1/workspace', { token: activeToken }), 401, 'session_required');
    activeToken = expect(await api.login('courier', spare.code), 201).token;
    assert.equal(expect(await api.admin('/activation-codes')).records.find(row => row.id === spare.record.id).status, 'unused');
    const store = new DraftStore(db.app);
    await businessSession.run({}, async () => {
      await store.accountFor(activeToken, appId);
      expect(await api.admin(root + '/disable', 'POST'));
      expect(await api.admin(root + '/enable', 'POST'));
      await assert.rejects(writeAccount(db.app, account, randomUUID(), { action: 'stale-test' }, () => {
        assert.fail('a stale generation must not write');
      }), { code: 'session_required' });
    });
    activeToken = expect(await api.login('courier'), 201).token;
    expect(await api.admin(root, 'PATCH', { remarkName: '  甲配送  ' }, { Origin: api.origin }));
    const entry = expect(await api.admin('/accounts')).accounts.find(row => row.id === account);
    assert.equal(entry.remarkName, '甲配送');
    assert.equal(entry.activated, true);
    assert.equal(entry.disabled, false);
    assert.ok(entry.lastActiveAt);
    assert.equal(entry.catalogProductCount, 0);
    assert.equal(entry.openMistakeCount, 0);
    await assert.rejects(db.app.query('UPDATE dispatch.accounts SET identity_subject = identity_subject WHERE id = $1', [account]), { code: '42501' });
    await assert.rejects(db.app.query('DELETE FROM dispatch.accounts WHERE id = $1', [account]), { code: '42501' });
    await assert.rejects(db.app.query('UPDATE dispatch.activation_codes SET remark_name = remark_name'), { code: '42501' });
  });

  await t.test('creates a delivered snapshot through the business API for read-only admin queries', async () => {
    const request = (path, body, method = 'POST') => api.request(path, { method, token: activeToken, body }).then(response => expect(response));
    const current = expect(await api.request('/v1/workspace', { token: activeToken })).draft;
    draft = (await request('/v1/drafts/' + current.id, { requestId: randomUUID(), revision: current.revision,
      customers: [{ id: randomUUID(), customer: '私密安福门店', partyId: null, items: [{ id: randomUUID(), product: '鱼豆腐', brand: '安井',
        specification: '500g', unit: '箱', quantity: '2', price: '17.80' }] }] }, 'PUT')).draft;
    const preview = (await request('/v1/trips/preview', { draftId: draft.id, revision: draft.revision, requestId: randomUUID() })).preview;
    await request('/v1/trips/confirm', { previewId: preview.previewId, requestId: randomUUID() });
    assert.equal(expect(await api.admin('/accounts/' + account + '/dashboard')).pulse.stage, 'delivering');
    await request(`/v1/trips/${draft.id}/sheets/${draft.customers[0].id}/delivery/apply`,
      { requestId: randomUUID(), version: 1, statusRevision: 0, complete: true, edits: [] });
    const home = expect(await api.admin('/accounts/' + account + '/dashboard'));
    assert.equal(home.pulse.stage, 'all_delivered');
    assert.equal(home.pulse.deliveredCount, 1);
    assert.equal(home.pulse.knownAmountCents, 3560);
    const records = expect(await api.admin('/accounts/' + account + '/customers')).customers;
    assert.equal(records.length, 1);
    assert.equal(records[0].deliveredTripCount, 1);
    assert.equal(records[0].lastDeliveredAtBasis, 'delivery_completed_at');
    customerId = records[0].id;
    otherCustomer = randomUUID();
    await db.owner.query('INSERT INTO dispatch.parties (account_id, id, name) VALUES ($1,$2,$3)',
      [account, otherCustomer, '第二门店']);
    await request('/v1/trips/next-draft', { requestId: randomUUID(), draftId: draft.id });
    draft = expect(await api.request('/v1/workspace', { token: activeToken })).draft;
    await protectFormalTables(db.owner);
  });

  await t.test('validates admin method, authorization, origin and JSON at route boundaries', async () => {
    const root = '/accounts/' + account;
    expect(await api.request(apiPrefix + root + '/catalog'), 401, 'admin_auth_required');
    for (const suffix of ['/overview', '/catalog', '/dashboard', '/scopes/' + draft.id,
      '/turns/' + randomUUID() + '/eval-case', '/materials/' + randomUUID() + '/content']) {
      expect(await api.admin(root + suffix, 'POST', {}), 405, 'method_not_allowed');
    }
    expect(await api.admin('/prompts', 'POST'), 405, 'method_not_allowed');
    expect(await api.admin(root + '/catalog/items', 'POST', {}, { 'Content-Type': 'text/plain' }), 415, 'invalid_content_type');
    expect(await api.admin(root, 'PATCH', { remarkName: '外部' }, { Origin: 'http://example.test' }), 403, 'admin_origin_rejected');
    expect(await api.admin(root, 'PATCH', { remarkName: '外部' }, { 'Sec-Fetch-Site': 'same-origin' }), 403, 'admin_origin_rejected');
    expect(await api.admin(root, 'PATCH', { remarkName: '外部' }, { Origin: api.origin, 'Sec-Fetch-Site': 'cross-site' }),
      403, 'admin_origin_rejected');
  });

  await t.test('incremental CSV, version conflicts with manual and CLI updates, Excel safety and query sandbox', async () => {
    const root = '/accounts/' + account + '/catalog';
    const stock = await new CatalogStore(db.owner).importCsv(account, asCsv([baseRow, secondRow]));
    assert.equal(stock.replayed, false);
    const initial = expect(await api.admin(root));
    assert.equal(initial.catalogRevision, 1);
    assert.equal(initial.items.length, 2);
    firstVariant = initial.items.find(row => row.productCode === 'FISH');
    assert.ok(firstVariant.productId && firstVariant.variantId);
    const changedRow = [...baseRow];
    changedRow[9] = '20.20';
    const csv = asCsv([changedRow]);
    const preview = expect(await api.admin(root + '/import/preview', 'POST', { csv }));
    assert.equal(preview.catalogRevision, 1);
    assert.deepEqual(preview.priceChanges.map(row => [row.oldPriceCents, row.newPriceCents]), [[1980, 2020]]);
    assert.equal(preview.missingUnitCount, 1);
    assert.deepEqual(expect(await api.admin(root)), initial);
    const manualPath = root + '/variants/' + firstVariant.variantId;
    expect(await api.admin(manualPath, 'PATCH', { priceCents: 0 }), 400, 'invalid_input');
    const edited = expect(await api.admin(manualPath, 'PATCH', { priceCents: 1999, expectedRevision: 1 }));
    assert.equal(edited.catalogRevision, 2);
    expect(await api.admin(manualPath, 'PATCH', { priceCents: 2000, expectedRevision: 1 }), 409, 'catalog_changed');
    expect(await api.admin(root + '/import/confirm', 'POST', { csv, previewToken: preview.previewToken, requestId: randomUUID() }),
      409, 'catalog_changed');
    const preCli = expect(await api.admin(root + '/import/preview', 'POST', { csv }));
    const importedAgain = [...baseRow];
    importedAgain[9] = '19.88';
    await new CatalogStore(db.owner).importCsv(account, asCsv([importedAgain, secondRow]));
    expect(await api.admin(root + '/import/confirm', 'POST', { csv, previewToken: preCli.previewToken, requestId: randomUUID() }),
      409, 'catalog_changed');
    const previewToken = expect(await api.admin(root + '/import/preview', 'POST', { csv })).previewToken;
    const requestId = randomUUID();
    const confirm = await Promise.all([1, 2].map(() => api.admin(root + '/import/confirm', 'POST', { csv, previewToken, requestId })));
    const result = expect(confirm[0]);
    assert.deepEqual(expect(confirm[1]), result);
    assert.equal(result.catalogRevision, 4);
    const current = expect(await api.admin(root));
    assert.equal(current.items.length, 2);
    assert.equal(current.items.find(row => row.productCode === 'RICE').unit, null);
    assert.equal(current.items.find(row => row.productCode === 'FISH').priceCents, 2020);
    expect(await api.admin('/accounts/' + otherAccount + '/catalog/import/confirm', 'POST', { csv, previewToken, requestId }),
      400, 'invalid_catalog_preview');
    const badRow = [...baseRow];
    for (const formula of ['=SUM(A1:A2)', '+CMD', '-CMD', '@CMD', '\tformula', '\rformula']) {
      badRow[5] = formula;
      expect(await api.admin(root + '/import/preview', 'POST', { csv: asCsv([badRow]) }), 400, 'invalid_catalog_csv');
    }
    const query = expect(await api.admin(root + '/test-query', 'POST', { query: '安井鱼豆腐500g 2箱' }));
    assert.equal(query.status, 'active');
    assert.equal(query.priceCents, 2020);
    assert.equal(query.priceSource, 'catalog');
    assert.equal(expect(await api.admin(root + '/test-query', 'POST', { query: '安井鱼豆腐500g 2箱', customerId })).priceCents, 1780);
    assert.equal(expect(await api.admin(root + '/test-query', 'POST', { query: '安井鱼豆腐500g 2袋' })).priceCents, null);
    assert.equal(expect(await api.admin(root)).catalogRevision, 4);
    const newItem = expect(await api.admin(root + '/items', 'POST', { product: '=演示商品', brand: '安井',
      priceCents: 123, status: 'discontinued', packaging: '300g', aliases: ['手工别名'], remarks: '-保留原样' }));
    assert.equal(newItem.catalogRevision, 5);
    assert.equal(newItem.item.unit, null);
    expect(await api.admin(root + '/items', 'POST', { productId: newItem.item.productId, variantCode: 'SEC',
      priceCents: 234, unit: '箱', status: 'active' }));
    const revised = expect(await api.admin(manualPath, 'PATCH', { priceCents: 2020, unit: null,
      status: 'discontinued', aliases: ['鱼腐新版'], expectedRevision: 6 }));
    assert.equal(revised.item.unit, null);
    assert.deepEqual(revised.item.aliases, ['鱼腐新版']);
    const csvResponse = await api.admin(root + '/export.csv');
    expect(csvResponse);
    assert.equal(csvResponse.raw.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.match(csvResponse.headers.get('content-disposition'), /attachment/);
    const rows = parseCatalogCsv(csvResponse.data);
    assert.equal(rows.find(row => row.product === '=演示商品').remarks, '-保留原样');
    assert.deepEqual(rows.find(row => row.productCode === 'FISH').aliases, ['鱼腐新版']);
    assert.match(csvResponse.data, /"'=演示商品"/);
    const anchors = await db.owner.query("SELECT 1 FROM dispatch.catalog_imports WHERE account_id = $1 AND source = 'manual'", [account]);
    assert.equal(anchors.rowCount, 1);
  });

  await t.test('customer aliases share normalization and protect a rebound alias from stale deletes', async () => {
    const root = '/accounts/' + account;
    const prices = expect(await api.admin(root + '/customers/' + customerId + '/prices'));
    assert.equal(prices.sales.length, 1);
    assert.equal(prices.sales[0].unitPriceCents, 1780);
    const path = root + '/customer-aliases';
    const saved = expect(await api.admin(path, 'POST', { customerId, alias: ' 私密Ａ店 ' }));
    assert.equal(saved.normalizedAlias, '私密a店');
    expect(await api.admin(path, 'POST', { customerId: otherCustomer, alias: '私密a店' }), 409, 'customer_alias_conflict');
    expect(await api.admin(path, 'POST', { customerId, alias: '第二门店' }), 409, 'customer_name_conflict');
    expect(await api.admin(path, 'POST', { customerId: otherCustomer, alias: '私密a店', allowRebind: true }));
    expect(await api.admin(path, 'DELETE', { customerId, alias: '私密Ａ店' }), 409, 'customer_alias_conflict');
    assert.equal(expect(await api.admin(path, 'DELETE', { customerId: otherCustomer, alias: '私密Ａ店' })).removed.customerId, otherCustomer);
    expect(await api.admin(path, 'POST', { customerId, alias: '私密小名' }));
  });

  await t.test('quality metrics and a frozen, consistently redacted mistake snapshot', async () => {
    const root = '/accounts/' + account;
    const text = '私密安福门店简称私密小名，手机号13812345678，要两箱鱼豆腐';
    const turnId = await addTurn(db.owner, account, draft, { text, undone: true, events: [
      ['model', { inputTokens: 1000, outputTokens: 50, model: 'fixture', toolCalls: [{ arguments: JSON.stringify({ customer: '私密安福门店' }) }] }],
      ['tool', { result: { catalog: [{ draftCustomerId: 'x', lineId: '1', price: '20.20', priceSource: 'catalog' },
        { draftCustomerId: 'x', lineId: '2', price: null, priceSource: null }] } }],
      ['questions', { questions: [{ text: '私密小名要选哪个价？' }] }],
      ['end', { elapsedMs: 40 }],
    ] });
    const runningTurn = await addTurn(db.owner, account, draft, { status: 'running', text });
    await addTurn(db.owner, account, draft, { status: 'failed', timestamp: new Date(Date.now() - 9 * 86_400_000) });
    const all = expect(await api.admin(root + '/quality-turns?filter=all&days=all'));
    assert.ok(all.turns.some(row => row.id === runningTurn));
    assert.equal(all.turns.find(row => row.id === turnId).scopeId, draft.id);
    for (const filter of ['attention', 'unpriced', 'question', 'undone']) {
      assert.deepEqual(expect(await api.admin(root + '/quality-turns?filter=' + filter)).turns.map(row => row.id), [turnId]);
    }
    assert.equal(expect(await api.admin(root + '/quality-turns?filter=failed')).turns.length, 0);
    const home = expect(await api.admin(root + '/dashboard'));
    assert.equal(home.pulse.stage, 'draft');
    assert.equal(home.todos.attentionTurnCount7d, 1);
    assert.equal(home.ai7d.avgElapsedMs, 40);
    assert.equal(home.ai7d.inputTokens, 1000);
    assert.equal(home.ai7d.outputTokens, 50);
    assert.deepEqual([home.ai7d.autoPriceHitRate.numerator, home.ai7d.autoPriceHitRate.denominator], [1, 2]);
    assert.equal(home.ai7d.estimatedCostYuan, 0.0024);
    expect(await api.admin(root + '/mistakes', 'POST', { turnId: runningTurn, category: '其他', expectedOutcome: '不应保存' }), 409, 'turn_running');
    const legacy = expect(await api.admin(root + '/turns/' + turnId + '/eval-case'));
    assert.equal(legacy.task.text, text);
    const payload = { turnId, category: '价格没配上', expectedOutcome: '优先熟客成交价', includeCatalog: true };
    const saved = await Promise.all([api.admin(root + '/mistakes', 'POST', payload), api.admin(root + '/mistakes', 'POST', payload)]);
    mistake = expect(saved[0]);
    assert.deepEqual(expect(saved[1]), mistake);
    const serialized = JSON.stringify(mistake.caseJson);
    assert.ok(serialized.includes('门店甲') && serialized.includes('简称') && serialized.includes('联系电话'));
    for (const privateValue of ['私密安福门店', '私密小名', '13812345678']) assert.ok(!serialized.includes(privateValue));
    assert.equal(expect(await api.admin(root + '/dashboard')).todos.openMistakeCount, 1);
    assert.equal(expect(await api.admin(root + '/quality-turns')).turns[0].mistakeStatus, 'open');
    const replay = expect(await api.admin(root + '/mistakes', 'POST', { ...payload, expectedOutcome: '被忽略' }));
    assert.deepEqual(replay, mistake);
    const path = root + '/mistakes/' + turnId;
    expect(await api.admin(path, 'PATCH', { caseJson: {} }), 400, 'invalid_input');
    const patched = expect(await api.admin(path, 'PATCH', { note: '人工复核完成', status: 'resolved' }));
    assert.deepEqual(patched.caseJson, mistake.caseJson);
    assert.equal(expect(await api.admin(root + '/mistakes?status=resolved')).mistakes.length, 1);
    const exported = await api.admin(path + '/export');
    assert.match(exported.headers.get('content-disposition'), /case-.*\.json/);
    const fixture = expect(exported);
    assert.equal(fixture.meta.mistake.status, 'resolved');
    assert.deepEqual(fixture.task, mistake.caseJson.task);
    const scoped = (id, sql, params = []) => transaction(db.app, async client => {
      if (id) await setAccount(client, id);
      return client.query(sql, params);
    });
    await assert.rejects(scoped(account, "UPDATE dispatch.mistake_cases SET case_json = '{}'"), { code: '42501' });
    await assert.rejects(scoped(account, 'DELETE FROM dispatch.mistake_cases'), { code: '42501' });
    for (const id of [null, otherAccount]) {
      assert.equal((await scoped(id, 'SELECT * FROM dispatch.mistake_cases')).rowCount, 0);
      assert.equal((await scoped(id, "UPDATE dispatch.mistake_cases SET note = ''")).rowCount, 0);
    }
    expect(await api.admin('/accounts/' + otherAccount + '/mistakes/' + turnId + '/export'), 404, 'mistake_not_found');
  });

  await t.test('account and activation writes also pass the formal-table mutation guard', async () => {
    const root = '/accounts/' + otherAccount;
    expect(await api.admin(root, 'PATCH', { remarkName: '另一位配送员' }));
    expect(await api.admin(root + '/disable', 'POST'));
    expect(await api.admin(root + '/enable', 'POST'));
    const fresh = await issue(api, '守卫测试');
    const next = expect(await api.admin('/activation-codes/' + fresh.record.id + '/reissue', 'POST'));
    expect(await api.admin('/activation-codes/' + next.record.id + '/revoke', 'POST'));
  });

  active = false;
  await api.stop();
  for (const table of formalTables) {
    await db.owner.query(`DROP TRIGGER IF EXISTS reject_admin_formal_write ON dispatch.${table}`);
  }
  await t.test('development login skips activation and respects disable', async () => {
    const dev = await start(db, undefined, { requireActivation: true });
    try {
      const login = () => dev.request('/v1/session/development', { method: 'POST', body: { account: 'a' } });
      const session = expect(await login(), 201);
      const a = expect(await dev.admin('/accounts')).accounts.find(row => row.provider === 'development');
      assert.equal(a.activated, true);
      expect(await dev.admin('/accounts/' + a.id + '/disable', 'POST'));
      expect(await login(), 403, 'account_disabled');
      expect(await dev.request('/v1/workspace', { token: session.token }), 401, 'session_required');
      expect(await dev.admin('/accounts/' + a.id + '/enable', 'POST'));
      expect(await login(), 201);
    } finally {
      await dev.stop();
    }
  });
});
