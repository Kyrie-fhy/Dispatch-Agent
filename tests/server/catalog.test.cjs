const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Pool } = require('pg');
const { catalogCsvColumns, parseCatalogCsv } = require('../../code/server-dist/miniprogram/core/catalog');
const { applyCatalogToDraft, CatalogStore, loadCatalog, suggestCatalogChoices } = require('../../code/server-dist/server/catalog');
const { readAccount } = require('../../code/server-dist/server/account-workspace');
const { prepareEdits } = require('../../code/server-dist/server/agent/edit');
const { setAccount, transaction } = require('../../code/server-dist/server/database');
const { readHistoricalSales } = require('../../code/server-dist/server/memory');
const { mergeOrder, sameOrSimilarProduct } = require('../../code/server-dist/server/text-orders');
const { previewTrip } = require('../../code/server-dist/miniprogram/core/trips');
const {
  gradeCase, runCase, isolatedDatabase, start, login, read, agentInput, waitForAgent, uploadImage, toolReply, saveCustomers,
} = require('./harness-cases.test.cjs');

const original = [
  ['P1', '1', '冻品', '鲜味虾丸', '北禾', '虾丸', '1kg', '单规格', '箱', '130.00', '在售', '已核实', '包装印「虾圆仔」'],
  ['P2', '1', '冻品', '秋丰鸭血', '秋丰', '鸭血', '200g', '20盒/箱', '箱', '15', '在售', '已核实', ''],
  ['P3', '1', '冻品', '南原鸭血', '南原', '鸭血', '250g', '10盒/箱', '箱', '18', '已下架', '已核实', ''],
  ['P4', '1', '冻品', '星原卷', '星原', '香酥卷', '120g（原写120）', '单规格', '', '6', '在售', '已核实', ''],
  ['P5', '1', '冻品', '春蔬饺', '北禾', '春蔬饺', '500g', '荠菜猪肉', '箱', '55', '在售', '已核实', ''],
  ['P5', '2', '冻品', '春蔬饺', '北禾', '春蔬饺', '500g', '韭菜鸡蛋', '箱', '60', '在售', '已核实', ''],
  ['P6', '1', '冻品', '喻记馄饨', '喻记', '馄饨', '400g', '单规格', '箱', '64', '在售', '已核实', ''],
];
const csv = rows => [catalogCsvColumns, ...rows].map(row => row.join(',')).join('\n');
const variants = rows => parseCatalogCsv(csv(rows)).map(row => ({
  ...row, productId: row.productCode, variantId: row.productCode + '/' + row.variantCode,
}));
const item = (product, extra = {}) => ({
  id: randomUUID(), product, brand: '', specification: '', unit: '箱', quantity: '2', price: null, ...extra,
});
const canonical = (price, extra = {}) => item('虾丸', { brand: '北禾', specification: '1kg', price, ...extra });
const add = (customer, product, extra = {}) => ({ action: 'add', customer, product, unit: '箱', quantity: '2', ...extra });
const state = draft => draft.customers.flatMap(customer => customer.items).filter(line => line.product);
const post = (api, token, path, body) => api.request(path, { method: 'POST', token, body });
const stock = (api, token) => api.request('/v1/catalog/summary', { token });
const zero = { productCount: 0, variantCount: 0, activeVariantCount: 0, discontinuedVariantCount: 0, missingUnitVariantCount: 0 };
const orderOutput = operations => ({ operations, question: '' });
const draftWith = (...items) => ({ id: 'draft', revision: 1, customers: [{ id: 'customer', customer: '甲店', partyId: null, items }] });

