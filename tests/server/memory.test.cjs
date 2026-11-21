const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { Pool } = require('pg');
const { AmendmentStore } = require('../../code/server-dist/server/amendments');
const { requireApplicationRole, setAccount, transaction } = require('../../code/server-dist/server/database');
const { DeliveryStore } = require('../../code/server-dist/server/delivery');
const { DraftStore } = require('../../code/server-dist/server/drafts');
const { MemoryStore } = require('../../code/server-dist/server/memory');
const { migrate } = require('../../code/server-dist/server/migrate');
const { readAmendmentInput, readSaveDraft } = require('../../code/server-dist/server/draft-input');
const { readDeliveryEdit } = require('../../code/server-dist/server/request-input');
const { TripStore } = require('../../code/server-dist/server/trips');

function adminUrl() {
  const url = new URL(process.env.DISPATCH_TEST_ADMIN_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'The test cluster must be local');
  assert.notEqual(url.pathname, '/dispatch_local');
  return url;
}

const pause = (ms) => new Promise(done => setTimeout(done, ms));

async function ensureSharedRole(admin) {
  const hasRole = async () => (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'dispatch_app'")).rowCount > 0;
  if (await hasRole()) return;

  // Yield on a fresh cluster so a concurrent server suite finishes creating dispatch_app in 001_drafts.sql without racing.
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

async function isolatedDatabase(t, restore) {
  const url = adminUrl();
  const name = `dispatch_test_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const admin = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  let db, pool;
  t.after(async () => {
    try {
      await pool?.end();
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
  if (restore) restore(name);
  try {
    await migrate(db);
  } catch (error) {
    // Another database in the same test cluster may have just created the shared role.
    if (error.constraint !== 'pg_authid_rolname_index' && error.code !== '42710') throw error;
    const { rowCount } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'dispatch_app'");
    if (!rowCount) throw error;
    await migrate(db);
  }
  await admin.query(`GRANT dispatch_app TO ${name}`);
  url.username = name;
  url.password = password;
  pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  await requireApplicationRole(pool);
  return {
    name, db, pool, memory: new MemoryStore(pool), drafts: new DraftStore(pool), trips: new TripStore(pool),
    delivery: new DeliveryStore(pool), amendments: new AmendmentStore(pool),
  };
}

function runPostgresClient(tool, database, args, input) {
  assert.match(database, /^dispatch_test_[0-9a-f]{16}$/);
  const url = adminUrl();
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
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  const directory = process.env.DISPATCH_TEST_PG_BIN;
  const options = { input, env: { ...env, ...connection }, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 };
  const toolArgs = ['--no-password', ...args];
  const result = container
    ? spawnSync('docker', ['exec', '-i', ...Object.keys(connection).flatMap(key => ['-e', key]), container, tool, ...toolArgs], options)
    : spawnSync(directory ? resolve(directory, tool) : tool, toolArgs, options);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${tool} failed: ${result.stderr.toString()}`);
  return result.stdout;
}

async function login(stores, subject) {
  const { token } = await stores.drafts.developmentSession(subject);
  return stores.drafts.accountFor(token);
}

const productQuery = (productName = '水饺') => ({ productName, brand: '安井', spec: '500G', unit: '箱' });
const line = (id, product, price) => ({ id, product, price, brand: '安井', specification: '500g', unit: '箱', quantity: '2' });
const customer = (id, name, partyId, items) => ({ id, customer: name, partyId, items });
const command = () => ({ requestId: randomUUID() });

async function save(stores, accountId, customers) {
  const { draft } = await stores.trips.workspace(accountId);
  return stores.drafts.save(accountId, readSaveDraft(draft.id, { ...command(), revision: draft.revision, customers }));
}

async function preview(stores, accountId, draft) {
  return stores.trips.preview(accountId, { ...command(), draftId: draft.id, revision: draft.revision });
}

async function issue(stores, accountId, customers) {
  const draft = await save(stores, accountId, customers);
  const { previewId } = await preview(stores, accountId, draft);
  const formal = await stores.trips.confirm(accountId, { ...command(), previewId });
  await stores.trips.nextDraft(accountId, { ...command(), draftId: draft.id });
  return formal;
}

function freshCustomer(id, name, price = '80') {
  return customer(id, name, null, [line(`${id}-line`, '水饺', price)]);
}

function scoped(pool, accountId, work) {
  return transaction(pool, async client => {
    await client.query('SET LOCAL ROLE dispatch_app');
    await setAccount(client, accountId);
    return work(client);
  });
}

test('migration 011 can be rerun with existing aliases and registers once', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { sheets: [sheet] } = await issue(stores, accountId, [freshCustomer('a', '裕丰餐饮')]);
  const binding = await stores.memory.bindCustomerAlias(accountId, { ...command(), customerId: sheet.partyId, alias: '小裕' });
  const migration = '011_customer_aliases.sql';
  const sql = await readFile(resolve(__dirname, '../../code/server/migrations', migration), 'utf8');
  await migrate(stores.db);
  await transaction(stores.db, client => client.query(sql));
  const count = await stores.db.query('SELECT name FROM dispatch.schema_migrations WHERE name = $1', [migration]);
  assert.deepEqual(count.rows, [{ name: migration }]);
  assert.deepEqual(await stores.memory.listCustomerAliases(accountId), [binding]);
  assert.deepEqual((await stores.db.query(`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'dispatch.customer_aliases'::regclass
  `)).rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
});

test('explicit alias writes serialize, replay and enforce both conflict checks', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { sheets } = await issue(stores, accountId, [freshCustomer('a', '丰桥酒楼'), freshCustomer('b', '泉盛酒店')]);
  const [first, second] = sheets.map(sheet => sheet.partyId);
  const { memory } = stores;
  const bind = (customerId, alias, extra) => memory.bindCustomerAlias(accountId, { ...command(), customerId, alias, ...extra });
  const input = { ...command(), customerId: first, alias: ' ＦＱ  店 ' };
  const bound = await memory.bindCustomerAlias(accountId, input);
  assert.deepEqual(bound, { customerId: first, alias: ' ＦＱ  店 ', normalizedAlias: 'fq 店' });
  assert.deepEqual(await memory.resolveCustomerMention(accountId, 'fq 店'), {
    status: 'resolved', customerId: first, canonicalName: '丰桥酒楼', matchedBy: 'alias', matchedAlias: input.alias,
  });
  assert.deepEqual(await memory.bindCustomerAlias(accountId, input), bound);
  assert.deepEqual(await bind(first, 'fq 店'), bound);
  await assert.rejects(memory.bindCustomerAlias(accountId, { ...input, alias: '变更' }), { code: 'request_conflict' });
  await assert.rejects(memory.unbindCustomerAlias(accountId, input), { code: 'request_conflict' });
  await assert.rejects(bind(second, 'fq 店'), { code: 'customer_alias_conflict' });
  const rebound = await bind(second, 'fq 店', { allowRebind: true });
  assert.equal(rebound.customerId, second);
  assert.equal((await memory.resolveCustomerMention(accountId, 'fq 店')).customerId, second);
  assert.deepEqual(await memory.bindCustomerAlias(accountId, input), bound);

  await assert.rejects(bind(second, '丰桥酒楼', { allowRebind: true }), { code: 'customer_name_conflict' });
  await bind(first, '泉盛酒店', { allowCanonicalConflict: true });
  assert.equal((await memory.resolveCustomerMention(accountId, '泉盛酒店')).status, 'ambiguous');
  await bind(first, '丰桥酒楼');
  assert.equal((await memory.resolveCustomerMention(accountId, '丰桥酒楼')).matchedBy, 'canonical');

  const race = await Promise.allSettled([bind(first, '北门便利'), bind(second, '　北门便利　')]);
  assert.equal(race.filter(entry => entry.status === 'fulfilled').length, 1);
  assert.equal(race.find(entry => entry.status === 'rejected').reason.code, 'customer_alias_conflict');
  assert.equal((await memory.listCustomerAliases(accountId)).filter(alias => alias.normalizedAlias === '北门便利').length, 1);

  const unbind = { ...command(), alias: 'ＦＱ 店' };
  const removed = await memory.unbindCustomerAlias(accountId, unbind);
  assert.deepEqual(removed, { removed: rebound });
  assert.equal((await memory.resolveCustomerMention(accountId, 'fq 店')).status, 'new_customer');
  await bind(first, 'fq 店');
  assert.deepEqual(await memory.unbindCustomerAlias(accountId, unbind), removed);
  assert.equal((await memory.resolveCustomerMention(accountId, 'fq 店')).customerId, first);

  const before = await memory.customerDirectory(accountId);
  assert.equal((await memory.resolveCustomerMention(accountId, '丰桥')).status, 'candidate_only');
  assert.equal((await memory.resolveCustomerMention(accountId, '新店')).status, 'new_customer');
  assert.deepEqual(await memory.customerDirectory(accountId), before);
});

