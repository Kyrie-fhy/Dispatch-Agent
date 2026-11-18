const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyTrip } = require('../code/dist/core/trips');
const { materialChunkBytes } = require('../code/dist/core/materials');

const tokenA = 'a'.repeat(43);
const tokenB = 'b'.repeat(43);
const tripId = '1bc26b68-32b6-48d5-b4fc-e82bed6aaea8';

const tap = dataset => ({ currentTarget: { dataset } });
const input = (dataset, value) => ({ ...tap(dataset), detail: { value } });

function data(name, revision = 0) {
  let number = 0;
  const draft = emptyTrip(() => `row-${++number}`);
  draft.id = tripId;
  draft.revision = revision;
  Object.assign(draft.customers[0], { customer: name, partyId: null });
  Object.assign(draft.customers[0].items[0], { brand: '安井', product: '水饺', specification: '500g', quantity: '2', price: '82' });
  return { draft, parties: [], draftConfirmed: false, currentTrip: null };
}

function formal(workspace) {
  const { previewTrip, statusesFor, pickingList } = require('../code/dist/core/trips');
  const summary = previewTrip(workspace.draft);
  return { trip: { id: workspace.draft.id, origin: 's2', versions: [{ ...summary, version: 1, savedAt: '2026-11-16T00:00:00Z' }],
    statuses: statusesFor(summary.customers, 'pending'), statusRevision: 0 }, picking: pickingList(summary.customers) };
}

function setup(mvp = false) {
  require('../code/dist/services/workspace-config').deliveryMvp = mvp;
  const queue = [];
  const credentials = [];
  global.wx = {
    request: options => queue.push(options),
    login: ({ success }) => success({ code: credentials.shift() }),
    showModal: ({ success }) => success({ confirm: true }),
    getStorageSync: () => assert.fail('The S5 entry must not read the S4 dataset'),
    setStorageSync: () => assert.fail('The S5 entry must not write to the S4 dataset'),
  };
  let page;
  global.Page = config => {
    page = { ...config, data: structuredClone(config.data), setData(value) { Object.assign(this.data, value); } };
  };
  const modulePath = require.resolve('../code/dist/pages/workspace/index');
  delete require.cache[modulePath];
  require(modulePath);

  async function take(method, path, token, input) {
    await new Promise(resolve => setImmediate(resolve));
    const request = queue.shift();
    assert.ok(request, `Expected ${method} ${path}`);
    assert.equal(request.method, method);
    assert.equal(new URL(request.url).pathname, `/v1${path}`);
    assert.equal(request.header.Authorization, token ? `Bearer ${token}` : undefined);
    if (input !== undefined) assert.deepEqual(request.data, input);
    return {
      data: request.data, header: request.header,
      respond: (statusCode, data) => request.success({ statusCode, data }),
      timeout: () => request.fail({ errMsg: 'request:fail timeout' }),
    };
  }

  async function beginLogin(code, token) {
    credentials.push(code);
    const done = page.login();
    (await take('POST', '/session/wechat', '', { code })).respond(201, { token });
    return { done };
  }

  async function login(code, token, workspace) {
    const { done } = await beginLogin(code, token);
    (await take('GET', '/workspace', token)).respond(200, workspace);
    if (workspace.currentTrip) {
      (await take('GET', `/trips/${workspace.currentTrip.id}`, token)).respond(200, formal(workspace));
    }
    await done;
  }

  function editName(value) {
    page.editCustomer({ currentTarget: { dataset: { id: page.data.active.id } }, detail: { value } });
  }

  return { page, take, beginLogin, login, editName, assertIdle: () => assert.deepEqual(queue, []) };
}