async function confirmSale(api, token, customer, items, { completed = false, zeroReceipt = false, partyId = null } = {}) {
  const draft = await read(api, token);
  const saved = await saveCustomers(api, token, draft, [{ id: randomUUID(), customer, partyId, items }]);
  const preview = await post(api, token, '/v1/trips/preview', { draftId: saved.id, revision: saved.revision, requestId: randomUUID() });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const confirmed = await post(api, token, '/v1/trips/confirm', { previewId: preview.data.preview.previewId, requestId: randomUUID() });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  if (completed) {
    const sheet = `/v1/trips/${saved.id}/sheets/${saved.customers[0].id}`;
    const result = await post(api, token, sheet + '/delivery/apply', {
      requestId: randomUUID(), version: 1, statusRevision: 0, complete: true,
      edits: zeroReceipt ? items.map(line => ({ lineId: line.id, receivedQuantity: 0, price: line.price })) : [],
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.sheet.deliveryCompleted, true);
  }
  await nextTrip(api, token, saved.id);
  return saved.id;
}

async function nextTrip(api, token, draftId) {
  const result = await post(api, token, '/v1/trips/next-draft', { draftId, requestId: randomUUID() });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}

async function runTurn(api, token, draft, text, materials) {
  const result = await post(api, token, '/v1/agent/turns', agentInput(draft, text, materials));
  assert.equal(result.status, 202, JSON.stringify(result.data));
  const end = await waitForAgent(api, token, result.data.turnId);
  assert.equal(end.status, 'completed', JSON.stringify(end));
  return result.data.turnId;
}

function waveBase64() {
  const buffer = Buffer.alloc(44 + 3200);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer.toString('base64');
}

test('catalog migration, import, pricing and choices through isolated PostgreSQL and authenticated API', { timeout: 120_000 }, async t => {
  const db = await isolatedDatabase(t);
  const adminToken = 'catalog-case-export-test-token';
  const api = await start(db, {
    adminToken,
    textModel: async ({ text }) => orderOutput(text.includes('其他账号') ? [add('沙盒乙店', '虾圆仔')] : [add('沙盒甲店', '虾圆仔')]),
    imageModel: async () => orderOutput([add('图片店', '香酥卷'), add('图片店', '虾圆仔'), add('图片店', '南原鸭血')]),
    speechModel: async () => ({ text: '口述店要两箱鸭血。' }),
    intentModel: async () => ({ draft: true, query: false, preview: false, answering: false }),
    agentModel: async messages => {
      const { text } = JSON.parse(messages.at(-1).content);
      if (text.includes('称呼未匹配')) return toolReply('edit_draft', { operations: [
        add('称呼未匹配', '虾圆仔'), add('称呼未匹配', '春蔬饺', { specification: '荠菜猪肉', price: '47' }),
        add('称呼未匹配', '喻记馄饨'),
      ] });
      if (text.includes('临时冻品')) return toolReply('edit_draft', { operations: [
        add('口述店', '春蔬饺'), add('口述店', '临时冻品', { price: '22.50' }),
        add('口述店', '南原鸭血', { brand: '南原', price: '12.00' }),
      ] });
      if (text.includes('口述店')) return toolReply('edit_draft', { operations: [add('口述店', '鸭血')] });
      if (text.includes('冲突')) return toolReply('edit_draft', { operations: [add('沙盒甲店', '新虾丸')] });
      throw new Error('unexpected agent input');
    },
  }, Number(process.env.DISPATCH_API_PORT || 0));
  const app = new Pool({ connectionString: db.appUrl });
  try {
    const a = await login(api, 'a');
    const b = await login(api, 'b');
    const { rows: accounts } = await db.owner.query('SELECT id, identity_subject FROM dispatch.accounts');
    const accountA = accounts.find(row => row.identity_subject === 'a').id;
    const accountB = accounts.find(row => row.identity_subject === 'b').id;
    const catalog = new CatalogStore(db.owner);
    const list = account => readAccount(db.owner, account, client => loadCatalog(client, account));
    assert.equal((await stock(api)).status, 401);
    assert.deepEqual((await stock(api, a)).data, zero);
    assert.equal((await db.owner.query("SELECT 1 FROM dispatch.schema_migrations WHERE name = '012_catalog.sql'")).rowCount, 1);
    await assert.rejects(catalog.importCsv('dev:unknown', csv(original)), /未找到目标账号/);
    await assert.rejects(catalog.importCsv('dev:a', csv([...original, original[0]])), /重复/);

    const batch = await catalog.importCsv('dev:a', csv(original));
    const replay = await catalog.importCsv(accountA, Buffer.from(csv(original)));
    assert.deepEqual(replay, { ...batch, replayed: true });
    const first = await list(accountA);
    const [firstVariant] = first;
    assert.equal(firstVariant.priceCents, 13000);
    assert.deepEqual((await stock(api, a)).data, {
      productCount: 6, variantCount: 7, activeVariantCount: 6, discontinuedVariantCount: 1, missingUnitVariantCount: 1,
    });
    assert.deepEqual((await stock(api, b)).data, zero);
    const beforeB = await read(api, b);
    const noOp = await post(api, b, '/v1/text-orders', {
      draftId: beforeB.id, revision: beforeB.revision, requestId: randomUUID(), text: '其他账号两箱虾圆仔',
    });
    assert.equal(noOp.status, 200);
    assert.deepEqual(state(noOp.data.draft).map(line => [line.product, line.price, line.catalogStatus]), [['虾圆仔', null, undefined]]);
    const bBatch = await catalog.importCsv(accountB, csv([original[0]]));
    assert.notEqual(bBatch.importId, batch.importId);
    for (const table of ['catalog_imports', 'catalog_products', 'catalog_variants', 'catalog_aliases']) {
      const relation = 'dispatch.' + table;
      const runAs = (account, operation) => transaction(app, async client => {
        if (account) await setAccount(client, account);
        return operation(client);
      });
      assert.equal((await runAs(null, client => client.query(`SELECT * FROM ${relation}`))).rowCount, 0);
      const aRows = await runAs(accountA, client => client.query(`SELECT * FROM ${relation}`));
      const bRows = await runAs(accountB, client => client.query(`SELECT * FROM ${relation}`));
      assert.ok(aRows.rows.length && aRows.rows.every(row => row.account_id === accountA));
      assert.ok(bRows.rows.length && bRows.rows.every(row => row.account_id === accountB));
      for (const sql of [`DELETE FROM ${relation}`, `UPDATE ${relation} SET account_id = account_id`,
        `INSERT INTO ${relation} SELECT * FROM ${relation} WHERE false`]) {
        await assert.rejects(runAs(accountA, client => client.query(sql)), { code: '42501' });
      }
    }

    const oldTrip = await confirmSale(api, a, '沙盒甲店', [canonical('125'), canonical('65', {
      product: '春蔬饺', specification: '500g·荠菜猪肉',
    })], { completed: true });
    const { rows: [party] } = await db.owner.query(
      "SELECT id FROM dispatch.parties WHERE account_id = $1 AND name = '沙盒甲店'", [accountA]);
    await confirmSale(api, a, '沙盒甲店', [canonical('91')], { partyId: party.id });
    await confirmSale(api, a, '沙盒甲店', [canonical('77')], { partyId: party.id, completed: true, zeroReceipt: true });

    let draft = await read(api, a);
    const spoken = await post(api, a, '/v1/text-orders', {
      draftId: draft.id, revision: draft.revision, requestId: randomUUID(), text: '沙盒甲店要两箱虾圆仔。',
    });
    assert.equal(spoken.status, 200, JSON.stringify(spoken.data));
    assert.deepEqual(state(spoken.data.draft).map(row => [row.product, row.price, row.priceSource]), [['虾丸', '125.00', 'customer_history']]);
    const legacyImage = await uploadImage(api, a, spoken.data.draft);
    const image = await post(api, a, '/v1/image-orders', {
      draftId: draft.id, revision: spoken.data.draft.revision, requestId: randomUUID(), materialId: legacyImage,
    });
    assert.equal(image.status, 200, JSON.stringify(image.data));
    assert.deepEqual(state(image.data.draft).slice(1).map(row => [row.product, row.price, row.catalogStatus]),
      [['香酥卷', null, 'unit_mismatch'], ['虾丸', '130.00', 'active'], ['鸭血', null, 'discontinued']]);

    await saveCustomers(api, a, image.data.draft, [{ id: randomUUID(), customer: '', items: [item('')] }]);
    draft = await read(api, a);
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAD0AAAAASUVORK5CYII=', 'base64');
    const uploaded = await uploadImage(api, a, draft, tinyPng);
    const imageTurn = await runTurn(api, a, draft, '', [uploaded]);
    assert.deepEqual(state(await read(api, a)).map(row => row.price), [null, '130.00', null]);
    const { rows: imageEvents } = await db.owner.query(
      "SELECT payload FROM dispatch.agent_events WHERE account_id = $1 AND turn_id = $2 AND kind = 'tool'", [accountA, imageTurn]);
    assert.ok(imageEvents.some(row => row.payload.name === 'import_image' &&
      row.payload.result.catalog.some(change => change.status === 'discontinued')));

    await runTurn(api, a, await read(api, a), '称呼未匹配要两箱虾圆仔、两箱荠菜猪肉春蔬饺，饺子单价47元，两箱喻记馄饨。');
    draft = await read(api, a);
    const unresolved = draft.customers.find(customer => customer.customer === '称呼未匹配');
    assert.deepEqual(unresolved.items.map(line => [line.price, line.priceSource]),
      [['130.00', 'catalog'], ['47', 'spoken'], ['64.00', 'catalog']]);
    unresolved.items[2].price = '59';
    const manual = await saveCustomers(api, a, draft, draft.customers);
    const selected = manual.customers.find(customer => customer.id === unresolved.id);
    assert.equal(selected.items[2].priceSource, 'manual');
    const choice = { draftId: manual.id, revision: manual.revision, requestId: randomUUID(), draftCustomerId: selected.id };
    const linked = await post(api, a, '/v1/agent/customer-choice', { ...choice, choice: 'existing', customerId: party.id });
    assert.equal(linked.status, 200, JSON.stringify(linked.data));
    assert.deepEqual(linked.data.priceUpdates.map(update => [update.beforePrice, update.price, update.priceSource]),
      [['130.00', '125.00', 'customer_history']]);
    assert.match(linked.data.priceUpdates[0].text, /库内价 ¥130\.00 → 熟客价 ¥125\.00/);
    const chosenEvent = await db.owner.query(
      "SELECT 1 FROM dispatch.agent_events WHERE account_id = $1 AND payload->>'action' = 'customer-choice' AND payload->'priceUpdates'->0->>'price' = '125.00'",
      [accountA]);
    assert.equal(chosenEvent.rowCount, 1);
    const unlinked = await post(api, a, '/v1/agent/customer-choice', {
      ...choice, requestId: randomUUID(), revision: linked.data.revision, choice: 'unlink', spoken: '称呼未匹配',
    });
    assert.equal(unlinked.status, 200, JSON.stringify(unlinked.data));
    assert.deepEqual((await read(api, a)).customers.find(customer => customer.id === selected.id).items
      .map(line => [line.price, line.priceSource]), [['130.00', 'catalog'], ['47', 'spoken'], ['59', 'manual']]);

    draft = await read(api, a);
    const transcript = await api.request('/v1/agent/transcription', { method: 'POST', token: a,
      headers: { 'x-draft-id': draft.id, 'x-draft-revision': String(draft.revision) }, body: { wave: waveBase64() } });
    assert.equal(transcript.status, 200, JSON.stringify(transcript.data));
    await runTurn(api, a, draft, transcript.data.text);
    draft = await read(api, a);
    const pending = draft.customers.find(customer => customer.customer === '口述店');
    assert.deepEqual([pending.items[0].price, pending.items[0].catalogStatus], [null, 'ambiguous']);
    const memory = await api.request('/v1/agent/memory?draftId=' + draft.id, { token: a });
    assert.equal(memory.status, 200);
    const candidate = memory.data.catalogChoices.find(row => row.lineId === pending.items[0].id);
    assert.deepEqual(candidate.candidates.map(row => row.status), ['active', 'discontinued']);
    const pick = { draftId: draft.id, revision: draft.revision, draftCustomerId: pending.id, lineId: pending.items[0].id,
      requestId: randomUUID(), choice: 'variant', variantId: candidate.candidates[0].variantId };
    const [same1, same2] = await Promise.all([
      post(api, a, '/v1/agent/catalog-choice', pick), post(api, a, '/v1/agent/catalog-choice', pick),
    ]);
    assert.deepEqual(same1, same2);
    assert.equal(same1.status, 200, JSON.stringify(same1.data));
    assert.deepEqual([same1.data.item.brand, same1.data.item.price, same1.data.item.priceSource], ['秋丰', '15.00', 'catalog']);
    assert.equal((await post(api, a, '/v1/agent/catalog-choice', { ...pick, requestId: randomUUID() })).data.error, 'draft_changed');
    assert.equal((await post(api, b, '/v1/agent/catalog-choice', pick)).status, 409);

    const externalTurn = await runTurn(api, a, await read(api, a),
      '口述店两箱春蔬饺、临时冻品两箱每箱22.50元、南原鸭血两箱每箱12元。');
    draft = await read(api, a);
    const external = draft.customers.find(customer => customer.id === pending.id).items;
    assert.deepEqual(external.slice(1).map(line => [line.price, line.priceSource, line.catalogStatus]),
      [[null, null, 'ambiguous'], ['22.50', 'spoken', 'unmatched'], ['12.00', 'spoken', 'discontinued']]);
    const exported = await api.request(`/admin/api/accounts/${accountA}/turns/${externalTurn}/eval-case?catalog=1`,
      { token: adminToken });
    assert.equal(exported.status, 200);
    assert.equal(exported.data.environment.catalog.length, original.length);
    assert.ok(exported.data.grader.redLines.linePriceEvidence.some(proof => proof.product === '临时冻品'));
    const keep = { draftId: draft.id, revision: draft.revision, draftCustomerId: pending.id, lineId: external[1].id,
      requestId: randomUUID(), choice: 'external' };
    const kept = await post(api, a, '/v1/agent/catalog-choice', keep);
    assert.equal(kept.status, 200, JSON.stringify(kept.data));
    assert.deepEqual([kept.data.item.product, kept.data.item.catalogStatus, kept.data.item.price], ['春蔬饺', 'external', null]);

    const oldSnapshots = () => db.owner.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.version) FROM dispatch.trip_versions v WHERE account_id=$1 AND trip_id=$2) AS versions,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM dispatch.trip_previews p WHERE account_id=$1 AND draft_id=$2) AS previews`,
    [accountA, oldTrip]).then(result => result.rows);
    const snapshots = await oldSnapshots();
    const updated = original.filter(row => row[0] !== 'P6').map(row => row.map((value, index) => {
      if (row[0] === 'P1' && index === 12) return '包装印「新虾丸」';
      if (row[0] === 'P1' && index === 9) return '139.90';
      if (row[0] === 'P4' && index === 8) return '袋';
      if (row[0] === 'P2' && index === 10) return '已下架';
      return value;
    }));
    const independent = await Promise.all([
      catalog.importCsv(accountA, csv(updated)), catalog.importCsv(accountA, csv(updated)),
    ]);
    assert.equal(independent[0].importId, independent[1].importId);
    assert.deepEqual(independent.map(row => row.replayed).sort(), [false, true]);
    assert.equal((await catalog.importCsv(accountA, csv(original))).importId, batch.importId);
    const after = await list(accountA);
    assert.equal(after[0].variantId, firstVariant.variantId);
    assert.equal(after[0].productId, firstVariant.productId);
    assert.equal(after[0].priceCents, 13990);
    assert.ok(after[0].aliases.includes('新虾丸'));
    assert.ok(!after[0].aliases.includes('虾圆仔'));
    assert.equal(after.find(row => row.productCode === 'P4').unit, '袋');
    assert.equal(after.find(row => row.productCode === 'P2').status, 'discontinued');
    assert.equal(after.some(row => row.productCode === 'P6'), false);
    assert.equal((await list(accountB))[0].priceCents, 13000);
    assert.deepEqual(await oldSnapshots(), snapshots);

    await confirmSale(api, a, '沙盒甲店', [canonical('123'), canonical('124')], { partyId: party.id, completed: true });
    await runTurn(api, a, await read(api, a), '沙盒甲店要两箱新虾丸，冲突测试。');
    const [pendingPrice] = state(await read(api, a));
    assert.equal(pendingPrice.price, null);
    assert.match(pendingPrice.priceHint, /多个成交价/);
  } finally {
    await Promise.all([api.stop(), app.end()]);
  }
});

test('catalog entry guards preserve pending prices through text, unit edits, images and catalog reimport', { timeout: 60_000 }, async t => {
  const db = await isolatedDatabase(t);
  const seed = original.map(row => {
    const copy = [...row];
    if (copy[0] === 'P3') copy[10] = '在售';
    if (copy[0] === 'P4') copy[8] = '袋';
    return copy;
  });
  const turns = new Map([
    ['甲店要两箱鸭血', [add('甲店', '鸭血', { brand: '秋丰' })]],
    ['甲店临时肠两箱，一共80元', [add('甲店', '临时肠')]],
    ['香酥卷两箱，每袋10元', [add('甲店', '香酥卷', { price: '10' })]],
    ['虾丸两箱，每箱40元', [add('甲店', '虾丸', { price: '40' })]],
    ['虾丸单位改成袋', [{ action: 'update', target: 4, unit: '袋' }]],
    ['熟客店两箱荠菜猪肉春蔬饺，每箱47元', [add('熟客店', '春蔬饺', { specification: '荠菜猪肉', price: '47' })]],
    ['熟客店两箱荠菜猪肉春蔬饺', [add('熟客店', '春蔬饺', { specification: '荠菜猪肉' })]],
  ]);
  const api = await start(db, {
    imageModel: async () => orderOutput([add('甲店', '临时肠', { price: '49' })]),
    intentModel: async () => ({ draft: true, query: false, preview: false, answering: false }),
    agentModel: async messages => {
      const { text } = JSON.parse(messages.at(-1).content);
      assert.ok(turns.has(text), text);
      return toolReply('edit_draft', { operations: turns.get(text) });
    },
  }, Number(process.env.DISPATCH_API_PORT || 0));
  try {
    const token = await login(api, 'a');
    const catalog = new CatalogStore(db.owner);
    const { accountId } = await catalog.importCsv('dev:a', csv(seed));
    const say = async text => {
      await runTurn(api, token, await read(api, token), text);
      return read(api, token);
    };

    let draft = await say('甲店要两箱鸭血');
    const [duck] = state(draft);
    assert.deepEqual([duck.brand, duck.specification, duck.price, duck.catalogStatus], ['', '', null, 'ambiguous']);
    const memory = await api.request('/v1/agent/memory?draftId=' + draft.id, { token });
    assert.equal(memory.status, 200);
    const choice = memory.data.catalogChoices.find(row => row.lineId === duck.id);
    assert.deepEqual(choice.candidates.map(row => row.brand), ['秋丰', '南原']);
    draft = await say('甲店临时肠两箱，一共80元');
    assert.equal(state(draft)[1].price, null);
    draft = await say('香酥卷两箱，每袋10元');
    assert.deepEqual([state(draft)[2].price, state(draft)[2].catalogStatus], [null, 'unit_mismatch']);
    draft = await say('虾丸两箱，每箱40元');
    assert.deepEqual([state(draft)[3].price, state(draft)[3].priceSource], ['40', 'spoken']);
    draft = await say('虾丸单位改成袋');
    const shrimp = state(draft)[3];
    assert.deepEqual([shrimp.unit, shrimp.price, shrimp.priceSource, shrimp.catalogStatus], ['袋', null, null, 'unit_mismatch']);

    draft = await saveCustomers(api, token, draft, [{ id: randomUUID(), customer: '', items: [item('', { quantity: '' })] }]);
    await runTurn(api, token, draft, '', [await uploadImage(api, token, draft)]);
    draft = await read(api, token);
    const [recognized] = state(draft);
    assert.deepEqual([recognized.product, recognized.price, recognized.priceSource], ['临时肠', null, null]);
    assert.match(recognized.priceHint, /图片疑似标价 ¥49（未自动填入，请核对）/);
    const preview = await post(api, token, '/v1/trips/preview', { draftId: draft.id, revision: draft.revision, requestId: randomUUID() });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.preview.totalCents, 0);

    draft = await saveCustomers(api, token, draft, [{ id: randomUUID(), customer: '', items: [item('', { quantity: '' })] }]);
    const [sold] = state(await say('熟客店两箱荠菜猪肉春蔬饺，每箱47元'));
    assert.deepEqual([sold.specification, sold.price, sold.priceSource], ['500g·荠菜猪肉', '47', 'spoken']);
    await confirmSale(api, token, '熟客店', [sold], { completed: true });
    const { rows: [party] } = await db.owner.query(
      "SELECT id FROM dispatch.parties WHERE account_id = $1 AND name = '熟客店'", [accountId]);
    const [sale] = await readAccount(db.owner, accountId, client => readHistoricalSales(client, accountId, [party.id]));
    assert.ok(sold.catalogVariantId);
    assert.deepEqual([sale.catalogVariantId, sale.spec, sale.unitPriceCents], [sold.catalogVariantId, '500g·荠菜猪肉', 4700]);
    const revised = seed.map(row => row[0] === 'P5' && row[1] === '1'
      ? row.map((value, index) => index === 6 ? '1kg' : value) : row);
    await catalog.importCsv(accountId, csv(revised));
    const [reordered] = state(await say('熟客店两箱荠菜猪肉春蔬饺'));
    assert.deepEqual([reordered.catalogVariantId, reordered.specification, reordered.price, reordered.priceSource],
      [sold.catalogVariantId, '1kg·荠菜猪肉', '55.00', 'catalog']);
  } finally {
    await api.stop();
  }
});

test('catalog choice aligns missing and cross-unit candidates while retaining the ordered unit', { timeout: 60_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db, {}, Number(process.env.DISPATCH_API_PORT || 0));
  try {
    const token = await login(api, 'a');
    const catalog = new CatalogStore(db.owner);
    await catalog.importCsv('dev:a', csv([
      ['Q1', '1', '冻品', '东屿血旺', '东屿', '血旺', '300g', '1盒', '盒', '0.80', '在售', '已核实', '品牌全称「东屿食品」'],
      ['Q1', '2', '冻品', '东屿血旺', '东屿', '血旺', '300g', '12盒/箱', '箱', '12', '在售', '已核实', ''],
      ['Q2', '1', '冻品', '西港血旺', '西港', '血旺', '400g', '单规格', '', '2.50', '在售', '已核实', ''],
      ['Q3', '1', '冻品', '海堤血旺', '海堤', '血旺', '500g', '1袋', '袋', '4.50', '已下架', '已核实', ''],
      ['Q4', '1', '冻品', '面皮卷', '东屿', '面皮卷', '125g', '单规格', '', '6', '在售', '已核实', ''],
    ]));
    const { rows: [account] } = await db.owner.query("SELECT id FROM dispatch.accounts WHERE identity_subject = 'a'");
    const variants = await readAccount(db.owner, account.id, client => loadCatalog(client, account.id));
    assert.deepEqual(variants.find(variant => variant.productCode === 'Q1').brandAliases, ['东屿食品']);

    const customers = ['空单位店', '其他单位店', '下架店', '单品店'].map((customer, index) => ({
      id: randomUUID(), customer, items: [item(index === 3 ? '面皮卷' : '血旺', {
        unit: index === 0 ? '盒' : '箱', price: index === 2 ? '8' : null,
      })],
    }));
    let draft = await saveCustomers(api, token, await read(api, token), customers);
    const choices = async () => {
      const response = await api.request('/v1/agent/memory?draftId=' + draft.id, { token });
      assert.equal(response.status, 200);
      return response.data.catalogChoices;
    };
    assert.deepEqual((await choices()).map(choice => choice.draftCustomerId), customers.slice(0, 3).map(customer => customer.id));
    assert.equal(suggestCatalogChoices(draft, variants).length, 3);
    const byCode = (productCode, variantCode = '1') => variants.find(row => row.productCode === productCode && row.variantCode === variantCode);
    for (const [index, variant, status, price, hint] of [
      [0, byCode('Q2'), 'unit_mismatch', null, '库内仅记 ¥2.50（未标盒价）'],
      [1, byCode('Q1'), 'unit_mismatch', null, '库内仅记 盒 ¥0.80'],
      [2, byCode('Q3'), 'discontinued', '8', '已下架，请核实库存。 库内仅记 袋 ¥4.50'],
    ]) {
      const customer = customers[index];
      const originalItem = customer.items[0];
      const result = await post(api, token, '/v1/agent/catalog-choice', {
        draftId: draft.id, revision: draft.revision, requestId: randomUUID(), choice: 'variant',
        draftCustomerId: customer.id, lineId: originalItem.id, variantId: variant.variantId,
      });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      const { item: selected } = result.data;
      assert.deepEqual([selected.product, selected.brand, selected.specification, selected.unit],
        [variant.product, variant.brand, variant.specification, originalItem.unit]);
      assert.deepEqual([selected.catalogProductId, selected.catalogVariantId, selected.catalogStatus, selected.price, selected.priceSource, selected.priceHint],
        [variant.productId, null, status, price, price ? 'manual' : null, hint]);
      draft = await read(api, token);
      assert.equal((await choices()).some(choice => choice.lineId === originalItem.id), false);
    }
    assert.deepEqual(await choices(), []);
  } finally {
    await api.stop();
  }
});

test('catalog draft writes distinguish raw quotes, guarded model output and catalog fallback', async () => {
  const catalog = variants(original);
  const client = { async query(sql) {
    assert.match(sql, /dispatch\.(?:parties|customer_aliases)/);
    return { rows: [] };
  } };
  const before = { id: 'draft', revision: 0, customers: [] };
  const customer = { id: 'customer', customer: '小店', items: [
    item('虾圆仔', { price: '81', quantity: '81' }),
    item('春蔬饺', { price: '50' }), item('香酥卷', { price: '7' }),
    item('临时品', { unit: '袋', price: '5' }),
    item('临时肠'),
  ] };
  const draft = { ...before, revision: 1, customers: [customer] };
  const result = await applyCatalogToDraft(client, 'account', draft, before, catalog,
    '小店要81箱虾圆仔，两箱春蔬饺，单价50元；两箱香酥卷，单价7元；临时品2袋每袋5元；临时肠两箱，这两箱加起来80元。');
  assert.deepEqual(state(draft).map(line => [line.product, line.price, line.catalogStatus, line.priceSource]), [
    ['虾丸', '130.00', 'active', 'catalog'],
    ['春蔬饺', '50', 'ambiguous', 'spoken'],
    ['香酥卷', '7', 'unit_mismatch', 'spoken'],
    ['临时品', '5', 'unmatched', 'spoken'],
    ['临时肠', null, 'unmatched', null],
  ]);
  assert.deepEqual(result.changes.map(row => row.input.product), ['虾圆仔', '春蔬饺', '香酥卷', '临时品', '临时肠']);
  const copy = structuredClone(draft);
  assert.deepEqual(await applyCatalogToDraft(client, 'account', draft, before, []), { lines: [], changes: [] });
  assert.deepEqual(draft, copy);
});

test('catalog strips ungrounded brand prefixes, guards ungrounded units, and clears price when swapping product', async () => {
  const catalog = variants(original);
  const client = { query: async () => ({ rows: [] }) };
  const duckDraft = draftWith(item('秋丰鸭血'));
  await applyCatalogToDraft(client, 'account', duckDraft, draftWith(), catalog, '甲店要两箱鸭血');
  assert.deepEqual([state(duckDraft)[0].product, state(duckDraft)[0].catalogStatus, state(duckDraft)[0].price],
    ['鸭血', 'ambiguous', null]);

  const unitDraft = draftWith(item('虾丸', { unit: '箱' }));
  await applyCatalogToDraft(client, 'account', unitDraft, draftWith(), catalog, '甲店要两袋虾丸');
  assert.deepEqual([state(unitDraft)[0].catalogStatus, state(unitDraft)[0].price], ['unit_mismatch', null]);

  const swapBefore = draftWith(item('虾丸', { brand: '北禾', specification: '1kg', price: '40', priceSource: 'spoken' }));
  const swapped = prepareEdits(swapBefore, { operations: [{ action: 'update', target: 1, product: '临时肠' }] },
    [], '虾丸换成临时肠', undefined, false, undefined, true);
  await applyCatalogToDraft(client, 'account', swapped.draft, swapBefore, catalog, '虾丸换成临时肠');
  assert.deepEqual([state(swapped.draft)[0].product, state(swapped.draft)[0].price, state(swapped.draft)[0].priceSource],
    ['临时肠', null, null]);
});

test('catalog matches changed brand and spec only when the utterance supports them', async () => {
  const catalog = variants([
    ...original,
    ['P7', '1', '冻品', '亚洲渔港鱼丸', '亚洲渔港', '鱼丸', '500g', '单规格', '箱', '29', '在售', '已核实', '厂牌「亚渔」'],
    ['P7', '2', '冻品', '亚洲渔港鱼丸', '亚洲渔港', '鱼丸', '1kg', '单规格', '箱', '42', '在售', '已核实', ''],
  ]);
  const client = { query: async () => ({ rows: [] }) };
  const price = async (text, row, before = draftWith()) => {
    const draft = draftWith(row);
    await applyCatalogToDraft(client, 'account', draft, before, catalog, text);
    return state(draft)[0];
  };
  for (const detail of [{ brand: '秋丰' }, { specification: '200g' }]) {
    const duck = await price('甲店要两箱鸭血', item('鸭血', detail));
    assert.deepEqual([duck.brand, duck.specification, duck.catalogStatus, duck.price], ['', '', 'ambiguous', null]);
  }
  for (const [text, specification, expected] of [
    ['甲店要两箱亚渔鱼丸500克', '500g', '29.00'],
    ['甲店要两箱亚洲渔港鱼丸1公斤', '1kg', '42.00'],
    ['甲店要两箱亚渔鱼丸1500克', '500g', null],
  ]) {
    const fish = await price(text, item('鱼丸', { brand: '亚洲渔港', specification }));
    assert.deepEqual([fish.brand, fish.specification, fish.price], ['亚洲渔港', expected ? specification : '', expected]);
  }
  const confirmed = item('鸭血', { brand: '秋丰', specification: '200g' });
  const updated = await price('鸭血数量改成三箱', { ...confirmed, quantity: '3' }, draftWith(confirmed));
  assert.deepEqual([updated.brand, updated.specification, updated.price], ['秋丰', '200g', '15.00']);
});

const speechCatalog = [
  ['002', '002', '冻品', '巧总管响铃卷120g', '巧总管', '响铃卷', '120g', '单规格', '', '6', '在售', '已核实', ''],
  ['013', '013-2', '冻品', '亚渔芝心虾球160g', '亚渔', '芝心虾球', '160g', '20盒/箱', '箱', '190', '在售', '已核实', ''],
  ['041', '041', '冻品', '德炎龙虾尾4.5kg', '德炎', '龙虾尾', '4.5kg', '单规格', '', '145', '已下架', '已核实', ''],
  ['049', '049', '冻品', '渔家姑娘龙虾尾4.5kg', '渔家姑娘', '龙虾尾', '4.5kg', '单规格', '', '120', '在售', '已核实', ''],
  ...['芹菜猪肉', '白菜猪肉', '酸菜猪肉', '牛肉', '三鲜', '香菇猪肉', '韭菜鸡蛋', '猪肉'].map((flavor, index) =>
    ['142', `142-${index + 1}`, '冻品', '益家德手工水饺500g', '益家德', '手工水饺', '500g', flavor, '包', '5', '在售', '已核实', '']),
];

test('catalog grounds both original and corrected homophones and reports the alignment', async () => {
  const catalog = variants([...original, ...speechCatalog]);
  const client = { query: async () => ({ rows: [] }) };
  for (const product of ['知心虾球', '芝心虾球', '亚渔芝心虾球']) {
    const draft = draftWith(item(product, { brand: '亚渔' }));
    const result = await applyCatalogToDraft(client, 'account', draft, draftWith(), catalog, '甲店要两箱知心虾球');
    assert.deepEqual(state(draft).map(row => [row.brand, row.product, row.specification, row.price]),
      [['亚渔', '芝心虾球', '160g', '190.00']]);
    assert.match(result.lines[0], /知心虾球 → 亚渔 芝心虾球 160g/);
    assert.equal(result.changes[0].spokenName ?? result.changes[0].input.product, '知心虾球');
  }
  for (const brand of ['易家得', '益家德']) {
    const draft = draftWith(item('手工水饺', { brand, specification: '牛肉', unit: '包', quantity: '5' }));
    await applyCatalogToDraft(client, 'account', draft, draftWith(), catalog, '甲店要五包易家得手工水饺');
    assert.deepEqual(state(draft).map(row => [row.brand, row.specification, row.catalogStatus, row.price]),
      [[brand, '', 'ambiguous', null]]);
  }
  const lobster = draftWith(item('德炎龙虾尾'));
  const result = await applyCatalogToDraft(client, 'account', lobster, draftWith(), catalog, '甲店一箱德盐龙虾尾');
  assert.equal(state(lobster)[0].catalogStatus, 'discontinued');
  assert.match(result.lines[0], /德盐龙虾尾 → 德炎龙虾尾/);
});

test('agent saves the rest of an order while asking about a duplicate and accepts near-match choices', { timeout: 60_000 }, async t => {
  const db = await isolatedDatabase(t);
  const customer = '王记餐饮';
  const rolling = '王记餐饮两箱巧总管响铃卷、一箱德炎龙虾尾、新到带鱼一箱每箱120元、临时冻虾一箱';
  const partial = '王记餐饮安井水饺500g一箱，三全汤圆两袋';
  const duplicate = '王记餐饮安井水饺500g一箱';
  const near = '王记餐饮两箱芝心虾';
  const dumpling = { brand: '安井', specification: '500g', quantity: '1' };
  const operations = new Map([
    [rolling, [add(customer, '响铃卷', { brand: '巧总管' }), add(customer, '龙虾尾', { brand: '德炎', quantity: '1' }),
      add(customer, '新到带鱼', { quantity: '1', price: '120' }), add(customer, '临时冻虾', { quantity: '1' })]],
    [partial, [add(customer, '水饺', dumpling), add(customer, '汤圆', { brand: '三全', unit: '袋' })]],
    [duplicate, [add(customer, '水饺', dumpling)]],
    [near, [add(customer, '芝心虾')]],
  ]);
  const api = await start(db, {
    textModel: async () => orderOutput(operations.get(duplicate)),
    intentModel: async () => ({ draft: true, query: false, preview: false, answering: false }),
    agentModel: async messages => toolReply('edit_draft', { operations: operations.get(JSON.parse(messages.at(-1).content).text) }),
  });
  try {
    const token = await login(api, 'a');
    const catalog = new CatalogStore(db.owner);
    const startItems = [item('龙虾尾', { quantity: '1' }), item('水饺', { brand: '安井', specification: '500g' })];
    const basis = await saveCustomers(api, token, await read(api, token),
      [{ id: randomUUID(), customer, partyId: null, items: startItems }]);
    await catalog.importCsv('dev:a', csv(speechCatalog));
    const send = async (draft, text) => {
      const id = await runTurn(api, token, draft, text);
      const visible = await api.request(`/v1/agent/turns/${id}/events`, { token });
      assert.equal(visible.status, 200);
      return visible.data.events;
    };

    const recorded = await send(basis, rolling);
    assert.equal(recorded.filter(event => event.kind === 'change').length, 1);
    const after = await read(api, token);
    assert.deepEqual(state(after).slice(2).map(row => [row.brand, row.product, row.catalogStatus, row.price, row.priceSource]), [
      ['巧总管', '响铃卷', 'unit_mismatch', null, null], ['德炎', '龙虾尾', 'discontinued', null, null],
      ['', '新到带鱼', 'unmatched', '120', 'spoken'], ['', '临时冻虾', 'unmatched', null, null],
    ]);
    assert.match(state(after)[2].priceHint, /未标箱价/);
    assert.equal(state(after).filter(row => row.product === '龙虾尾').length, 2);
    const combined = await send(after, partial);
    assert.equal(combined.filter(event => event.kind === 'change').length, 1);
    const questions = combined.find(event => event.kind === 'questions').payload.questions;
    assert.equal(questions.length, 1);
    assert.match(questions[0].text, /王记餐饮 · 安井 水饺 500g.*已有同款/);
    const partiallySaved = await read(api, token);
    assert.deepEqual(state(partiallySaved).filter(row => row.product === '水饺').map(row => row.quantity), ['2']);
    assert.deepEqual(state(partiallySaved).filter(row => row.product === '汤圆').map(row => [row.brand, row.quantity, row.unit]),
      [['三全', '2', '袋']]);
    const blocked = await send(partiallySaved, duplicate);
    assert.equal(blocked.some(event => event.kind === 'change'), false);
    assert.match(blocked.find(event => event.kind === 'questions').payload.questions[0].text, /王记餐饮 · 安井 水饺/);
    assert.deepEqual(await read(api, token), partiallySaved);
    const legacy = await post(api, token, '/v1/text-orders', {
      draftId: partiallySaved.id, revision: partiallySaved.revision, text: duplicate, requestId: randomUUID(),
    });
    assert.equal(legacy.status, 422);
    assert.equal(legacy.data.error, 'text_needs_review');
    assert.match(legacy.data.message, /王记餐饮 · 水饺.*已有同款/);

    await send(partiallySaved, near);
    const pending = await read(api, token);
    const line = state(pending).find(row => row.product === '芝心虾');
    assert.deepEqual([line.catalogStatus, line.price], ['ambiguous', null]);
    const memory = await api.request(`/v1/agent/memory?draftId=${pending.id}`, { token });
    const match = memory.data.catalogChoices.find(row => row.lineId === line.id);
    assert.match(match.priceHint, /未完全对上/);
    const [candidate] = match.candidates;
    const picked = await post(api, token, '/v1/agent/catalog-choice', {
      draftId: pending.id, revision: pending.revision, draftCustomerId: match.draftCustomerId, lineId: line.id,
      requestId: randomUUID(), choice: 'variant', variantId: candidate.variantId,
    });
    assert.equal(picked.status, 200, JSON.stringify(picked.data));
    assert.deepEqual([picked.data.item.product, picked.data.item.price, picked.data.item.priceSource],
      ['芝心虾球', '190.00', 'catalog']);
  } finally {
    await api.stop();
  }
});

test('duplicate checks are directional by brand and specification and permit other text edits', () => {
  const general = item('龙虾尾');
  const specific = { ...general, brand: '德炎', specification: '4.5kg' };
  assert.equal(sameOrSimilarProduct(general, specific), false);
  assert.equal(sameOrSimilarProduct(general, { ...general, specification: '4.5kg' }), false);
  assert.equal(sameOrSimilarProduct(specific, general), true);
  assert.equal(sameOrSimilarProduct(specific, { ...specific, unit: '袋' }), false);
  assert.equal(sameOrSimilarProduct(specific, { ...specific, brand: '其他品牌' }), false);

  const existing = item('水饺', { brand: '安井', specification: '500g' });
  const incomplete = item('汤圆', { brand: '三全', specification: '400g', unit: '', quantity: '' });
  const start = draftWith(existing, incomplete);
  const duplicate = add('甲店', '水饺', { brand: '安井', specification: '500g', quantity: '1' });
  const fill = { action: 'fill', target: 2, quantity: '2', unit: '袋' };
  const source = '甲店安井水饺一箱，三全汤圆400g两袋';
  const mixed = mergeOrder(start, orderOutput([duplicate, fill]), new Set(), source, true);
  assert.equal(mixed.issues.length, 0);
  assert.equal(mixed.draft.revision, 2);
  assert.deepEqual(state(mixed.draft).map(({ product, quantity, unit }) => [product, quantity, unit]),
    [['水饺', '2', '箱'], ['汤圆', '2', '袋']]);
  assert.deepEqual(mixed.conflicts, [{
    customer: '甲店', product: '水饺', brand: '安井', specification: '500g', unit: '箱', quantity: '1',
    existingRow: { id: existing.id, product: '水饺', brand: '安井', specification: '500g', unit: '箱', quantity: '2' },
  }]);
  const onlyConflict = mergeOrder(start, orderOutput([duplicate]), new Set(), source, true);
  assert.equal(onlyConflict.draft, null);
  assert.deepEqual(onlyConflict.issues, [{ code: 'text_needs_review',
    message: '「甲店 · 水饺」草稿里已有同款，请说明是再加一行还是修改已有数量。' }]);
  assert.deepEqual(onlyConflict.conflicts, mixed.conflicts);
  assert.deepEqual(prepareEdits(start, { operations: [duplicate, add('甲店', '馄饨')] }, [],
    '甲店安井水饺一箱，馄饨两箱').questions, [
    { customer: '甲店', text: '「甲店 · 安井 水饺 500g」草稿里已有同款，需要修改已有数量还是保留原明细？', options: [] },
  ]);
});

test('changing a unit clears previous prices of every origin and checks an explicitly repeated amount', async () => {
  const catalog = variants(original);
  const client = { query: async () => ({ rows: [] }) };
  const addSource = '甲店要两箱虾丸，每箱40元';
  const initial = draftWith();
  const { draft } = prepareEdits(initial, { operations: [add('甲店', '虾丸', { price: '40' })] }, [], addSource);
  await applyCatalogToDraft(client, 'account', draft, initial, catalog, addSource);
  const [shrimp] = state(draft);
  assert.deepEqual([shrimp.price, shrimp.priceSource], ['40', 'spoken']);
  for (const origin of ['spoken', 'manual', 'catalog', 'customer_history', null, undefined]) {
    const before = draftWith({ ...shrimp, priceSource: origin });
    const source = '虾丸单位改成袋';
    const changed = prepareEdits(before, { operations: [{ action: 'update', target: 1, unit: '袋' }] }, [], source);
    await applyCatalogToDraft(client, 'account', changed.draft, before, catalog, source);
    const [row] = state(changed.draft);
    assert.deepEqual([row.unit, row.price, row.priceSource, row.catalogStatus], ['袋', null, null, 'unit_mismatch'], String(origin));
  }
  for (const [quoteUnit, expected] of [['袋', '40'], ['箱', null]]) {
    const source = `虾丸单位改成袋，每${quoteUnit}40元`;
    const changed = prepareEdits(draft, { operations: [{ action: 'update', target: 1, unit: '袋', price: '40' }] },
      [], source, undefined, false, undefined, true);
    await applyCatalogToDraft(client, 'account', changed.draft, draft, catalog, source);
    assert.equal(state(changed.draft)[0].price, expected);
  }
});

test('image prices are reference hints when catalog pricing cannot fill the line', async () => {
  const catalog = variants(original);
  const client = { query: async () => ({ rows: [] }) };
  const before = draftWith();
  const recognized = item('临时肠', { price: '49' });
  const draft = draftWith(recognized, item('虾丸', { price: '49' }), item('鸭血', { price: '49' }),
    item('香酥卷', { price: '49' }), item('南原鸭血', { price: '49' }), item('', { price: '49' }));
  await applyCatalogToDraft(client, 'account', draft, before, catalog);
  assert.deepEqual(draft.customers[0].items.map(row => [row.catalogStatus, row.price, row.priceSource]), [
    ['unmatched', null, null], ['active', '130.00', 'catalog'], ['ambiguous', null, null],
    ['unit_mismatch', null, null], ['discontinued', null, null], ['unmatched', null, null],
  ]);
  for (const row of draft.customers[0].items.filter(row => row.price === null)) assert.match(row.priceHint, /图片疑似标价 ¥49/);
  assert.match(draft.customers[0].items[3].priceHint, /库内仅记/);
  assert.equal(previewTrip(draftWith(draft.customers[0].items[0]), true).totalCents, 0);
  const legacy = draftWith(recognized);
  await applyCatalogToDraft(client, 'account', legacy, before, []);
  assert.equal(state(legacy)[0].price, '49');
});

test('Harness catalog scorer authorizes each line independently of fixture expectations and amount lists', () => {
  const catalog = parseCatalogCsv(csv(original)).map(row => ({ ...row, productId: row.productCode, variantId: row.productCode + '/' + row.variantCode }));
  const [variant] = catalog;
  const scope = { trips: 0, tripRows: [] };
  const partyIds = new Map([['party-one', 'linked-one'], ['party-two', 'linked-two']]);
  const draftCustomer = (customer, items, partyId) => ({ id: customer, customer, items, partyId });
  const source = '甲店两箱虾丸，单价121元；乙店两箱鸭血。';
  const trace = (line, input) => ({ kind: 'tool', payload: { result: { catalog: [{ lineId: line.id, input }] } } });
  const grade = (customers, events = [], overrides = {}) => gradeCase({
    task: { text: source }, environment: { parties: [{ key: 'party-one', name: '甲店' }, { key: 'party-two', name: '乙店' }] },
    grader: { redLines: { allowedPrices: ['121', '130'] }, expect: { customers: customers.map(c => ({
      ...c, linkedPartyKey: c.partyId === 'linked-one' ? 'party-one' : c.partyId === 'linked-two' ? 'party-two' : null,
    })) } }, ...overrides,
  }, 'entry', partyIds, scope, scope, events, { customers }, catalog);
  const valid = canonical('130.00', { catalogVariantId: variant.variantId, catalogStatus: 'active', priceSource: 'catalog' });
  const quoted = canonical('121', { catalogVariantId: variant.variantId, catalogStatus: 'active', priceSource: 'spoken' });
  assert.equal(grade([draftCustomer('甲店', [valid], 'linked-one')], [trace(valid, item('虾丸'))],
    { task: { text: '甲店两箱虾丸' } }).success, true);
  assert.equal(grade([draftCustomer('甲店', [quoted], 'linked-one')]).success, true);

  const changedToOther = item('鸭血', { price: '121', priceSource: 'spoken' });
  const injected = grade([draftCustomer('甲店', [quoted], 'linked-one'), draftCustomer('乙店', [changedToOther], 'linked-two')]);
  assert.equal(injected.redLines.length, 1);
  assert.match(injected.redLines[0], /乙店 \/ 鸭血/);
  assert.equal(grade([draftCustomer('乙店', [quoted], 'linked-two'), draftCustomer('甲店', [canonical(null)], 'linked-one')])
    .redLines.some(issue => issue.startsWith('forbidInventedPrice')), true);

  for (const [raw, final] of [
    [item('鸭血'), item('鸭血', { brand: '秋丰', specification: '200g', catalogVariantId: 'P2/1', price: '15', priceSource: 'catalog', catalogStatus: 'active' })],
    [item('南原鸭血'), item('鸭血', { brand: '南原', specification: '250g', catalogVariantId: 'P3/1', price: '18', priceSource: 'catalog', catalogStatus: 'discontinued' })],
    [item('香酥卷'), item('香酥卷', { brand: '星原', specification: '120g', catalogVariantId: 'P4/1', price: '6', priceSource: 'catalog', catalogStatus: 'active' })],
    [item('虾丸', { unit: '盒' }), valid],
    [item('临时货'), item('临时货', { price: '130', priceSource: 'catalog' })],
    [item('虾丸'), { ...valid, price: '999' }],
    [item('虾丸'), { ...valid, price: '121', priceSource: 'customer_history' }],
  ]) {
    const result = grade([draftCustomer('甲店', [final], 'linked-one')], [trace(final, raw)]);
    assert.match(result.redLines[0], /forbidInventedPrice/, raw.product);
  }
});

test('fallback exports grade corrected legacy prices against the original quoted text', () => {
  const scope = { trips: 0, tripRows: [] };
  const quote = '测试店订一箱豆腐，八十块一箱';
  const draft = price => ({ customers: [{ id: 'customer', customer: '测试店', items: [
    item('豆腐', { quantity: '1', price }),
  ] }] });
  const grade = (text, price) => {
    const final = draft(price);
    return gradeCase({ task: { text }, grader: {
      expect: { customers: final.customers }, redLines: { quotedText: quote },
    } }, 'entry', new Map(), scope, scope, [], final);
  };
  assert.equal(grade(quote, '80').success, true);
  assert.match(grade('测试店订一箱豆腐，99元一箱', '99').redLines[0], /forbidInventedPrice/);

  const manuallyPriced = draft('73');
  manuallyPriced.customers[0].items[0].priceSource = 'manual';
  const unchanged = gradeCase({ task: { text: '看看草稿' }, grader: { expect: manuallyPriced } },
    'entry', new Map(), scope, scope, [], manuallyPriced, [], new Map(), manuallyPriced);
  assert.equal(unchanged.success, true);
});

test('catalog Harness replays CSV and structured snapshots against isolated PostgreSQL', { timeout: 90_000 }, async t => {
  for (const [label, catalog] of [['CSV', csv(original)], ['structured', parseCatalogCsv(csv(original))]]) {
    await t.test(`database fixture ${label}`, async context => {
      const source = '常买店两箱虾圆仔，两箱鸭血，两箱香酥卷，两箱临时货。';
      const selected = {
        customer: '常买店', linkedPartyKey: 'regular', items: [
          canonical('125.00', { priceSource: 'customer_history' }),
          item('鸭血', { priceSource: null }), item('香酥卷', { priceSource: null }), item('临时货', { priceSource: null }),
        ],
      };
      const caseFile = {
        id: `catalog-${label}`, mode: 'entry', testContext: context, task: { text: source },
        environment: { catalog, parties: [{ key: 'regular', name: '常买店' }], historicalSales: [
          { key: 'valid-price', partyKey: 'regular', deliveryCompleted: true, issuedAt: '2026-01-01T00:00:00Z',
            lines: [canonical('125', { catalogVariantKey: '["P1","1"]' })] },
          { key: 'not-delivered', partyKey: 'regular', issuedAt: '2026-02-01T00:00:00Z', lines: [canonical('99')] },
        ] },
        fixture: { turns: [{ tool: 'edit_draft', args: { operations: ['虾圆仔', '鸭血', '香酥卷', '临时货']
          .map(product => add('常买店', product)) } }] },
        grader: { expect: { status: 'completed', customers: [selected] } },
      };
      const result = await runCase(caseFile, 1, false);
      assert.equal(result.grade.success, true, result.grade.reason);
    });
  }
});