test('memory services and PostgreSQL RLS isolate aliases, parties and formal prices by account', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const [a, b] = await Promise.all([login(stores, 'a'), login(stores, 'b')]);
  const aTrip = await issue(stores, a, [freshCustomer('shared', '裕丰店', '78')]);
  const bTrip = await issue(stores, b, [freshCustomer('shared', '裕丰店', '51')]);
  const aId = aTrip.sheets[0].partyId;
  const bId = bTrip.sheets[0].partyId;
  const { memory } = stores;
  const binding = await memory.bindCustomerAlias(a, { ...command(), customerId: aId, alias: '饭店北门' });
  const own = await memory.bindCustomerAlias(b, { ...command(), customerId: bId, alias: '乙号' });
  assert.deepEqual(await memory.customerDirectory(b), { customers: [{ id: bId, name: '裕丰店' }], aliases: [own] });
  assert.equal((await memory.resolveCustomerMention(b, '饭店北门')).status, 'new_customer');
  await assert.rejects(memory.bindCustomerAlias(b, { ...command(), customerId: aId, alias: '乙号', allowRebind: true }),
    { code: 'customer_not_found' });
  assert.deepEqual(await memory.unbindCustomerAlias(b, { ...command(), alias: '饭店北门' }), { removed: null });
  assert.deepEqual(await memory.lookupHistoricalPrice(b, aId, productQuery()), { status: 'no_match' });
  assert.equal((await memory.lookupHistoricalPrice(b, bId, productQuery())).unitPriceCents, 5100);
  const [foreignSuggestion] = await memory.suggestCustomerPrices(b,
    [{ id: 'foreign', customerId: aId, items: [{ id: 'missing', ...productQuery(), unitPriceCents: null }] }]);
  assert.deepEqual(foreignSuggestion, {
    draftCustomerId: 'foreign', lineId: 'missing', customerId: null, status: 'unresolved_customer',
  });

  await scoped(stores.pool, b, async client => {
    const aliases = await client.query('SELECT alias FROM dispatch.customer_aliases');
    assert.deepEqual(aliases.rows, [{ alias: own.alias }]);
    const versions = await client.query('SELECT trip_id FROM dispatch.trip_versions');
    assert.deepEqual(versions.rows, [{ trip_id: bTrip.trip.id }]);
    const sheets = await client.query('SELECT party_id FROM dispatch.sheets');
    assert.deepEqual(sheets.rows, [{ party_id: bId }]);
    const update = await client.query('UPDATE dispatch.customer_aliases SET alias = $2 WHERE account_id = $1', [a, '篡改']);
    assert.equal(update.rowCount, 0);
    assert.equal((await client.query('DELETE FROM dispatch.customer_aliases WHERE account_id = $1', [a])).rowCount, 0);
    assert.equal((await client.query('UPDATE dispatch.trips SET delivery_edits = $2 WHERE account_id = $1', [a, '{}'])).rowCount, 0);
  });
  await assert.rejects(scoped(stores.pool, b, client =>
    client.query('DELETE FROM dispatch.trip_versions WHERE account_id = $1', [a])), { code: '42501' });
  const insert = `INSERT INTO dispatch.customer_aliases (account_id, customer_id, alias, normalized_alias)
    VALUES ($1, $2, '外来', '外来')`;
  await assert.rejects(scoped(stores.pool, b, client => client.query(insert, [a, aId])), { code: '42501' });
  await assert.rejects(scoped(stores.pool, b, client => client.query(insert, [b, aId])), { code: '23503' });
  await assert.rejects(scoped(stores.pool, b, client =>
    client.query('UPDATE dispatch.customer_aliases SET customer_id = $1', [aId])), { code: '23503' });
  const otherBinding = await memory.bindCustomerAlias(b, { ...command(), customerId: bId, alias: '饭店北门' });
  assert.equal(otherBinding.normalizedAlias, binding.normalizedAlias);
  assert.deepEqual(await memory.listCustomerAliases(a), [binding]);
  assert.equal((await memory.lookupHistoricalPrice(a, aId, productQuery())).unitPriceCents, 7800);
});