test('S5 materials keep the original local file for resume and clear another account’s records', async () => {
  const { page, take, login, assertIdle } = setup();
  const cache = new Map();
  const files = new Map([['temp', new ArrayBuffer(materialChunkBytes + 5)]]);
  const reads = [];
  const digest = 'f'.repeat(64);
  let chosenName = '材料.mp3';
  Object.assign(global.wx, {
    env: { USER_DATA_PATH: 'wxfile://private' },
    getStorageSync(key) {
      assert.equal(key, 'dispatch-s5-material-outbox');
      return structuredClone(cache.get(key) ?? '');
    },
    setStorageSync(key, value) {
      assert.equal(key, 'dispatch-s5-material-outbox');
      cache.set(key, structuredClone(value));
    },
    chooseMessageFile: ({ success }) => success({ tempFiles: [{ path: 'temp', name: chosenName }] }),
    getFileSystemManager: () => ({
      getFileInfo: ({ filePath, success }) => success({ size: files.get(filePath).byteLength, digest }),
      copyFile: ({ srcPath, destPath, success }) => { files.set(destPath, files.get(srcPath)); success(); },
      unlink: ({ filePath }) => files.delete(filePath),
      readFile: ({ filePath, position, length, success }) => {
        reads.push(position);
        success({ data: files.get(filePath).slice(position, position + length) });
      },
    }),
  });

  const workspace = data('上传材料');
  await login('account-a-1', tokenA, workspace);
  async function enter(token, materials) {
    const done = page.selectSection(tap({ section: 'materials' }));
    (await take('GET', '/materials', token)).respond(200, { materials });
    await done;
  }
  await enter(tokenA, []);
  await page.selectMaterial(tap({}));
  assert.match(page.data.error, /请选择.*图片/);
  assert.equal(cache.has('dispatch-s5-material-outbox'), false);
  assertIdle();

  chosenName = '材料.png';
  let done = page.selectMaterial(tap({}));
  const begin = await take('POST', '/materials', tokenA);
  assert.equal(begin.data.draftId, workspace.draft.id);
  assert.equal(begin.data.digest, digest);
  const material = { ...begin.data, id: 'saved-file', received: 0, draftCurrent: true, status: 'uploading' };
  begin.respond(201, { material });
  const first = await take('PUT', '/materials/saved-file/chunks', tokenA);
  assert.equal(first.header['X-Material-Offset'], '0');
  assert.equal(first.header['Content-Type'], 'application/octet-stream');
  assert.equal(first.data.byteLength, materialChunkBytes);
  const uploaded = { ...material, received: materialChunkBytes };
  first.respond(200, { material: uploaded });
  (await take('PUT', '/materials/saved-file/chunks', tokenA)).timeout();
  await done;
  assert.equal(page.data.materialRows[0].progress, 99);
  assert.equal(page.data.materialRows[0].local, true);

  async function leave(token) {
    const done = page.logout();
    assert.deepEqual(page.data.materialRows, []);
    (await take('DELETE', '/session', token)).respond(204);
    await done;
  }
  await leave(tokenA);
  const other = data('另一个账号');
  other.draft.id = 'other-account-draft';
  await login('account-b', tokenB, other);
  await enter(tokenB, []);
  assert.deepEqual(page.data.materialRows, []);
  await enter(tokenB, [{ ...material, id: 'other-account-file', draftId: other.draft.id, status: 'ready', received: material.size }]);
  assert.equal(page.data.materialRows[0].local, false);
  assert.equal(cache.get('dispatch-s5-material-outbox').length, 1);
  await leave(tokenB);

  await login('account-a-2', tokenA, workspace);
  await enter(tokenA, [uploaded]);
  done = page.resumeMaterial(tap({ key: uploaded.requestId }));
  (await take('GET', '/materials/saved-file', tokenA)).respond(200, { material: uploaded });
  const finalChunk = await take('PUT', '/materials/saved-file/chunks', tokenA);
  assert.equal(finalChunk.header['X-Material-Offset'], String(materialChunkBytes));
  assert.equal(finalChunk.data.byteLength, 5);
  finalChunk.respond(200, { material: { ...material, received: material.size, status: 'ready' } });
  await done;
  assert.equal(page.data.materialRows[0].ready, true);
  assert.equal(page.data.materialRows[0].progress, 100);
  assert.deepEqual(cache.get('dispatch-s5-material-outbox'), []);
  assert.deepEqual(reads, [0, materialChunkBytes, materialChunkBytes]);
  assertIdle();
});

