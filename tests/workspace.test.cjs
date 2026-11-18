const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyTrip } = require('../code/dist/core/trips');

const tokenA = 'a'.repeat(43);
const tokenB = 'b'.repeat(43);
const tripId = '1bc26b68-32b6-48d5-b4fc-e82bed6aaea8';

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

function setup() {
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
      data: request.data,
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