test('confirmed order versions and live delivery edits supply read-only draft price suggestions', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const a = await login(stores, 'a');
  const name = '东街餐饮';
  const firstItems = [
    line('old-dumplings', '水饺', '80'), line('old-return', '萝卜', '61'),
    line('old-amendment', '米糕', '72'), line('old-removed', '粉条', '30'),
  ];
  const old = await issue(stores, a, [customer('old', name, null, firstItems)]);
  const aId = old.sheets[0].partyId;
  const { memory } = stores;
  const lookup = (productName) => memory.lookupHistoricalPrice(a, aId, productQuery(productName));
  assert.equal(old.trip.versions[0].customers[0].partyId, undefined);
  assert.equal((await lookup('水饺')).unitPriceCents, 8000);

  const latestItems = [
    line('repriced', '水饺', '80'), line('filled', '馄饨', null), line('returned', '萝卜', '68'),
    line('no-price', '年糕', null), line('new-amendment', '米糕', '79'),
  ];
  const latest = await issue(stores, a, [customer('latest', name, aId, latestItems), freshCustomer('other', '另一个店', '97')]);
  const pending = await issue(stores, a, [customer('pending', name, aId, [line('pending-line', '葱油饼', '70')])]);
  assert.equal((await lookup('葱油饼')).unitPriceCents, 7000);
  await stores.delivery.review(a, pending.trip.id, 'pending', { ...command(), version: 1, statusRevision: 0 });
  assert.equal((await lookup('葱油饼')).status, 'no_match');
  assert.equal((await lookup('馄饨')).status, 'no_match');
  assert.equal((await lookup('萝卜')).unitPriceCents, 6800);

  const oldSheet = { tripId: old.trip.id, sheetId: 'old' };
  const amendmentInput = readAmendmentInput({
    ...command(), version: 1, statusRevision: 0,
    items: firstItems.slice(0, -1).map(item => item.id === 'old-amendment' ? { ...item, price: '77' } : item),
  });
  const amendment = await stores.amendments.preview(a, oldSheet, amendmentInput);
  assert.equal((await lookup('米糕')).previousDistinctPrice.unitPriceCents, 7200);
  const corrected = await stores.amendments.confirm(a, oldSheet, { ...command(), previewId: amendment.previewId });
  assert.equal(corrected.version, 2);
  const amendedPrice = await lookup('米糕');
  assert.equal(amendedPrice.unitPriceCents, 7900);
  assert.equal(amendedPrice.previousDistinctPrice.unitPriceCents, 7700);
  assert.equal(amendedPrice.previousDistinctPrice.tripId, old.trip.id);
  assert.equal(Date.parse(amendedPrice.previousDistinctPrice.issuedAt), Date.parse(old.trip.versions[0].savedAt));
  assert.equal((await lookup('粉条')).status, 'no_match');

  let statusRevision = 0;
  for (const [lineId, receivedQuantity, price] of [['repriced', '2', '78'], ['filled', '1', '78'], ['returned', '0', '68']]) {
    const result = await stores.delivery.editLine(a, latest.trip.id, 'latest',
      readDeliveryEdit({ ...command(), version: 1, statusRevision, lineId, receivedQuantity, price }));
    statusRevision = result.statusRevision;
  }
  const repriced = await lookup('水饺');
  assert.equal(repriced.unitPriceCents, 7800);
  assert.equal(repriced.tripId, latest.trip.id);
  assert.equal(repriced.sheetId, 'latest');
  assert.equal(Date.parse(repriced.issuedAt), Date.parse(latest.trip.versions[0].savedAt));
  assert.equal(repriced.previousDistinctPrice.unitPriceCents, 8000);
  assert.equal((await lookup('馄饨')).unitPriceCents, 7800);
  assert.equal((await lookup('萝卜')).unitPriceCents, 6100);
  assert.equal((await lookup('年糕')).status, 'no_match');

  await memory.bindCustomerAlias(a, { ...command(), customerId: aId, alias: '东门老店' });
  const current = customer('current', name, aId, [line('explicit', '水饺', '99'), line('missing', '水饺', null)]);
  const draft = await save(stores, a, [current]);
  const unconfirmed = await preview(stores, a, draft);
  assert.equal(unconfirmed.customers[0].items[0].unitPriceCents, 9900);
  assert.deepEqual(await lookup('水饺'), repriced);
  assert.deepEqual((await memory.suggestDraftPrices(a, draft.id)).suggestions.map(row => [row.lineId, row.unitPriceCents]), [['missing', 7800]]);

  const changes = await save(stores, a, [
    current, customer('alias', '东门老店', undefined, [line('unresolved', '水饺', null)]),
  ]);
  const storedDraft = () => stores.db.query('SELECT draft_revision, draft_customers FROM dispatch.workspaces WHERE account_id = $1', [a]);
  const before = (await storedDraft()).rows;
  assert.equal(before[0].draft_customers[0].items[1].price, null);
  const suggestions = await memory.suggestDraftPrices(a, changes.id);
  assert.equal(suggestions.revision, changes.revision);
  assert.deepEqual(suggestions.suggestions.map(row => [row.draftCustomerId, row.lineId, row.status, row.unitPriceCents]), [
    ['current', 'missing', 'exact_match', 7800], ['alias', 'unresolved', 'unresolved_customer', undefined],
  ]);
  const mentions = await memory.suggestDraftCustomers(a, changes.id);
  assert.equal(mentions.revision, changes.revision);
  assert.deepEqual(mentions.suggestions.map(row => [row.draftCustomerId, row.resolution.customerId]), [['alias', aId]]);
  assert.deepEqual(await lookup('水饺'), repriced);
  assert.deepEqual((await storedDraft()).rows, before);
});