test('S5 reselects the original photo and resumes from the server offset without local cache', async () => {
  const { page, take, login, assertIdle } = setup();
  const workspace = data('重选原图');
  const image = new Uint8Array(2 * materialChunkBytes + 5);
  image.set([1, 2, 3, 4, 5], 2 * materialChunkBytes);
  const material = {
    id: 'saved-photo', requestId: 'order-1-2-photo', draftId: workspace.draft.id, revision: workspace.draft.revision,
    name: '相册图片.jpg', size: image.byteLength, digest: 'a'.repeat(64),
    received: materialChunkBytes, draftCurrent: true, status: 'uploading',
  };
  let selectedDigest = 'b'.repeat(64);
  let manifest = '';
  let stagedPath;
  Object.assign(global.wx, {
    env: { USER_DATA_PATH: 'wxfile://clean' },
    getStorageSync: () => manifest,
    setStorageSync: (key, entries) => { manifest = entries; },
    chooseMedia: ({ sizeType, success }) => {
      assert.deepEqual(sizeType, ['original']);
      success({ tempFiles: [{ tempFilePath: 'temp.jpg' }] });
    },
    getFileSystemManager: () => ({
      getFileInfo: ({ filePath, digestAlgorithm, success }) => {
        assert.equal(filePath, 'temp.jpg');
        assert.equal(digestAlgorithm, 'sha256');
        success({ size: image.byteLength, digest: selectedDigest });
      },
      copyFile: ({ destPath, success }) => { stagedPath = destPath; success(); },
      readFile: ({ filePath, position, length, success }) => {
        assert.ok(stagedPath);
        assert.equal(filePath, stagedPath);
        success({ data: image.slice(position, position + length).buffer });
      },
      unlink: ({ filePath }) => { assert.equal(filePath, stagedPath); stagedPath = undefined; },
    }),
  });

  await login('same-account-on-clean-client', tokenA, workspace);
  let done = page.selectSection(tap({ section: 'materials' }));
  (await take('GET', '/materials', tokenA)).respond(200, { materials: [material] });
  await done;
  assert.equal(page.data.materialRows[0].local, false);

  const reselect = tap({ key: material.requestId, album: 'yes' });
  await page.selectMaterial(reselect);
  assert.match(page.data.error, /与原材料不匹配/);
  assert.equal(manifest, '');
  assert.equal(stagedPath, undefined);
  assertIdle();

  selectedDigest = material.digest;
  done = page.selectMaterial(reselect);
  (await take('GET', '/materials/saved-photo', tokenA)).respond(200, {
    material: { ...material, received: 2 * materialChunkBytes },
  });
  const last = await take('PUT', '/materials/saved-photo/chunks', tokenA);
  assert.equal(last.header['X-Material-Offset'], String(2 * materialChunkBytes));
  assert.deepEqual([...new Uint8Array(last.data)], [1, 2, 3, 4, 5]);
  last.respond(200, { material: { ...material, received: image.byteLength, status: 'ready' } });
  await done;
  assert.equal(page.data.materialRows[0].label, '已上传');
  assert.equal(page.data.materialRows[0].progress, 100);
  assert.deepEqual(manifest, []);
  assert.equal(stagedPath, undefined);
  assertIdle();
});