test('draft price lookup includes stored empty and whitespace prices without rewriting them', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const name = '裕丰餐饮';
  const { sheets: [sheet] } = await issue(stores, accountId, [freshCustomer('old', name, '78')]);
  const customers = [customer('current', name, sheet.partyId, [
    line('missing', '水饺', null), line('empty', '水饺', ''), line('blank', '水饺', '   '), line('priced', '水饺', '80'),
  ])];
  const saved = await save(stores, accountId, customers);
  assert.deepEqual(saved.customers[0].items.map(item => item.price), [null, null, null, '80']);

  // DraftStore.save normalizes these inputs today. Seed a stored draft that retained the validated raw form values.
  const { draft } = readSaveDraft(saved.id, { ...command(), revision: saved.revision, customers });
  await scoped(stores.pool, accountId, async client => {
    const result = await client.query(`
      UPDATE dispatch.workspaces SET draft_customers = $3
      WHERE draft_id = $1 AND draft_revision = $2
    `, [draft.id, draft.revision, JSON.stringify(draft.customers)]);
    assert.equal(result.rowCount, 1);
  });
  const readStored = () => stores.db.query(
    'SELECT draft_revision, draft_customers FROM dispatch.workspaces WHERE account_id = $1 AND draft_id = $2',
    [accountId, saved.id]);
  const before = (await readStored()).rows;
  assert.deepEqual(before[0].draft_customers[0].items.map(item => item.price), [null, '', '   ', '80']);

  const result = await stores.memory.suggestDraftPrices(accountId, saved.id);
  assert.equal(result.revision, saved.revision);
  assert.deepEqual(result.suggestions.map(row => [row.draftCustomerId, row.lineId, row.status, row.unitPriceCents]), [
    ['current', 'missing', 'exact_match', 7800], ['current', 'empty', 'exact_match', 7800],
    ['current', 'blank', 'exact_match', 7800],
  ]);
  assert.deepEqual((await readStored()).rows, before);
});

test('pg_dump and pg_restore retain aliases, idempotency, constraints and forced RLS', { timeout: 30_000 }, async t => {
  const source = await isolatedDatabase(t);
  const [a, b] = await Promise.all([login(source, 'a'), login(source, 'b')]);
  const { sheets: [sheet] } = await issue(source, a, [freshCustomer('a', '王记餐饮')]);
  const input = { ...command(), customerId: sheet.partyId, alias: '老王' };
  const bound = await source.memory.bindCustomerAlias(a, input);
  const archive = runPostgresClient('pg_dump', source.name, ['--format=custom', '--schema=dispatch']);
  assert.equal(archive.subarray(0, 5).toString(), 'PGDMP');
  const restored = await isolatedDatabase(t, name => {
    assert.notEqual(name, source.name);
    runPostgresClient('pg_restore', name, ['--dbname', name, '--single-transaction', '--exit-on-error', '--no-owner'], archive);
  });

  assert.deepEqual(await restored.memory.listCustomerAliases(a), [bound]);
  assert.deepEqual(await restored.memory.bindCustomerAlias(a, input), bound);
  assert.equal((await restored.memory.resolveCustomerMention(a, '老王')).canonicalName, '王记餐饮');
  assert.equal((await restored.memory.lookupHistoricalPrice(a, sheet.partyId, productQuery())).unitPriceCents, 8000);
  assert.deepEqual((await restored.db.query(`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'dispatch.customer_aliases'::regclass
  `)).rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
  await scoped(restored.pool, b, async client => {
    assert.equal((await client.query('SELECT * FROM dispatch.customer_aliases')).rowCount, 0);
    assert.equal((await client.query('DELETE FROM dispatch.customer_aliases')).rowCount, 0);
  });
  const copy = `INSERT INTO dispatch.customer_aliases (account_id, customer_id, alias, normalized_alias)
    VALUES ($1, $2, '老王', '老王')`;
  await assert.rejects(scoped(restored.pool, a, client => client.query(copy, [a, sheet.partyId])), { code: '23505' });
  await assert.rejects(scoped(restored.pool, b, client => client.query(copy, [b, sheet.partyId])), { code: '23503' });
  await assert.rejects(scoped(restored.pool, b, client => client.query(copy, [a, sheet.partyId])), { code: '42501' });
  const removed = await restored.memory.unbindCustomerAlias(a, { ...command(), alias: '老王' });
  assert.deepEqual(removed, { removed: bound });
});

test('customer choice links a known party, remembers the spoken name and replays idempotently', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { sheets } = await issue(stores, accountId, [freshCustomer('a', '王记餐饮'), freshCustomer('b', '泉盛酒店')]);
  const [wang, quan] = sheets.map(sheet => sheet.partyId);
  const draft = await save(stores, accountId, [customer('picked', '老王', undefined, [line('picked-line', '水饺', '80')])]);
  const { memory } = stores;
  const input = { requestId: randomUUID(), draftId: draft.id, revision: draft.revision,
    draftCustomerId: 'picked', choice: 'existing', customerId: wang, remember: true };
  const result = await memory.chooseDraftCustomer(accountId, input);
  assert.deepEqual(result, { revision: draft.revision + 1, remembered: true });
  assert.deepEqual(await memory.chooseDraftCustomer(accountId, input), result);
  await assert.rejects(memory.chooseDraftCustomer(accountId, { ...input, customerId: quan }), { code: 'request_conflict' });
  await assert.rejects(memory.chooseDraftCustomer(accountId, { ...input, remember: false }), { code: 'request_conflict' });

  const workspace = await stores.trips.workspace(accountId);
  assert.equal(workspace.draft.revision, draft.revision + 1);
  assert.equal(workspace.draft.customers[0].customer, '王记餐饮');
  assert.equal(workspace.draft.customers[0].partyId, wang);
  assert.deepEqual(await memory.listCustomerAliases(accountId), [
    { customerId: wang, alias: '老王', normalizedAlias: '老王' },
  ]);
  const { rows: [card] } = await stores.db.query(
    'SELECT kind, payload FROM dispatch.agent_events WHERE account_id = $1 ORDER BY seq DESC LIMIT 1', [accountId]);
  assert.equal(card.kind, 'card');
  assert.deepEqual(card.payload, { action: 'customer-choice', choice: 'existing', remembered: true });
});