test('S5 customer sheet retains write identity on timeout and requires a new preview after a concurrent change', async () => {
  const { page, take, login, assertIdle } = setup();
  const workspace = data('客户甲', 1);
  const total = formal(workspace);
  const customer = total.trip.versions[0].customers[0];
  const sheetId = customer.id;
  const route = `/trips/${tripId}/sheets/${sheetId}`;
  const due = { due: 16400, paid: 0, remaining: 16400, excess: 0 };
  const zero = { due: 0, paid: 0, remaining: 0, excess: 0 };
  const sheet = {
    tripId, sheetId, customer: customer.customer, version: 1, statusRevision: 0, reviewed: false,
    orderCents: 16400, amounts: zero, lines: customer.items.map(item => ({ ...item, status: 'pending' })),
  };
  const ledger = { debts: [], receipts: [], remainingCents: 0, otherRemainingCents: 0 };
  const delivered = { ...sheet, statusRevision: 1, amounts: due, lines: sheet.lines.map(line => ({ ...line, status: 'delivered' })) };
  const reviewed = { ...delivered, reviewed: true };
  async function reads(details, includeTrip = true) {
    (await take('GET', route, tokenA)).respond(200, { sheet: details });
    (await take('GET', route + '/ledger', tokenA)).respond(200, { ledger });
    if (includeTrip) (await take('GET', `/trips/${tripId}`, tokenA)).respond(200, total);
  }

  await login('delivery-code', tokenA, { ...workspace, draftConfirmed: true, currentTrip: { id: tripId } });
  page.selectSection(tap({ section: 'delivery' }));
  let done = page.openSheet(tap({ tripId, sheetId }));
  await reads(sheet, false);
  await done;
  assert.equal(page.data.sheet.pending.length, 1);
  assert.equal(page.data.sheet.balance.due, '0.00');

  done = page.markDelivery(tap({ id: sheet.lines[0].id, status: 'delivered' }));
  const lost = await take('POST', route + '/delivery', tokenA);
  assert.equal(lost.data.lineId, sheet.lines[0].id);
  lost.timeout();
  await done;
  page.closeSheet();
  assert.equal(page.data.sheetTarget.sheetId, sheetId);
  assert.equal(page.data.sheetRetry, true);
  done = page.retrySheetWrite();
  (await take('POST', route + '/delivery', tokenA, lost.data)).respond(200, { sheet: delivered });
  await reads(delivered);
  await done;
  assert.equal(page.data.sheet.balance.due, '164.00');

  page.beginSheetAction(tap({ action: 'review' }));
  done = page.confirmReview();
  const review = await take('POST', route + '/review', tokenA);
  assert.equal(review.data.statusRevision, 1);
  review.respond(200, { sheet: reviewed });
  await reads(reviewed);
  await done;

  done = page.markDelivery(tap({ id: sheet.lines[0].id, status: 'pending' }));
  (await take('POST', route + '/delivery/preview', tokenA)).respond(200, {
    preview: { previewId: 'delivery-preview', before: due, after: zero },
  });
  await done;
  assert.deepEqual(page.data.changePreview.rows[0], { label: '应收', before: '164.00', after: '0.00' });
  assert.equal(page.data.sheet.reviewed, true);
  done = page.confirmSheetPreview();
  (await take('POST', route + '/delivery/confirm', tokenA)).respond(409,
    { error: 'delivery_changed', message: '配送状态已变化' });
  await done;
  assert.equal(page.data.changePreview, null);
  assert.equal(page.data.sheetNeedsRefresh, true);
  assert.match(page.data.error, /已变化/);
  done = page.closeSheet();
  (await take('GET', `/trips/${tripId}`, tokenA)).respond(200, {
    ...total, trip: { ...total.trip, statuses: { [sheet.lines[0].id]: 'delivered' } },
  });
  await done;
  assert.equal(page.data.sheetTarget, null);
  assert.equal(page.data.formal.statuses[sheet.lines[0].id], '已送达');
  assertIdle();
});

test('S5 page saves, previews and confirms by server, retries lost writes, restores same account', async () => {
  const { page, take, login, editName, assertIdle } = setup();
  const workspace = data('原记录');
  await login('fresh-code-1', tokenA, workspace);
  editName('A 的账本');
  let done = page.saveDraft();
  const lostSave = await take('PUT', `/drafts/${tripId}`, tokenA);
  const saved = data('A 的账本', 1);
  lostSave.timeout();
  await done;
  assert.equal(page.data.dirty, true);
  assert.match(page.data.error, /无法连接/);
  assert.equal(page.data.active.customer, 'A 的账本');

  done = page.saveDraft();
  const retriedSave = await take('PUT', `/drafts/${tripId}`, tokenA);
  assert.deepEqual(retriedSave.data, lostSave.data);
  retriedSave.respond(200, { draft: saved.draft });
  await done;
  assert.equal(page.data.dirty, false);
  assert.equal(page.data.draft.revision, 1);

  const result = formal(saved);
  done = page.showPreview();
  const request = await take('POST', '/trips/preview', tokenA);
  assert.equal(request.data.revision, 1);
  request.respond(200, { preview: { ...result.trip.versions[0], previewId: 'preview-a', choices: [null] } });
  await done;
  assert.equal(page.data.formal, null);
  assert.equal(page.data.preview.total, '164.00');

  done = page.confirmTrip();
  const firstConfirm = await take('POST', '/trips/confirm', tokenA);
  firstConfirm.timeout();
  await done;
  assert.equal(page.data.draftConfirmed, false);
  done = page.confirmTrip();
  (await take('POST', '/trips/confirm', tokenA, firstConfirm.data)).respond(200, result);
  await done;
  assert.equal(page.data.draftConfirmed, true);
  assert.equal(page.data.formal.total, '164.00');
  page.selectSection({ currentTarget: { dataset: { section: 'picking' } } });
  assert.equal(page.data.formal.picking[0].quantity, 2);

  done = page.logout();
  assert.equal(page.data.draft, null);
  assert.equal(page.data.formal, null);
  (await take('DELETE', '/session', tokenA)).respond(204);
  await done;
  await login('fresh-code-2', tokenB, { ...saved, draftConfirmed: true, currentTrip: { id: tripId, version: 1, totalCents: 16400 } });
  assert.equal(page.data.draft.id, tripId);
  assert.equal(page.data.draft.revision, 1);
  assert.equal(page.data.formal.customers[0].customer, 'A 的账本');
  assertIdle();
});

test('S5 ignores an old formal-trip response after logout and login as a different account', async () => {
  const { page, take, beginLogin, login, assertIdle } = setup();
  const a = data('账号 A');
  const { done: oldLogin } = await beginLogin('account-a', tokenA);
  (await take('GET', '/workspace', tokenA)).respond(200, { ...a, currentTrip: { id: tripId, version: 1, totalCents: 16400 } });
  const delayed = await take('GET', `/trips/${tripId}`, tokenA);
  const logout = page.logout();
  assert.equal(page.data.signedIn, false);
  assert.equal(page.data.draft, null);
  (await take('DELETE', '/session', tokenA)).respond(204);
  await logout;

  const b = data('账号 B');
  b.draft.id = 'c842c494-dcc2-4c41-8d6b-ef7a4864a5c4';
  await login('account-b', tokenB, b);
  delayed.respond(200, formal(a));
  await oldLogin;
  assert.equal(page.data.draft.id, b.draft.id);
  assert.equal(page.data.active.customer, '账号 B');
  assert.equal(page.data.formal, null);
  assert.equal(page.data.error, '');
  assert.doesNotMatch(JSON.stringify(page.data), /账号 A/);
  assertIdle();
});

test('S5 preserves the local edit and reads the server revision before retrying a conflicting save', async () => {
  const { page, take, login, editName, assertIdle } = setup();
  await login('account-a', tokenA, data('原版本'));
  editName('本机编辑');
  const firstSave = page.saveDraft();
  const old = await take('PUT', `/drafts/${tripId}`, tokenA);
  old.respond(409, { error: 'draft_changed', message: '草稿已更新' });
  (await take('GET', '/workspace', tokenA)).respond(200, data('另一部手机修改', 1));
  await firstSave;
  assert.equal(page.data.active.customer, '本机编辑');
  assert.equal(page.data.conflict.draft.customers[0].customer, '另一部手机修改');
  assert.equal(page.data.dirty, true);
  const confirmed = page.keepLocalDraft();
  const retry = await take('PUT', `/drafts/${tripId}`, tokenA);
  assert.notEqual(retry.data.requestId, old.data.requestId);
  assert.equal(retry.data.revision, 1);
  assert.equal(retry.data.customers[0].customer, '本机编辑');
  retry.respond(200, { draft: data('本机编辑', 2).draft });
  await confirmed;
  assert.equal(page.data.draft.revision, 2);
  assert.equal(page.data.conflict, null);
  assert.equal(page.data.dirty, false);
  assertIdle();
});