test('customer choice rebinds a remembered name when the courier explicitly picks another party', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { sheets } = await issue(stores, accountId, [freshCustomer('a', '王记餐饮'), freshCustomer('b', '泉盛酒店')]);
  const [wang, quan] = sheets.map(sheet => sheet.partyId);
  const first = await stores.memory.bindCustomerAlias(accountId,
    { ...command(), customerId: quan, alias: '老王' });
  const draft = await save(stores, accountId, [customer('picked', '老王', undefined, [line('picked-line', '水饺', '80')])]);
  const result = await stores.memory.chooseDraftCustomer(accountId, {
    requestId: randomUUID(), draftId: draft.id, revision: draft.revision,
    draftCustomerId: 'picked', choice: 'existing', customerId: wang, remember: true,
  });
  assert.deepEqual(result, { revision: draft.revision + 1, remembered: true });
  assert.deepEqual(await stores.memory.listCustomerAliases(accountId), [
    { customerId: wang, alias: first.alias, normalizedAlias: first.normalizedAlias },
  ]);
  assert.equal((await stores.memory.resolveCustomerMention(accountId, '老王')).customerId, wang);
});

test('customer choice rebinds a stale single-character alias matching the chosen canonical name', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { sheets: [old] } = await issue(stores, accountId, [freshCustomer('old', '甲店')]);
  await stores.memory.bindCustomerAlias(accountId, { ...command(), customerId: old.partyId, alias: 'Ａ' });
  const { sheets: [target] } = await issue(stores, accountId, [freshCustomer('target', 'A')]);
  assert.equal((await stores.memory.resolveCustomerMention(accountId, 'Ａ')).status, 'ambiguous');
  const draft = await save(stores, accountId, [customer('picked', ' Ａ ', undefined, [line('picked-line', '水饺', '80')])]);
  const result = await stores.memory.chooseDraftCustomer(accountId, {
    ...command(), draftId: draft.id, revision: draft.revision, draftCustomerId: 'picked',
    choice: 'existing', customerId: target.partyId, remember: true,
  });
  assert.deepEqual(result, { revision: draft.revision + 1, remembered: true });
  assert.deepEqual(await stores.memory.listCustomerAliases(accountId), [
    { customerId: target.partyId, alias: 'Ａ', normalizedAlias: 'a' },
  ]);
  const resolved = await stores.memory.resolveCustomerMention(accountId, ' Ａ ');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.customerId, target.partyId);
});

test('customer choice keeps the draft link when the spoken name conflicts with another canonical name', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { sheets } = await issue(stores, accountId, [freshCustomer('a', '王记餐饮'), freshCustomer('b', '泉盛酒店')]);
  const [wang] = sheets.map(sheet => sheet.partyId);
  const draft = await save(stores, accountId, [customer('picked', '泉盛酒店', undefined, [line('picked-line', '水饺', '80')])]);
  const result = await stores.memory.chooseDraftCustomer(accountId, {
    requestId: randomUUID(), draftId: draft.id, revision: draft.revision,
    draftCustomerId: 'picked', choice: 'existing', customerId: wang, remember: true,
  });
  assert.deepEqual(result, { revision: draft.revision + 1, remembered: false, rememberIssue: 'name_conflict' });
  const workspace = await stores.trips.workspace(accountId);
  assert.equal(workspace.draft.customers[0].customer, '王记餐饮');
  assert.equal(workspace.draft.customers[0].partyId, wang);
  assert.deepEqual(await stores.memory.listCustomerAliases(accountId), []);
});

test('customer choice can mark a new customer or unlink one without touching aliases', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { sheets: [sheet] } = await issue(stores, accountId, [freshCustomer('a', '王记餐饮')]);
  const wang = sheet.partyId;
  const { memory } = stores;
  const fresh = await save(stores, accountId, [customer('fresh', '阿强', undefined, [line('fresh-line', '汤圆', '20')])]);
  assert.deepEqual(await memory.chooseDraftCustomer(accountId, {
    requestId: randomUUID(), draftId: fresh.id, revision: fresh.revision, draftCustomerId: 'fresh', choice: 'new',
  }), { revision: fresh.revision + 1, remembered: null });
  const created = await stores.trips.workspace(accountId);
  assert.equal(created.draft.customers[0].customer, '阿强');
  assert.equal(created.draft.customers[0].partyId, null);

  const linked = await save(stores, accountId, [customer('linked', '王记餐饮', wang, [line('linked-line', '水饺', '80')])]);
  assert.deepEqual(await memory.chooseDraftCustomer(accountId, {
    requestId: randomUUID(), draftId: linked.id, revision: linked.revision, draftCustomerId: 'linked',
    choice: 'unlink', spoken: ' 老王 ',
  }), { revision: linked.revision + 1, remembered: null });
  const unlinked = await stores.trips.workspace(accountId);
  assert.equal(unlinked.draft.customers[0].customer, '老王');
  assert.equal('partyId' in unlinked.draft.customers[0], false);
  assert.deepEqual(await memory.listCustomerAliases(accountId), []);
});

test('customer choice merges the selected draft customer into the existing sheet for that party', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { sheets: [sheet] } = await issue(stores, accountId, [freshCustomer('a', '王记餐饮')]);
  const wang = sheet.partyId;
  const draft = await save(stores, accountId, [
    customer('linked', '王记餐饮', wang, [line('linked-line', '水饺', '80')]),
    customer('spoken', '老王', undefined, [line('spoken-line', '汤圆', '20')]),
  ]);
  const result = await stores.memory.chooseDraftCustomer(accountId, {
    requestId: randomUUID(), draftId: draft.id, revision: draft.revision,
    draftCustomerId: 'spoken', choice: 'existing', customerId: wang, remember: false,
  });
  assert.deepEqual(result, { revision: draft.revision + 1, remembered: null });
  const workspace = await stores.trips.workspace(accountId);
  assert.equal(workspace.draft.customers.length, 1);
  assert.equal(workspace.draft.customers[0].id, 'linked');
  assert.deepEqual(workspace.draft.customers[0].items.map(item => item.id), ['linked-line', 'spoken-line']);
});

test('customer choice appends overlapping items only after an explicit decision', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { sheets: [sheet] } = await issue(stores, accountId, [freshCustomer('seed', '王记餐饮')]);
  const draft = await save(stores, accountId, [
    customer('linked', '王记餐饮', sheet.partyId, [line('original', '水饺', '80')]),
    customer('spoken', '老王', undefined, [line('duplicate', '水饺', null), line('other', '馄饨', null)]),
  ]);
  const input = { ...command(), draftId: draft.id, revision: draft.revision,
    draftCustomerId: 'spoken', choice: 'existing', customerId: sheet.partyId, remember: true };
  await assert.rejects(stores.memory.chooseDraftCustomer(accountId, input), { code: 'customer_merge_review' });
  assert.deepEqual((await stores.trips.workspace(accountId)).draft, draft);
  assert.deepEqual(await stores.memory.listCustomerAliases(accountId), []);

  const append = { ...input, merge: 'append' };
  const result = await stores.memory.chooseDraftCustomer(accountId, append);
  assert.equal(result.remembered, true);
  assert.deepEqual(await stores.memory.chooseDraftCustomer(accountId, append), result);
  await assert.rejects(stores.memory.chooseDraftCustomer(accountId, { ...append, merge: 'keep_existing' }),
    { code: 'request_conflict' });
  const { draft: saved } = await stores.trips.workspace(accountId);
  assert.equal(saved.revision, draft.revision + 1);
  assert.equal(saved.customers.length, 1);
  assert.deepEqual(saved.customers[0].items.map(item => item.id), ['original', 'duplicate', 'other']);
});

test('customer choice rejects stale drafts, confirmed drafts, busy agents and foreign parties', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const [a, b] = await Promise.all([login(stores, 'a'), login(stores, 'b')]);
  const bTrip = await issue(stores, b, [freshCustomer('b', '乙记')]);
  const { sheets: [sheet] } = await issue(stores, a, [freshCustomer('a', '王记餐饮')]);
  const draft = await save(stores, a, [customer('picked', '老王', undefined, [line('picked-line', '水饺', '80')])]);
  const { memory } = stores;
  const base = { draftId: draft.id, revision: draft.revision, draftCustomerId: 'picked', choice: 'existing',
    customerId: sheet.partyId, remember: true };

  await assert.rejects(memory.chooseDraftCustomer(a, { ...base, requestId: randomUUID(), revision: draft.revision - 1 }),
    { code: 'draft_changed' });
  await assert.rejects(memory.chooseDraftCustomer(a, { ...base, requestId: randomUUID(), choice: 'unlink', spoken: '老王' }),
    { code: 'customer_not_linked' });
  await assert.rejects(memory.chooseDraftCustomer(a, { ...base, requestId: randomUUID(), choice: 'unknown' }),
    { code: 'invalid_customer_choice' });
  await assert.rejects(memory.chooseDraftCustomer(a, { ...base, requestId: randomUUID(), choice: 'unlink' }),
    { code: 'invalid_customer_choice' });

  const runningId = randomUUID();
  await stores.db.query(`INSERT INTO dispatch.agent_turns
    (account_id, id, draft_id, start_revision, end_revision, before_customers, status)
    VALUES ($1, $2, $3, $4, $4, $5, 'running')`,
  [a, runningId, draft.id, draft.revision, JSON.stringify(draft.customers)]);
  await assert.rejects(memory.chooseDraftCustomer(a, { ...base, requestId: randomUUID() }), { code: 'agent_busy' });
  await stores.db.query('DELETE FROM dispatch.agent_turns WHERE account_id = $1 AND id = $2', [a, runningId]);

  await assert.rejects(memory.chooseDraftCustomer(a,
    { ...base, requestId: randomUUID(), customerId: bTrip.sheets[0].partyId }), { code: 'customer_not_found' });
  await assert.rejects(memory.chooseDraftCustomer(a, { ...base, requestId: randomUUID(), draftCustomerId: 'missing' }),
    { code: 'draft_customer_not_found' });

  const chosen = await memory.chooseDraftCustomer(a, { ...base, requestId: randomUUID() });
  assert.deepEqual(chosen, { revision: draft.revision + 1, remembered: true });
  await assert.rejects(memory.chooseDraftCustomer(a, {
    requestId: randomUUID(), draftId: draft.id, revision: draft.revision + 1,
    draftCustomerId: 'picked', choice: 'existing', customerId: sheet.partyId,
  }), { code: 'customer_already_linked' });

  const current = await stores.trips.workspace(a);
  const previewed = await preview(stores, a, current.draft);
  await stores.trips.confirm(a, { ...command(), previewId: previewed.previewId });
  await assert.rejects(memory.chooseDraftCustomer(a, {
    requestId: randomUUID(), draftId: draft.id, revision: draft.revision + 1,
    draftCustomerId: 'picked', choice: 'new',
  }), { code: 'draft_confirmed' });
});

test('agent memory returns mentions and prices while alias listing names the canonical customer', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { sheets: [sheet] } = await issue(stores, accountId, [freshCustomer('a', '王记餐饮', '80')]);
  const wang = sheet.partyId;
  const { memory } = stores;
  await memory.bindCustomerAlias(accountId, { ...command(), customerId: wang, alias: '老王' });
  const draft = await save(stores, accountId, [
    customer('current', '王记餐饮', wang, [line('missing', '水饺', null)]),
    customer('alias', '老王', undefined, [line('alias-line', '水饺', null)]),
  ]);
  const view = await memory.agentMemory(accountId, draft.id);
  assert.equal(view.draftId, draft.id);
  assert.equal(view.revision, draft.revision);
  assert.equal(view.confirmed, false);
  assert.deepEqual(view.customers, [{ id: wang, name: '王记餐饮' }]);
  assert.deepEqual(view.mentions.map(row => [row.draftCustomerId, row.resolution.status, row.resolution.customerId]),
    [['alias', 'resolved', wang]]);
  assert.deepEqual(view.prices.map(row => [row.draftCustomerId, row.lineId, row.status, row.unitPriceCents]), [
    ['current', 'missing', 'exact_match', 8000], ['alias', 'alias-line', 'unresolved_customer', undefined],
  ]);
  await assert.rejects(memory.agentMemory(accountId, randomUUID()), { code: 'draft_not_found' });

  assert.deepEqual(await memory.aliasList(accountId), { aliases: [
    { alias: '老王', normalizedAlias: '老王', customerId: wang, canonicalName: '王记餐饮' },
  ] });
  const removed = await memory.unbindCustomerAlias(accountId, { ...command(), alias: '老王' });
  assert.deepEqual(removed.removed, { customerId: wang, alias: '老王', normalizedAlias: '老王' });
  assert.deepEqual(await memory.aliasList(accountId), { aliases: [] });

  const previewed = await preview(stores, accountId,
    await save(stores, accountId, [customer('current', '王记餐饮', wang, [line('missing', '水饺', null)])]));
  await stores.trips.confirm(accountId, { ...command(), previewId: previewed.previewId });
  const confirmed = await memory.agentMemory(accountId, previewed.draftId);
  assert.equal(confirmed.confirmed, true);
  assert.deepEqual(confirmed.mentions, []);
  assert.deepEqual(confirmed.prices, []);
});