test('S5 keeps the screen clear if logout fails and retries with the retired token', async () => {
  const { page, take, login, assertIdle } = setup();
  await login('account-a', tokenA, data('账号 A'));
  const first = page.logout();
  (await take('DELETE', '/session', tokenA)).timeout();
  await first;
  assert.equal(page.data.revokeFailed, true);
  assert.equal(page.data.signedIn, false);
  assert.doesNotMatch(JSON.stringify(page.data), /账号 A/);
  const retry = page.retryLogout();
  (await take('DELETE', '/session', tokenA)).respond(401, { message: '请重新登录' });
  await retry;
  assert.equal(page.data.revokeFailed, false);
  assertIdle();
});

test('S6 workspace keeps failed text for retry and confirms only after draft review', async () => {
  const { page, take, login, assertIdle } = setup(true);
  const start = data('');
  start.draft.customers[0].items[0].price = '';
  await login('s6-code', tokenA, start);
  const text = '老王要两箱安井水饺500g';
  page.editOrderText(input({}, text));
  const failed = page.organizeText();
  const first = await take('POST', '/text-orders', tokenA);
  assert.equal(page.data.organizingText, true);
  assert.equal(first.data.text, text);
  first.respond(502, { message: '文字整理暂未完成' });
  await failed;
  assert.equal(page.data.orderText, text);
  assert.match(page.data.error, /未完成/);
  assert.deepEqual(page.data.draft, start.draft);

  const missing = data('老王', 1);
  missing.draft.customers[0].items[0].price = '';
  const retry = page.organizeText();
  (await take('POST', '/text-orders', tokenA, first.data)).respond(200, { draft: missing.draft });
  await retry;
  assert.equal(page.data.orderText, '');
  assert.match(page.data.textQuestions[0].issues[0], /单价/);
  assert.equal(page.data.formal, null);

  const filled = data('老王', 2);
  page.editOrderText(input({}, '单价82元一箱'));
  const supplement = page.organizeText();
  const fill = await take('POST', '/text-orders', tokenA);
  assert.equal(fill.data.revision, 1);
  fill.respond(200, { draft: filled.draft });
  await supplement;
  assert.deepEqual(page.data.textQuestions, []);
  assert.equal(page.data.formal, null);

  const formalResult = formal(filled);
  const ready = page.showPreview();
  const request = await take('POST', '/trips/preview', tokenA);
  request.respond(200, { preview: { ...formalResult.trip.versions[0], previewId: 's6-preview', choices: [null] } });
  await ready;
  assert.equal(page.data.preview.total, '164.00');
  assert.equal(page.data.formal, null);

  const confirm = page.confirmTrip();
  (await take('POST', '/trips/confirm', tokenA)).respond(200, formalResult);
  await confirm;
  page.selectSection(tap({ section: 'picking' }));
  assert.equal(page.data.formal.picking[0].quantity, 2);
  page.selectSection(tap({ section: 'delivery' }));
  const stop = page.openSheet(tap({ tripId, sheetId: filled.draft.customers[0].id }));
  const sheet = await take('GET', `/trips/${tripId}/sheets/${filled.draft.customers[0].id}`, tokenA);
  sheet.respond(200, { sheet: { customer: '老王', orderCents: 16400, amounts: { due: 0, paid: 0, remaining: 0, excess: 0 },
    lines: [], tripId, sheetId: filled.draft.customers[0].id } });
  await stop;
  assert.equal(page.data.sheet.balance.due, '0.00');
  assertIdle();
});