const variantLine = (id, product, price, brand, specification) =>
  ({ id, product, price, brand, specification, unit: '箱', quantity: '1' });

test('price adopt applies latest and earlier historical prices once and replays idempotently', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const name = '东街餐饮';
  const first = await issue(stores, accountId, [customer('old', name, null, [line('old-line', '水饺', '80')])]);
  const partyId = first.sheets[0].partyId;
  await issue(stores, accountId, [customer('newer', name, partyId, [line('newer-line', '水饺', '82')])]);
  const { memory } = stores;

  const draft = await save(stores, accountId, [customer('draft', name, partyId, [line('draft-line', '水饺', null)])]);
  const [suggestion] = (await memory.suggestDraftPrices(accountId, draft.id)).suggestions;
  assert.equal(suggestion.status, 'exact_match');
  assert.equal(suggestion.unitPriceCents, 8200);
  assert.equal(suggestion.previousDistinctPrice.unitPriceCents, 8000);

  const input = { requestId: randomUUID(), draftId: draft.id, revision: draft.revision,
    lines: [{ draftCustomerId: 'draft', lineId: 'draft-line', unitPriceCents: 8200 }] };
  const adopted = await memory.adoptDraftPrices(accountId, input);
  assert.deepEqual(adopted, { revision: draft.revision + 1, adopted: 1 });
  const current = await stores.trips.workspace(accountId);
  assert.equal(current.draft.revision, draft.revision + 1);
  assert.equal(current.draft.customers[0].items[0].price, '82.00');
  assert.deepEqual(await memory.adoptDraftPrices(accountId, input), adopted);
  await assert.rejects(memory.adoptDraftPrices(accountId, { ...input,
    lines: [{ draftCustomerId: 'draft', lineId: 'draft-line', unitPriceCents: 8000 }] }), { code: 'request_conflict' });

  const next = await save(stores, accountId, [customer('draft', name, partyId, [line('draft-line', '水饺', null)])]);
  await assert.rejects(memory.adoptDraftPrices(accountId, { requestId: randomUUID(), draftId: next.id, revision: next.revision,
    lines: [{ draftCustomerId: 'draft', lineId: 'draft-line', unitPriceCents: 8200,
      variant: { brand: '安井', spec: '500g' } }] }), { code: 'price_not_suggested' });
  const earlier = await memory.adoptDraftPrices(accountId, { requestId: randomUUID(), draftId: next.id, revision: next.revision,
    lines: [{ draftCustomerId: 'draft', lineId: 'draft-line', unitPriceCents: 8000 }] });
  assert.deepEqual(earlier, { revision: next.revision + 1, adopted: 1 });
  assert.equal((await stores.trips.workspace(accountId)).draft.customers[0].items[0].price, '80.00');

  const third = await save(stores, accountId, [customer('draft', name, partyId, [line('draft-line', '水饺', null)])]);
  await assert.rejects(memory.adoptDraftPrices(accountId, { requestId: randomUUID(), draftId: third.id, revision: third.revision,
    lines: [{ draftCustomerId: 'draft', lineId: 'draft-line', unitPriceCents: 1 }] }), { code: 'price_not_suggested' });
  const untouched = await stores.trips.workspace(accountId);
  assert.equal(untouched.draft.revision, third.revision);
  assert.equal(untouched.draft.customers[0].items[0].price, null);

  const { rows: [card] } = await stores.db.query(
    "SELECT payload FROM dispatch.agent_events WHERE account_id = $1 AND kind = 'card' ORDER BY seq DESC LIMIT 1", [accountId]);
  assert.deepEqual(card.payload, { action: 'price-adopt', count: 1 });
});

test('price adopt resolves variants, fills only empty brand and spec, and applies no automatic price', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const name = '南门饭店';
  const first = await issue(stores, accountId, [customer('old', name, null, [
    line('uniq-line', '馄饨', '82'),
    variantLine('tang-a', '汤圆', '90', '甲牌', '500g'),
    variantLine('tang-b', '汤圆', '95', '乙牌', '1kg'),
    variantLine('rice-a', '年糕', '70', '安井', '500g'),
    variantLine('rice-b', '年糕', '75', '安井', '1kg'),
  ])]);
  const partyId = first.sheets[0].partyId;
  const { memory } = stores;
  const draft = await save(stores, accountId, [customer('draft', name, partyId, [
    variantLine('uniq', '馄饨', null, '', ''),
    variantLine('tang', '汤圆', null, '', ''),
  ])]);
  const byLine = new Map((await memory.suggestDraftPrices(accountId, draft.id)).suggestions.map(row => [row.lineId, row]));
  assert.equal(byLine.get('uniq').status, 'unique_variant_match');
  assert.equal(byLine.get('uniq').brand, '安井');
  assert.equal(byLine.get('uniq').spec, '500g');
  assert.equal(byLine.get('tang').status, 'ambiguous_variants');
  assert.equal(byLine.get('tang').candidates.length, 2);

  await memory.adoptDraftPrices(accountId, { requestId: randomUUID(), draftId: draft.id, revision: draft.revision,
    lines: [{ draftCustomerId: 'draft', lineId: 'uniq', unitPriceCents: 8200 }] });
  let workspace = await stores.trips.workspace(accountId);
  let unique = workspace.draft.customers[0].items.find(item => item.id === 'uniq');
  assert.equal(unique.price, '82.00');
  assert.equal(unique.brand, '安井');
  assert.equal(unique.specification, '500g');
  assert.equal(unique.quantity, '1');
  const tang = workspace.draft.customers[0].items.find(item => item.id === 'tang');
  assert.equal(tang.price, null);

  const revision = workspace.draft.revision;
  await assert.rejects(memory.adoptDraftPrices(accountId, { requestId: randomUUID(), draftId: draft.id, revision,
    lines: [{ draftCustomerId: 'draft', lineId: 'tang', unitPriceCents: 9500 }] }), { code: 'price_not_suggested' });
  await assert.rejects(memory.adoptDraftPrices(accountId, { requestId: randomUUID(), draftId: draft.id, revision,
    lines: [{ draftCustomerId: 'draft', lineId: 'tang', unitPriceCents: 9500,
      variant: { brand: '甲牌', spec: '1kg' } }] }), { code: 'price_not_suggested' });
  await memory.adoptDraftPrices(accountId, { requestId: randomUUID(), draftId: draft.id, revision,
    lines: [{ draftCustomerId: 'draft', lineId: 'tang', unitPriceCents: 9500,
      variant: { brand: '乙牌', spec: '1kg' } }] });
  workspace = await stores.trips.workspace(accountId);
  const chosen = workspace.draft.customers[0].items.find(item => item.id === 'tang');
  assert.equal(chosen.price, '95.00');
  assert.equal(chosen.brand, '乙牌');
  assert.equal(chosen.specification, '1kg');

  const kept = await save(stores, accountId, [customer('draft', name, partyId, [
    variantLine('uniq-kept', '馄饨', null, '安井', ''),
  ])]);
  const hint = (await memory.suggestDraftPrices(accountId, kept.id)).suggestions[0];
  assert.equal(hint.status, 'unique_variant_match');
  await memory.adoptDraftPrices(accountId, { requestId: randomUUID(), draftId: kept.id, revision: kept.revision,
    lines: [{ draftCustomerId: 'draft', lineId: 'uniq-kept', unitPriceCents: 8200 }] });
  const keptItem = (await stores.trips.workspace(accountId)).draft.customers[0].items[0];
  assert.equal(keptItem.brand, '安井');
  assert.equal(keptItem.specification, '500g');
  assert.equal(keptItem.price, '82.00');

  const keptAmbiguous = await save(stores, accountId, [customer('draft', name, partyId, [
    variantLine('rice-kept', '年糕', null, '安井', ''),
  ])]);
  const [riceHint] = (await memory.suggestDraftPrices(accountId, keptAmbiguous.id)).suggestions;
  assert.equal(riceHint.status, 'ambiguous_variants');
  assert.deepEqual(riceHint.candidates.map(candidate => candidate.spec).sort(), ['1kg', '500g']);
  await memory.adoptDraftPrices(accountId, { requestId: randomUUID(), draftId: keptAmbiguous.id,
    revision: keptAmbiguous.revision, lines: [{ draftCustomerId: 'draft', lineId: 'rice-kept', unitPriceCents: 7500,
      variant: { brand: '安井', spec: '1kg' } }] });
  const rice = (await stores.trips.workspace(accountId)).draft.customers[0].items[0];
  assert.equal(rice.brand, '安井');
  assert.equal(rice.specification, '1kg');
  assert.equal(rice.price, '75.00');
});

test('price adopt rejects priced, unlinked, stale and busy drafts without writing', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const name = '西门饭庄';
  const first = await issue(stores, accountId, [customer('old', name, null, [line('old-line', '水饺', '80')])]);
  const partyId = first.sheets[0].partyId;
  const { memory } = stores;
  const draft = await save(stores, accountId, [
    customer('priced', name, partyId, [line('priced-line', '水饺', '99')]),
    customer('pending', name, undefined, [line('pending-line', '水饺', null)]),
    customer('linked', name, partyId, [line('linked-line', '水饺', null)]),
  ]);
  const adopt = (draftCustomerId, lineId, inputExtra = {}) => memory.adoptDraftPrices(accountId, {
    requestId: randomUUID(), draftId: draft.id, revision: draft.revision, ...inputExtra,
    lines: [{ draftCustomerId, lineId, unitPriceCents: 8000 }],
  });

  await assert.rejects(adopt('priced', 'priced-line'), { code: 'price_suggestion_changed' });
  await assert.rejects(adopt('pending', 'pending-line'), { code: 'price_suggestion_changed' });
  await assert.rejects(adopt('linked', 'linked-line', { revision: draft.revision - 1 }), { code: 'draft_changed' });
  assert.equal((await stores.trips.workspace(accountId)).draft.revision, draft.revision);

  const runningId = randomUUID();
  await stores.db.query(`INSERT INTO dispatch.agent_turns
    (account_id, id, draft_id, start_revision, end_revision, before_customers, status)
    VALUES ($1, $2, $3, $4, $4, $5, 'running')`,
  [accountId, runningId, draft.id, draft.revision, JSON.stringify(draft.customers)]);
  await assert.rejects(adopt('linked', 'linked-line'), { code: 'agent_busy' });
  await stores.db.query('DELETE FROM dispatch.agent_turns WHERE account_id = $1 AND id = $2', [accountId, runningId]);
  const untouched = await stores.trips.workspace(accountId);
  assert.equal(untouched.draft.revision, draft.revision);
  assert.equal(untouched.draft.customers.find(customer => customer.id === 'linked').items[0].price, null);
});

test('price adopt validates every line before touching the draft', { timeout: 20_000 }, async t => {
  const stores = await isolatedDatabase(t);
  const accountId = await login(stores, 'a');
  const { memory } = stores;
  const base = { requestId: randomUUID(), draftId: randomUUID(), revision: 0 };
  const call = value => memory.adoptDraftPrices(accountId, value);
  const lineInput = { draftCustomerId: 'customer', lineId: 'line', unitPriceCents: 8000 };

  for (const lines of [
    [], [{ ...lineInput }, { ...lineInput }], [{ ...lineInput, unitPriceCents: 0 }],
    [{ ...lineInput, unitPriceCents: 1.5 }], [{ ...lineInput, unitPriceCents: '8000' }],
    [{ ...lineInput, draftCustomerId: '' }], [{ ...lineInput, lineId: 'x'.repeat(201) }],
    [{ ...lineInput, variant: { brand: 1, spec: '' } }],
  ]) {
    await assert.rejects(call({ ...base, lines }), { code: 'invalid_price_adopt' });
  }
  await assert.rejects(call({ ...base, lines: Array.from({ length: 65 }, (_, index) =>
    ({ ...lineInput, lineId: `line-${index}` })) }), { code: 'invalid_price_adopt' });
  await assert.rejects(call({ ...base, lines: [{ ...lineInput, variant: { brand: '', spec: '' } }] }),
    { code: 'draft_changed' });
});
