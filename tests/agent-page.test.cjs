const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { emptyTrip, previewTrip, pickingList, statusesFor } = require('../code/dist/core/trips');
const { deliveryLines, deliverySummary } = require('../code/dist/core/delivery-execution');
const { deliveredBalance } = require('../code/dist/core/settlement');
const { agentSession } = require('../code/dist/services/agent-session');

const token = 'a'.repeat(43);
const tap = dataset => ({ currentTarget: { dataset } });

function order() {
  let count = 0;
  const draft = emptyTrip(() => `r-${++count}`);
  draft.revision = 1;
  Object.assign(draft.customers[0], { customer: '老王', partyId: null });
  Object.assign(draft.customers[0].items[0], { product: '水饺', quantity: '2', unit: '箱', price: '82' });
  return draft;
}

function setup(t, initialDraft) {
  const requests = [];
  const navigation = [];
  const titles = [];
  let draft = initialDraft;
  let confirmed = false;
  let confirmedPreviewId = null;
  let delivery = null;
  let turns = [];
  let onRequest;
  let sequence = 0;
  const card = { ...previewTrip(initialDraft, true), draftId: initialDraft.id, revision: initialDraft.revision,
    previewId: 'pre-1', choices: [null] };
  const event = (kind, payload) => ({ kind, payload, seq: ++sequence });
  const pageFor = name => {
    let page;
    global.Page = config => {
      page = { ...config, data: structuredClone(config.data), setData(newData) { Object.assign(this.data, newData); } };
    };
    const resolved = require.resolve(`../code/dist/pages/${name}/index`);
    delete require.cache[resolved];
    require(resolved);
    return page;
  };
  agentSession.token = '';
  agentSession.unsaved = null;
  agentSession.deliveryCustomer = null;
  agentSession.deliveryTarget = null;
  global.wx = {
    login: ({ success }) => success({ code: 'example-login' }),
    request: request => {
      const url = new URL(request.url);
      const path = url.pathname.slice(3);
      const entry = { path, query: url.searchParams, data: request.data, method: request.method, headers: request.header,
        ok: (data, statusCode = 200) => request.success({ statusCode, data }),
        fail: () => request.fail({ errMsg: 'offline' }) };
      requests.push(entry);
      if (path === '/session/wechat') return entry.ok({ token }, 201);
      assert.equal(request.header.Authorization, `Bearer ${token}`);
      if (onRequest?.(entry)) return;
      if (path === '/session') return entry.ok(null, 204);
      if (path === '/agent/card-actions') return entry.ok({ recorded: true });
      if (path === '/agent/conversation') return entry.ok({ draft: structuredClone(draft), draftConfirmed: confirmed, confirmedPreviewId, turns: structuredClone(turns), delivery: structuredClone(delivery) });
      if (path === '/materials') return entry.ok({ materials: [] });
      if (path === '/workspace') return entry.ok({ draft: structuredClone(draft), parties: [], draftConfirmed: confirmed, currentTrip: null });
      if (path === '/agent/memory') return entry.ok({ draftId: entry.query.get('draftId'), revision: draft.revision,
        confirmed, customers: [], mentions: [], prices: [] });
      if (path === '/customer-aliases') return entry.ok({ aliases: [] });
      if (path === '/customer-aliases/unbind') return entry.ok({ removed: null });
      assert.fail(`Unhandled request ${entry.method} ${path}`);
    },
    navigateTo: ({ url }) => navigation.push(url),
    switchTab: ({ url }) => navigation.push(url),
    setNavigationBarTitle: ({ title }) => titles.push(title),
  };
  const page = pageFor('agent');
  t.after(() => { page.onHide(); agentSession.token = ''; agentSession.unsaved = null; });
  return { page, pageFor, requests, navigation, titles, event, card,
    setDraft(value) { draft = value; }, setConfirmed(value, id = null) { confirmed = value; confirmedPreviewId = id; },
    setTurns(value) { turns = value; }, setDelivery(value) { delivery = value; }, handle(fn) { onRequest = fn; },
  };
}

test('A2 follows a card to the delivery sheet, returns with customer context, and resubmits only on tap', async t => {
  const draft = order();
  const { page, pageFor, navigation, requests, event, handle, setConfirmed, setDelivery, setTurns } = setup(t, draft);
  const summary = previewTrip(draft, true);
  const customer = summary.customers[0];
  const sheetPath = `/trips/${draft.id}/sheets/${customer.id}`;
  const lines = deliveryLines(customer, {}).map(line => ({ ...line, status: 'pending' }));
  const statuses = statusesFor(summary.customers, 'pending');
  const progress = { tripId: draft.id, version: 1, statusRevision: 0, shops: [
    { sheetId: customer.id, customer: customer.customer, locked: false, totalCents: 16400, pendingPrices: 0 },
  ] };
  const lineId = lines[0].id;
  const proposal = { tripId: draft.id, sheetId: customer.id, customer: customer.customer, version: 1, statusRevision: 0,
    totalCents: 8200, canComplete: true, pendingPriceNames: [], edits: [{ lineId, name: '水饺', originalQuantity: '2',
      beforeQuantity: 2, beforePrice: '82.00', receivedQuantity: 1, price: '82.00' }] };
  const turn = { id: 'delivery-turn', text: '老王水饺只收一箱', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('delivery_proposal', proposal), event('end', { status: 'completed', revision: draft.revision, text: '请核对' })] };
  setConfirmed(true);
  setDelivery(progress);
  setTurns([turn]);
  const callbacks = {};
  Object.assign(global.wx, {
    authorize({ success }) { success(); },
    getRecorderManager: () => ({
      onStart(callback) { callbacks.start = callback; }, onStop(callback) { callbacks.stop = callback; },
      onError() {}, onInterruptionBegin() {}, start() { callbacks.start(); },
      stop() { callbacks.stop({ tempFilePath: 'onsite.pcm', duration: 1000 }); },
    }),
    getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: new ArrayBuffer(32000) }) }),
    arrayBufferToBase64: bytes => Buffer.from(bytes).toString('base64'),
  });
  handle(request => {
    if (request.path === '/workspace') request.ok({ draft, parties: [], draftConfirmed: true, currentTrip: { id: draft.id } });
    else if (request.path === `/trips/${draft.id}`) request.ok({ trip: { id: draft.id, statuses, versions: [{ ...summary, version: 1 }] },
      deliveryEdits: {}, picking: pickingList(summary.customers) });
    else if (request.path === sheetPath) request.ok({ sheet: { tripId: draft.id, sheetId: customer.id, customer: customer.customer,
      reviewed: false, orderCents: 16400, lines, execution: deliverySummary(lines), amounts: deliveredBalance(customer, statuses, 0) } });
    else if (request.path === '/agent/transcription') {
      assert.equal(request.headers['X-Draft-Id'], draft.id);
      assert.equal(Buffer.from(request.data.wave, 'base64').toString('ascii', 0, 4), 'RIFF');
      request.ok({ draftId: draft.id, revision: draft.revision, text: '水饺只收一箱' });
    } else if (request.path === `${sheetPath}/delivery/apply`) {
      assert.equal(request.data.turnId, turn.id);
      assert.equal(request.data.complete, true);
      assert.deepEqual(request.data.edits, [{ lineId, receivedQuantity: 1, price: '82.00' }]);
      setDelivery({ ...progress, statusRevision: 1, shops: progress.shops.map(shop => ({ ...shop, locked: true })) });
      setTurns([{ ...turn, events: [...turn.events, event('delivery_applied', { status: 'completed' })] }]);
      request.ok({});
    } else return false;
    return true;
  });
  await page.onShow();
  await page.login();
  assert.match(page.data.deliverySummary.label, /0\/1/);
  assert.equal(page.data.navTitle, '送货助手（0/1 已送达）');
  assert.equal(page.data.turns[0].delivery.active, true);
  page.openDelivery(tap({ turn: turn.id }));
  assert.equal(navigation.at(-1), '/pages/trip-delivery/index');
  page.onHide();
  const deliveryPage = pageFor('trip-delivery');
  await deliveryPage.onShow();
  assert.equal(deliveryPage.data.sheet.customer, '老王');
  deliveryPage.goAssistantDelivery();
  assert.equal(navigation.at(-1), '/pages/agent/index');
  await page.onShow();
  assert.equal(page.data.text, '老王：');
  const recording = page.record();
  assert.equal(page.data.voicePhase, '录音中');
  page.stopRecording();
  await recording;
  assert.match(page.data.text, /老王：\n水饺只收一箱/);
  assert.equal(requests.some(request => request.path.endsWith('/delivery/apply') || request.path === '/agent/turns'), false);
  await page.applyDelivery(tap({ turn: turn.id, mode: 'complete' }));
  assert.match(page.data.deliverySummary.label, /1\/1/);
  assert.equal(page.data.navTitle, '送货助手（1/1 已送达）');
  assert.equal(page.data.turns[0].delivery.notice, '已确认送达，应收已锁定');
  await page.applyDelivery(tap({ turn: turn.id, mode: 'complete' }));
  assert.equal(requests.filter(request => request.path.endsWith('/delivery/apply')).length, 1);
});

test('A1 chat restores original input on failed submission, then polls progress and submits a quick answer', async t => {
  const draft = order();
  const { page, requests, event, handle, setTurns } = setup(t, draft);
  await page.onShow();
  await page.login();
  assert.equal(page.data.signedIn, true);
  const plan = event('plan', { steps: [{ id: 'intent', text: '看懂你的意思' }, { id: 'edit', text: '整理进草稿' },
    { id: 'check', text: '核对缺项' }, { id: 'summary', text: '汇报' }, { id: 'preview', text: '生成预览' }] });
  const progress = event('step', { id: 'intent', state: 'done' });
  const needs = event('step', { id: 'edit', state: 'needs_input' });
  const failure = event('step', { id: 'check', state: 'failed', result: '读取失败' });
  const skip = event('step', { id: 'summary', state: 'skipped' });
  const question = event('questions', { questions: [{ customer: '老王', text: '改成还是追加？', options: ['追加 3 箱'] }] });
  const end = event('end', { text: '待确认', revision: 1, status: 'completed' });
  const first = { id: 'turn-1', text: '再要三箱', materialIds: [], revision: 1, status: 'completed', events: [plan, progress, needs, failure, skip, question, end] };
  let submits = 0;
  let polls = 0;
  handle(request => {
    if (request.path === '/agent/turns') {
      submits++;
      if (submits === 1) request.fail();
      else request.ok({ turnId: submits === 2 ? first.id : 'turn-2' }, 202);
      return true;
    }
    if (request.path === '/agent/turns/turn-1/events') {
      polls++;
      assert.equal(Number(request.query.get('after')), polls === 1 ? 0 : progress.seq);
      if (polls === 1) request.ok({ status: 'running', events: [plan, progress] });
      else {
        setTurns([first]);
        request.ok({ status: 'completed', events: [needs, failure, skip, question, end] });
      }
      return true;
    }
  });
  page.editText({ detail: { value: first.text } });
  const submission = page.send();
  assert.equal(page.data.turns[0].checklist[0].state, 'running');
  assert.equal(page.data.turns[0].checklist[0].text, '看懂你的意思');
  await submission;
  assert.equal(page.data.text, first.text);
  assert.match(page.data.error, /无法连接/);
  await page.send();
  assert.equal(page.data.text, '');
  assert.equal(page.data.polling, true);
  await page.poll();
  assert.deepEqual(page.data.turns[0].checklist.map(step => step.icon), ['✓', '○', '○', '○', '○']);
  await page.poll();
  assert.equal(page.data.polling, false);
  assert.deepEqual(page.data.turns[0].questions[0].options, ['追加 3 箱']);
  assert.deepEqual(page.data.turns[0].checklist.map(step => step.icon), ['✓', '！', '✗', '–', '○']);
  assert.equal(page.data.turns[0].checklist[2].result, '读取失败');
  await page.answer(tap({ option: '追加 3 箱', turn: first.id }));
  const sent = requests.filter(request => request.path === '/agent/turns');
  assert.equal(sent[0].data.requestId, sent[1].data.requestId);
  assert.equal(sent[2].data.text, '追加 3 箱');
  assert.deepEqual(sent[2].data.direct, { intent: 'draft', answer: '追加 3 箱', turnId: first.id });
  assert.ok(requests.some(request => request.path === '/agent/card-actions' && request.data.action === 'answer'));
});

test('A1 restores failed messages, renders revision-safe undo and only confirms through the existing trip API', async t => {
  const base = order();
  const { page, requests, navigation, card, event, handle, setDraft, setConfirmed, setDelivery, setTurns } = setup(t, base);
  const change = event('change', { lines: ['老王 水饺 数量：1箱 → 2箱'] });
  const saved = event('end', { text: '已整理', status: 'completed', revision: 1 });
  const failure = event('end', { text: '处理失败。草稿没有变化。', status: 'failed', revision: 1 });
  const edit = { id: 'edit', text: '改成两箱', status: 'completed', events: [change, saved], materialIds: [], revision: 0 };
  const failed = { id: 'failed', text: '生成送货单', status: 'failed', events: [failure], materialIds: [], revision: 1 };
  setTurns([edit, failed]);
  await page.onShow();
  await page.login();
  assert.match(page.data.turns[1].reply, /草稿没有变化/);
  page.retry(tap({ id: 'failed' }));
  assert.equal(page.data.text, failed.text);
  const undone = event('undo', { revision: 2 });
  const nextDraft = { ...base, revision: 2 };
  const previewTurn = (preview, id) => ({ id, text: '生成送货单', materialIds: [], status: 'completed', revision: preview.revision,
    events: [event('plan', { steps: [{ id: 'confirm', text: '等你确认出单' }, { id: 'issued', text: '出单完成' }] }),
      event('step', { id: 'confirm', state: 'needs_input' }), event('preview', { preview }),
      event('end', { status: 'completed', text: '请确认', revision: preview.revision, elapsedMs: 4000 })] });
  const firstPreview = { ...card, revision: 2 };
  const secondPreview = { ...card, revision: 3, previewId: 'pre-2' };
  const old = previewTurn(firstPreview, 'old');
  let retried = false;
  handle(request => {
    if (request.path === '/agent/turns/edit/undo') {
      setDraft(nextDraft);
      setTurns([{ ...edit, events: [...edit.events, undone] }]);
      request.ok({ revision: 2 });
      return true;
    }
    if (request.path === '/trips/confirm') {
      if (request.data.previewId === firstPreview.previewId) {
        setDraft({ ...base, revision: 3 });
        request.ok({ error: 'draft_changed', message: '草稿已变化，请重新预览' }, 409);
      } else {
        assert.equal(request.data.previewId, secondPreview.previewId);
        setConfirmed(true, secondPreview.previewId);
        setDelivery({ tripId: base.id, version: 1, statusRevision: 0, shops: [
          { sheetId: base.customers[0].id, customer: '老王', locked: false, totalCents: 16400, pendingPrices: 0 },
        ] });
        request.ok({ picking: [{ id: 'row', product: '水饺', quantity: 2, unit: '箱' }] });
      }
      return true;
    }
    if (request.path === '/agent/turns') {
      assert.equal(request.data.text, '生成送货单');
      assert.equal(request.data.revision, 3);
      request.ok({ turnId: 'new' }, 202);
      return true;
    }
    if (request.path === '/agent/turns/new/events') {
      const current = previewTurn(secondPreview, 'new');
      setTurns([old, current]);
      retried = true;
      request.ok({ status: 'completed', events: current.events });
      return true;
    }
  });

  await page.undo(tap({ id: 'edit' }));
  assert.equal(page.data.turns[0].undone, true);
  setTurns([old]);
  await page.onShow();
  assert.equal(page.data.turns[0].preview.totalLabel, '整趟订单金额 ¥164.00');
  assert.equal(page.data.turns[0].preview.customers[0].items[0].productLabel, '水饺');
  assert.equal(requests.filter(r => r.path === '/trips/confirm').length, 0);
  await page.confirm(tap({ id: firstPreview.previewId }));
  assert.match(page.data.error, /重新预览/);
  assert.equal(page.data.confirmed, false);
  await page.previewShortcut();
  await page.poll();
  assert.equal(retried, true);
  assert.deepEqual(requests.find(r => r.path === '/agent/turns').data.direct, { intent: 'preview' });
  assert.equal(page.data.turns.at(-1).elapsed, '用时 4 秒');
  page.setData({ text: '未发送的草稿', attachments: [{ id: 'image-1', name: '图片 1' }], voiceRetry: true });
  page.voiceFile = { draft: nextDraft, path: 'draft.pcm' };
  await page.confirm(tap({ id: secondPreview.previewId }));
  assert.equal(page.data.confirmed, true);
  assert.equal(page.data.issuedCard, true);
  assert.equal(page.data.draftSummary, null);
  assert.equal(page.data.deliverySummary.label, '本趟送货 · 0/1 家已送达');
  assert.equal(page.data.navTitle, '送货助手（0/1 已送达）');
  assert.deepEqual(navigation, []);
  assert.equal(page.data.text, '');
  assert.deepEqual(page.data.attachments, []);
  assert.equal(page.data.voiceRetry, false);
  assert.equal(page.voiceFile, null);
  page.showPickingList();
  assert.equal(navigation.at(-1), '/pages/trip-picking/index');
  assert.equal(page.data.turns.at(-1).checklist[0].state, 'done');
  page.onHide();
  await page.onShow();
  assert.equal(page.data.turns.at(-1).checklist[0].state, 'done');
  assert.equal(page.data.turns.at(-1).issued, true);
  assert.ok(requests.filter(r => r.path === '/trips/confirm').every(r => r.data.requestId));
});

test('Agent composer routes image picks, toggles voice input, and stays quiet after confirmation', async t => {
  const draft = order();
  const { page, requests, handle, setConfirmed } = setup(t, draft);
  const menuCalls = [];
  const picked = [];
  const recorder = {};
  Object.assign(global.wx, {
    showActionSheet: ({ itemList, success }) => {
      menuCalls.push(itemList);
      success({ tapIndex: menuCalls.length === 1 ? 0 : 1 });
    },
    chooseMessageFile: ({ fail }) => { picked.push('chat'); fail({ errMsg: 'chooseMessageFile:fail cancel' }); },
    chooseMedia: ({ fail }) => { picked.push('album'); fail({ errMsg: 'chooseMedia:fail cancel' }); },
    authorize: ({ success }) => success(),
    getRecorderManager: () => ({
      onStart(callback) { recorder.start = callback; }, onStop(callback) { recorder.stop = callback; },
      onError() {}, onInterruptionBegin() {}, start() { recorder.start(); },
      stop() { recorder.stop({ tempFilePath: 'composer.pcm', duration: 1200 }); },
    }),
    getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: new ArrayBuffer(32000) }) }),
    arrayBufferToBase64: bytes => Buffer.from(bytes).toString('base64'),
  });
  handle(request => {
    if (request.path === '/agent/transcription') {
      request.ok({ draftId: draft.id, revision: draft.revision, text: '明天加两箱水饺' });
      return true;
    }
    if (request.path === '/agent/turns') {
      assert.equal(request.data.text, '生成送货单');
      assert.deepEqual(request.data.direct, { intent: 'preview' });
      request.ok({ turnId: 'preview-turn' }, 202);
      return true;
    }
  });
  await page.onShow();
  await page.login();
  assert.equal(page.data.signedIn, true);
  assert.equal(page.data.draftSummary.hasLines, true);

  await page.previewShortcut();
  assert.deepEqual(requests.find(request => request.path === '/agent/turns').data.direct, { intent: 'preview' });
  page.stopPolling();
  page.setData({ polling: false });

  page.openImageMenu();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(menuCalls[0], ['从微信聊天选图', '从手机相册选图']);
  assert.deepEqual(picked, ['chat']);
  page.openImageMenu();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(picked, ['chat', 'album']);

  page.toggleInputMode();
  assert.equal(page.data.inputMode, 'voice');
  page.toggleInputMode();
  assert.equal(page.data.inputMode, 'text');
  page.toggleInputMode();
  const recording = page.record();
  assert.equal(page.data.voicePhase, '录音中');
  page.stopRecording();
  await recording;
  assert.equal(page.data.inputMode, 'text');
  assert.equal(page.data.voicePhase, '');
  assert.match(page.data.text, /明天加两箱水饺/);

  setConfirmed(true, 'pre-1');
  const materialsBefore = requests.filter(request => request.path === '/materials').length;
  await page.onShow();
  assert.equal(page.data.confirmed, true);
  assert.equal(requests.filter(request => request.path === '/materials').length, materialsBefore);
  page.openImageMenu();
  assert.equal(menuCalls.length, 2);
  assert.deepEqual(picked, ['chat', 'album']);
});

test('A1 manual form uses the same session and detects an unsaved edit after chat updates the draft', async t => {
  const base = order();
  const { page, pageFor, navigation, requests, setDraft } = setup(t, base);
  await page.onShow();
  await page.login();
  assert.match(page.data.draftSummary.label, /1 家 1 行/);
  page.toggleDraft();
  assert.equal(page.data.draftExpanded, true);
  page.openWorkspace();
  assert.equal(navigation[0], '/pages/workspace/index?from=agent');
  page.onHide();
  const form = pageFor('workspace');
  await form.onLoad({ from: 'agent' });
  assert.equal(form.data.draft.revision, base.revision);
  form.editCustomer({ ...tap({ id: base.customers[0].id }), detail: { value: '手工修改' } });
  assert.equal(form.data.dirty, true);
  form.onUnload();
  assert.ok(!requests.some(request => request.path === '/session'));
  const later = { ...base, revision: 2 };
  setDraft(later);
  await page.onShow();
  assert.equal(page.draft.revision, 2);
  const reopened = pageFor('workspace');
  await reopened.onLoad({ from: 'agent' });
  assert.equal(reopened.data.active.customer, '手工修改');
  assert.equal(reopened.data.conflict.draft.revision, 2);
  await reopened.useSavedDraft();
  assert.equal(reopened.data.active.customer, '老王');
  assert.equal(reopened.data.dirty, false);
});

test('History page is a read-only three-tab archive without mini controls', () => {
  const wxml = fs.readFileSync(require('node:path').join(__dirname, '../code/dist/pages/history/index.wxml'), 'utf8');
  assert.equal(wxml.includes('size="mini"'), false);
  for (const label of ['送货单', '取货单', '对话记录']) assert.ok(wxml.includes(label), `缺少${label}栏`);
});

test('A1 tabs share login, refresh the current trip and page through read-only history', async t => {
  const draft = order();
  const { deliveryLines, deliverySummary } = require('../code/dist/core/delivery-execution');
  const { page, pageFor, requests, navigation, handle } = setup(t, draft);
  const picking = pageFor('trip-picking');
  const delivery = pageFor('trip-delivery');
  const history = pageFor('history');
  await picking.onShow();
  assert.equal(picking.data.signedIn, false);
  picking.goAssistant();
  assert.equal(navigation.at(-1), '/pages/agent/index');
  await page.login();
  await picking.onShow();
  assert.equal(picking.data.formal, null);
  assert.equal(picking.data.signedIn, true);
  const summary = previewTrip(draft, true);
  const formal = { trip: { id: draft.id, origin: 's2', versions: [{ ...summary, version: 1, savedAt: '2026-11-19T00:00:00Z' }],
    statuses: statusesFor(summary.customers, 'pending'), statusRevision: 0 }, picking: pickingList(summary.customers),
    sheets: [{ sheetId: draft.customers[0].id, reviewed: false, deliveryCompleted: false }] };
  const current = { id: draft.id, issuedAt: '2026-11-19T00:00:00Z', customers: 1, lines: 1, totalCents: 16400,
    pendingPrices: 0, delivered: 0, current: true };
  const old = { ...current, id: 'old', current: false, pendingPrices: 1, delivered: 1 };
  let delivered = false;
  let advanced = false;
  let revision = 0;
  let edits = {};
  let turnsRequests = 0;
  const route = '/trips/' + draft.id + '/sheets/' + draft.customers[0].id;
  const latestTrip = () => ({
    ...formal, deliveryEdits: edits, sheets: formal.sheets.map(sheet => ({ ...sheet, deliveryCompleted: delivered, reviewed: delivered })),
    trip: { ...formal.trip, statusRevision: revision, statuses: statusesFor(summary.customers, delivered ? 'delivered' : 'pending') },
  });
  const details = () => {
    const customer = summary.customers[0];
    const lines = deliveryLines(customer, edits);
    const execution = deliverySummary(lines);
    return { sheet: { tripId: draft.id, sheetId: customer.id, customer: customer.customer, version: 1,
      statusRevision: revision, reviewed: delivered, deliveryCompleted: delivered, orderCents: customer.totalCents, execution,
      amounts: { due: delivered ? execution.totalCents : 0, remaining: 0, paid: 0, excess: 0 },
      lines: lines.map(item => ({ ...item, status: delivered ? 'delivered' : 'pending' })),
    } };
  };
  handle(r => {
    if (r.path === '/workspace') {
      r.ok({ draft: advanced ? { ...draft, id: 'next', revision: 0 } : draft, parties: [],
        draftConfirmed: !advanced, currentTrip: { id: draft.id } });
      return true;
    }
    if (r.path === route) { r.ok(details()); return true; }
    if (r.path === route + '/delivery/line') {
      assert.equal(r.data.receivedQuantity, '1');
      edits = { [r.data.lineId]: { receivedQuantity: 1, unitPriceCents: 8200 } };
      revision++;
      r.ok(details());
      return true;
    }
    if (r.path === route + '/delivery/complete') {
      assert.equal(r.data.statusRevision, 1);
      delivered = true;
      revision++;
      r.ok(details());
      return true;
    }
    if (r.path === '/trips/next-draft') {
      assert.equal(r.data.draftId, draft.id);
      advanced = true;
      r.ok({ draft: { ...draft, id: 'next', revision: 0 } });
      return true;
    }
    if (r.path === '/trips') { r.ok(r.query.get('before') ? { trips: [old], nextBefore: null } : { trips: [current], nextBefore: current.id }); return true; }
    if (r.path === '/trips/old/turns') {
      turnsRequests++;
      r.ok({ tripId: 'old', turns: [{ id: 'old-turn', status: 'completed', revision: 0, materialIds: [], text: '老王两箱水饺',
        events: [
          { seq: 1, kind: 'change', payload: { lines: ['老王 水饺 +2 箱'] } },
          { seq: 2, kind: 'preview', payload: { preview: { ...summary, previewId: 'old-pre', draftId: 'old', revision: 0, choices: [null] } } },
          { seq: 3, kind: 'end', payload: { status: 'completed', text: '草稿已更新。', revision: 0 } },
        ] }] });
      return true;
    }
    if (r.path === '/trips/' + draft.id || r.path === '/trips/old') {
      r.ok({ ...latestTrip(), trip: { ...latestTrip().trip, id: r.path.split('/').at(-1) } }); return true;
    }
  });
  await picking.onShow();
  assert.equal(picking.data.formal.picking[0].quantity, 2);
  await delivery.onShow();
  assert.deepEqual(delivery.data.formal.unfinished, ['老王']);
  let modal;
  wx.showModal = spec => { modal = spec; };
  await delivery.nextTrip();
  assert.match(modal.content, /还有 1 家没确认送达：老王/);
  assert.ok(modal.confirmText.length <= 4, 'wx.showModal 的确认按钮最多 4 个字符');
  modal.success({ confirm: false });
  assert.ok(!requests.some(r => r.path.endsWith('next-draft')));
  await history.onShow();
  assert.equal(history.data.trips[0].current, true);
  await history.loadMore();
  assert.equal(history.data.trips.length, 2);
  assert.match(history.data.trips[1].total, /待补价/);
  await history.openTrip(tap({ id: old.id }));
  assert.equal(history.data.formal.id, old.id);
  assert.equal(history.data.historyTab, 'delivery');
  assert.equal(history.data.selectedShop, null);
  assert.equal(history.data.selectedTime, history.data.trips[1].time);
  assert.equal(history.data.formal.deliveryRows[0].lines[0].originalQuantity, '2');
  assert.equal(history.data.formal.deliveryRows[0].lines[0].quantity, '2');
  await history.openHistoryShop(tap({ sheetId: draft.customers[0].id }));
  assert.equal(history.data.selectedShop.customer, '老王');
  history.closeHistoryShop();
  assert.equal(history.data.selectedShop, null);
  await history.switchHistoryTab(tap({ tab: 'picking' }));
  assert.equal(history.data.historyTab, 'picking');
  await history.switchHistoryTab(tap({ tab: 'turns' }));
  assert.equal(history.data.historyTab, 'turns');
  assert.equal(history.data.tripTurns.length, 1);
  assert.deepEqual(history.data.tripTurns[0].changes, ['老王 水饺 +2 箱']);
  assert.match(history.data.tripTurns[0].previewLabel, /送货单预览/);
  await history.switchHistoryTab(tap({ tab: 'delivery' }));
  await history.switchHistoryTab(tap({ tab: 'turns' }));
  assert.equal(turnsRequests, 1);
  assert.equal(history.saveFieldEdit, undefined);
  await delivery.openSheet(tap({ tripId: draft.id, sheetId: draft.customers[0].id }));
  delivery.beginFieldEdit(tap({ id: draft.customers[0].items[0].id }));
  delivery.editDeliveryField({ ...tap({ field: 'receivedQuantity' }), detail: { value: '1' } });
  await delivery.saveFieldEdit();
  assert.equal(delivery.data.sheet.lines[0].receivedQuantity, 1);
  await delivery.completeDelivery();
  assert.equal(delivery.data.sheet.balance.due, '82.00');
  await delivery.closeSheet();
  assert.deepEqual(delivery.data.formal.unfinished, []);
  wx.showModal = () => assert.fail('全部送达时直接开始下一趟');
  await delivery.nextTrip();
  assert.equal(navigation.at(-1), '/pages/agent/index');
  await picking.onShow();
  assert.equal(picking.data.formal, null);
  assert.equal(requests.filter(r => r.path === '/session/wechat').length, 1);
});

test('Delivery MVP ships five native tabs and the profile tab shares the workspace session safely', async t => {
  const draft = order();
  const { page, pageFor, navigation, handle } = setup(t, draft);
  const app = require('../code/dist/app.json');
  assert.equal(app.tabBar.custom, undefined);
  assert.deepEqual(app.tabBar.list.map(item => item.text), ['助手', '取货', '送货', '历史', '我的']);

  const profile = pageFor('profile');
  await profile.onShow();
  assert.equal(profile.data.signedIn, false);
  assert.equal(profile.data.revokeFailed, false);

  const parties = [{ id: 'party-1', name: '老王' }, { id: 'party-2', name: '老李' }];
  let revokeAttempts = 0;
  handle(request => {
    if (request.path === '/workspace') {
      request.ok({ draft: structuredClone(draft), parties: structuredClone(parties), draftConfirmed: false, currentTrip: null });
      return true;
    }
    if (request.path === '/session' && request.method === 'DELETE') {
      revokeAttempts += 1;
      if (revokeAttempts === 1) request.fail();
      else request.ok(null, 204);
      return true;
    }
    return false;
  });

  await profile.login();
  assert.equal(profile.data.signedIn, true);
  assert.equal(profile.data.tripMode, '晚间录单中');
  assert.match(profile.data.tripDetail, /1 家 1 行/);
  assert.equal(profile.data.partyCount, 2);
  assert.equal(profile.data.canEditForm, true);

  const picking = pageFor('trip-picking');
  await picking.onShow();
  assert.equal(picking.data.signedIn, true);

  profile.openWorkspace();
  assert.equal(navigation.at(-1), '/pages/workspace/index?from=agent');

  await page.onShow();
  assert.equal(page.data.signedIn, true);
  await profile.logout();
  assert.equal(agentSession.token, '');
  assert.equal(profile.data.signedIn, false);
  assert.equal(profile.data.revokeFailed, true);
  assert.notEqual(profile.data.error, '');

  await profile.logout();
  assert.equal(revokeAttempts, 2);
  assert.equal(profile.data.revokeFailed, false);

  await page.onShow();
  assert.equal(page.data.signedIn, false);
});

test('Agent drops the top strip and keeps the next action only on the latest linear card', async t => {
  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  assert.equal(wxml.includes('draft-strip'), false);
  assert.equal(wxml.includes('退出登录'), false);
  assert.equal(wxml.includes('size="mini"'), false);

  const draft = order();
  const { page, requests, event, handle, setTurns, setConfirmed, setDelivery, titles, card } = setup(t, draft);
  await page.onShow();
  await page.login();
  assert.equal(page.data.turns.length, 0);
  assert.equal(page.data.draftSummary.hasLines, true);
  assert.match(page.data.draftSummary.label, /1 家 1 行/);
  assert.equal(page.data.navTitle, '录单助手');
  page.toggleDraft();
  assert.equal(page.data.draftExpanded, true);
  page.toggleDraft();
  assert.equal(page.data.draftExpanded, false);

  const first = { id: 'turn-1', text: '水饺两箱', materialIds: [], status: 'completed', revision: draft.revision,
    events: [event('change', { lines: ['老王 水饺 数量：1箱 → 2箱'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] };
  const second = { id: 'turn-2', text: '再加一箱', materialIds: [], status: 'completed', revision: draft.revision,
    events: [event('change', { lines: ['老王 水饺 数量：2箱 → 3箱'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] };
  setTurns([first, second]);
  await page.onShow();
  assert.equal(page.data.turns[0].showDraftActions, false);
  assert.equal(page.data.turns[0].showStandaloneUndo, true);
  assert.equal(page.data.turns[1].showDraftActions, true);
  assert.equal(page.data.turns[1].showStandaloneUndo, false);

  const preview = { ...card, revision: draft.revision };
  const previewTurn = { id: 'preview-turn', text: '生成送货单', materialIds: [], status: 'completed', revision: draft.revision,
    events: [event('plan', { steps: [{ id: 'confirm', text: '等你确认出单' }, { id: 'issued', text: '出单完成' }] }),
      event('step', { id: 'confirm', state: 'needs_input' }),
      event('preview', { preview }),
      event('end', { status: 'completed', text: '请确认', revision: draft.revision })] };
  handle(request => {
    if (request.path === '/agent/turns') {
      assert.equal(request.data.text, '生成送货单');
      assert.deepEqual(request.data.direct, { intent: 'preview' });
      request.ok({ turnId: previewTurn.id }, 202);
      return true;
    }
    if (request.path === '/agent/turns/preview-turn/events') {
      setTurns([first, second, previewTurn]);
      request.ok({ status: 'completed', events: previewTurn.events });
      return true;
    }
    if (request.path === '/trips/confirm') {
      assert.equal(request.data.previewId, preview.previewId);
      setConfirmed(true, preview.previewId);
      setDelivery({ tripId: draft.id, version: 1, statusRevision: 0, shops: [
        { sheetId: draft.customers[0].id, customer: '老王', locked: false, totalCents: 16400, pendingPrices: 0 },
      ] });
      request.ok({ picking: [] });
      return true;
    }
  });

  await page.previewShortcut();
  page.stopPolling();
  await page.poll();
  assert.equal(page.data.turns.at(-1).preview.active, true);
  assert.equal(page.data.navTitle, '录单助手');
  await page.confirm(tap({ id: preview.previewId }));
  assert.equal(page.data.turns.at(-1).issued, true);
  assert.equal(page.data.navTitle, '送货助手（0/1 已送达）');
  assert.equal(titles.at(-1), '送货助手（0/1 已送达）');
  assert.match(page.data.deliverySummary.label, /0\/1/);
  assert.ok(requests.some(request => request.path === '/trips/confirm'));
});

test('Delivery MVP lists shops before opening a sheet and picking stays a flat read-only view', async t => {
  const deliveryWxml = fs.readFileSync(require.resolve('../code/dist/pages/trip-delivery/index.wxml'), 'utf8');
  assert.equal(deliveryWxml.includes('order-line'), false);
  assert.equal(deliveryWxml.includes('原订'), false);
  assert.equal(deliveryWxml.includes('size="mini"'), false);
  const pickingWxml = fs.readFileSync(require.resolve('../code/dist/pages/trip-picking/index.wxml'), 'utf8');
  const pickingFragment = fs.readFileSync(require.resolve('../code/dist/pages/workspace/picking.wxml'), 'utf8');
  for (const wxml of [pickingWxml, pickingFragment]) {
    assert.equal(wxml.includes('<checkbox'), false);
    assert.equal(wxml.includes('openSheet'), false);
  }

  const draft = order();
  draft.customers.push({
    id: 'c-2', customer: '老李', partyId: null,
    items: [{ id: 'i-2', product: '汤圆', brand: '', specification: '', unit: '箱', quantity: '1', price: '' }],
  });
  const { page, pageFor, handle } = setup(t, draft);
  await page.onShow();
  await page.login();
  const summary = previewTrip(draft, true);
  const statuses = statusesFor(summary.customers, 'pending');
  const formal = { trip: { id: draft.id, origin: 's2', versions: [{ ...summary, version: 1, savedAt: '2026-11-20T00:00:00Z' }],
    statuses, statusRevision: 0 }, picking: pickingList(summary.customers), deliveryEdits: {}, sheets: [] };
  const sheetId = draft.customers[0].id;
  handle(request => {
    if (request.path === '/workspace') {
      request.ok({ draft, parties: [], draftConfirmed: true, currentTrip: { id: draft.id } });
      return true;
    }
    if (request.path === `/trips/${draft.id}`) { request.ok(formal); return true; }
    if (request.path === `/trips/${draft.id}/sheets/${sheetId}`) {
      const customer = summary.customers[0];
      const lines = deliveryLines(customer, {}).map(line => ({ ...line, status: 'pending' }));
      request.ok({ sheet: { tripId: draft.id, sheetId, customer: customer.customer, version: 1, statusRevision: 0,
        reviewed: false, deliveryCompleted: false, orderCents: customer.totalCents, execution: deliverySummary(lines),
        amounts: deliveredBalance(customer, statuses, 0), lines } });
      return true;
    }
    return false;
  });

  const delivery = pageFor('trip-delivery');
  await delivery.onShow();
  assert.equal(delivery.data.sheetTarget, null);
  assert.equal(delivery.data.formal.deliveredCount, 0);
  const [first, second] = delivery.data.formal.deliveryRows;
  assert.equal(first.customer, '老王');
  assert.equal(first.dueLabel, '¥164.00');
  assert.equal(first.amountTitle, '预计应收');
  assert.equal(first.lineCount, 1);
  assert.equal(second.pendingPrices, 1);
  assert.equal(second.pendingPriceOnly, true);
  assert.equal(second.dueLabel, '待补价');
  assert.notEqual(second.dueLabel, '¥0.00');

  await delivery.openSheet(tap({ tripId: draft.id, sheetId }));
  assert.ok(delivery.data.sheetTarget);
  assert.equal(delivery.data.sheet.customer, '老王');
  assert.equal(delivery.data.sheet.lines.length, 1);
  assert.equal(delivery.data.sheet.lines[0].originalQuantity, '2');
  delivery.closeSheet();
  assert.equal(delivery.data.sheetTarget, null);
});

test('Agent starts the next trip from delivery cards with a guard for unfinished shops', async t => {
  const draft = order();
  const { page, requests, event, handle, setDraft, setConfirmed, setDelivery, setTurns } = setup(t, draft);
  const turn = { id: 'turn-1', text: '老王水饺两箱', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('end', { status: 'completed', text: '已整理', revision: draft.revision })] };
  const shops = locked => [{ sheetId: draft.customers[0].id, customer: '老王', locked, totalCents: 16400, pendingPrices: 0 }];
  setConfirmed(true);
  setDelivery({ tripId: draft.id, version: 1, statusRevision: 0, shops: shops(false) });
  setTurns([turn]);
  await page.onShow();
  await page.login();
  assert.equal(page.data.deliverySummary.allDelivered, false);
  assert.equal(page.data.turns.at(-1).showDeliveryFooter, true);
  assert.equal(page.data.turns.at(-1).allDelivered, false);

  let modal;
  global.wx.showModal = spec => { modal = spec; };
  await page.nextTrip();
  assert.match(modal.content, /还有 1 家没确认送达：老王/);
  assert.match(modal.content, /历史/);
  assert.ok(modal.confirmText.length <= 4, 'wx.showModal 的确认按钮最多 4 个字符');
  modal.success({ confirm: false });
  assert.equal(requests.some(request => request.path === '/trips/next-draft'), false);
  assert.equal(page.data.confirmed, true);

  setDelivery({ tripId: draft.id, version: 1, statusRevision: 1, shops: shops(true) });
  await page.onShow();
  assert.equal(page.data.deliverySummary.allDelivered, true);
  assert.equal(page.data.turns.at(-1).allDelivered, true);
  assert.equal(page.data.turns.at(-1).showDeliveryFooter, true);
  assert.equal(page.data.navTitle, '送货助手（1/1 已送达）');

  global.wx.showModal = () => assert.fail('全部送达时无需弹窗，直接开始下一趟');
  handle(request => {
    if (request.path !== '/trips/next-draft') return false;
    assert.equal(request.data.draftId, draft.id);
    assert.ok(request.data.requestId);
    setDraft({ ...draft, id: 'next-trip', revision: 0 });
    setConfirmed(false);
    setTurns([]);
    setDelivery(null);
    request.ok({ draft: { ...draft, id: 'next-trip', revision: 0 } });
    return true;
  });
  await page.nextTrip();
  assert.ok(requests.some(request => request.path === '/agent/card-actions' && request.data.action === 'next'));
  assert.ok(requests.some(request => request.path === '/trips/next-draft'));
  assert.equal(page.data.confirmed, false);
  assert.equal(page.data.turns.length, 0);
  assert.equal(page.data.navTitle, '录单助手');
});

test('A3-2 shows the pending customer choice card and posts the courier selection with remember', async t => {
  const draft = order();
  Object.assign(draft.customers[0], { customer: '阿强' });
  delete draft.customers[0].partyId;
  const customerId = draft.customers[0].id;
  const memory = () => ({ draftId: draft.id, revision: draft.revision, confirmed: false,
    customers: [{ id: 'p-strong', name: '强记面馆' }, { id: 'p-wang', name: '王记餐饮' }],
    mentions: [{ draftCustomerId: customerId, resolution: { status: 'candidate_only', customerId: null,
      candidates: [{ customerId: 'p-strong', canonicalName: '强记面馆' }] } }],
    prices: [] });
  const { page, event, handle, setTurns } = setup(t, draft);
  const selections = [];
  handle(request => {
    if (request.path === '/agent/memory') { request.ok(memory()); return true; }
    if (request.path === '/agent/customer-choice') {
      selections.push(request.data);
      request.ok({ revision: draft.revision + 1, remembered: null });
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();
  assert.equal(page.data.turns.length, 0);
  assert.equal(page.data.choices.length, 1, '起始卡也要显示选店卡');

  setTurns([{ id: 'turn-pending', text: '阿强一箱汤圆', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('change', { lines: ['阿强：待选店'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] }]);
  await page.onShow();
  assert.equal(page.data.choices.length, 1);
  assert.equal(page.data.choices[0].spoken, '阿强');
  assert.equal(page.data.choices[0].remember, true);
  assert.equal(page.data.choices[0].hint, '像下面这几家');
  assert.deepEqual(page.data.choices[0].candidates, [{ id: 'p-strong', name: '强记面馆' }]);
  assert.deepEqual(page.data.memoryNames, ['强记面馆', '王记餐饮']);
  assert.equal(page.data.turns[0].showChoices, true);

  await page.chooseCustomer(tap({ customer: customerId, party: 'p-strong' }));
  const first = selections.at(-1);
  assert.equal(first.choice, 'existing');
  assert.equal(first.customerId, 'p-strong');
  assert.equal(first.remember, true);
  assert.equal(first.draftCustomerId, customerId);
  assert.equal(first.draftId, draft.id);
  assert.equal(first.revision, draft.revision);
  assert.ok(first.requestId);

  page.toggleRemember(tap({ customer: customerId }));
  assert.equal(page.data.choices[0].remember, false);
  await page.chooseCustomer(tap({ customer: customerId, party: 'p-strong' }));
  assert.equal(selections.at(-1).remember, false);

  page.toggleRemember(tap({ customer: customerId }));
  assert.equal(page.data.choices[0].remember, true);
  await page.pickCustomer({ ...tap({ customer: customerId }), detail: { value: '1' } });
  assert.equal(selections.at(-1).customerId, 'p-wang');
  assert.equal(selections.at(-1).remember, true);

  await page.newCustomer(tap({ customer: customerId }));
  assert.equal(selections.at(-1).choice, 'new');
});

test('A3-2 reports a name conflict without an error and reloads after a draft conflict', async t => {
  const draft = order();
  Object.assign(draft.customers[0], { customer: '阿强' });
  delete draft.customers[0].partyId;
  const customerId = draft.customers[0].id;
  const { page, requests, event, handle, setTurns } = setup(t, draft);
  let mode = 'name_conflict';
  handle(request => {
    if (request.path === '/agent/conversation' && mode === 'reload_failed') {
      request.fail();
      return true;
    }
    if (request.path === '/agent/memory') {
      request.ok({ draftId: draft.id, revision: draft.revision, confirmed: false,
        customers: [{ id: 'p-strong', name: '强记面馆' }], prices: [],
        mentions: [{ draftCustomerId: customerId, resolution: { status: 'candidate_only', customerId: null,
          candidates: [{ customerId: 'p-strong', canonicalName: '强记面馆' }] } }] });
      return true;
    }
    if (request.path === '/agent/customer-choice') {
      if (mode !== 'name_conflict') request.ok({ error: 'draft_changed', message: '草稿已变化，请重新选择' }, 409);
      else request.ok({ revision: draft.revision + 1, remembered: false, rememberIssue: 'name_conflict' });
      return true;
    }
    return false;
  });
  setTurns([{ id: 'turn-pending', text: '阿强一箱汤圆', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('change', { lines: ['阿强：待选店'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] }]);
  await page.onShow();
  await page.login();
  await page.chooseCustomer(tap({ customer: customerId, party: 'p-strong' }));
  assert.match(page.data.notice, /没有记住/);
  assert.equal(page.data.error, '');

  const before = requests.filter(request => request.path === '/agent/conversation').length;
  mode = 'draft_changed';
  await page.chooseCustomer(tap({ customer: customerId, party: 'p-strong' }));
  assert.ok(requests.filter(request => request.path === '/agent/conversation').length > before);
  assert.equal(page.data.error, '草稿已变化，请重新选择');

  mode = 'reload_failed';
  await page.chooseCustomer(tap({ customer: customerId, party: 'p-strong' }));
  assert.equal(page.data.error, '草稿已变化，请重新选择');
});

test('A3-2 requires an explicit merge decision after choosing a shop with similar items', async t => {
  const draft = order();
  delete draft.customers[0].partyId;
  const draftCustomerId = draft.customers[0].id;
  const { page, handle } = setup(t, draft);
  const party = { id: 'party-1', name: '王记餐饮' };
  const writes = [];
  const toasts = [];
  let tapIndex;
  global.wx.showToast = toast => toasts.push(toast);
  global.wx.showActionSheet = options => {
    assert.match(options.alertText, /同款或相似明细/);
    assert.deepEqual(options.itemList, ['追加新增明细', '同款保留原明细']);
    if (tapIndex === undefined) options.fail({ errMsg: 'showActionSheet:fail cancel' });
    else options.success({ tapIndex });
  };
  handle(request => {
    if (request.path === '/agent/memory') {
      request.ok({ draftId: draft.id, revision: draft.revision, confirmed: false, customers: [party], prices: [],
        mentions: [{ draftCustomerId, resolution: { status: 'resolved', customerId: party.id, canonicalName: party.name } }] });
      return true;
    }
    if (request.path === '/agent/customer-choice') {
      writes.push(request.data);
      if (request.data.merge) request.ok({ revision: draft.revision + 1, remembered: true });
      else request.ok({ error: 'customer_merge_review', message: '有同款或相似明细，请选择如何合并。' }, 409);
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();
  const event = tap({ customer: draftCustomerId, party: party.id });
  assert.equal(writes.length, 0);
  await page.chooseCustomer(event);
  assert.equal(writes.length, 1);
  assert.equal(toasts.length, 0);

  for (const [index, merge] of ['append', 'keep_existing'].entries()) {
    tapIndex = index;
    await page.chooseCustomer(event);
    const [initial, decision] = writes.slice(-2);
    assert.equal(initial.merge, undefined);
    assert.equal(decision.merge, merge);
    assert.equal(decision.revision, initial.revision);
    assert.notEqual(decision.requestId, initial.requestId);
  }
  assert.equal(toasts.length, 2);
});

test('A3-2 keeps rendering the conversation when draft memory cannot be read', async t => {
  const draft = order();
  const { page, event, handle, setTurns } = setup(t, draft);
  setTurns([{ id: 'turn-1', text: '水饺两箱', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('change', { lines: ['老王 水饺 +2 箱'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] }]);
  handle(request => {
    if (request.path === '/agent/memory') { request.fail(); return true; }
    return false;
  });
  await page.onShow();
  await page.login();
  assert.equal(page.data.memoryFailed, true);
  assert.equal(page.data.turns.length, 1);
  assert.equal(page.data.turns[0].reply, '');
  assert.equal(page.data.error, '');
  assert.deepEqual(page.data.choices, []);
  await page.reload();
});

test('A3-2 offers not-him only for links still pointing at a draft customer', async t => {
  const draft = order();
  Object.assign(draft.customers[0], { customer: '王记餐饮', partyId: 'party-1' });
  const customerId = draft.customers[0].id;
  const { page, event, handle, setDraft, setTurns } = setup(t, draft);
  const link = { draftCustomerId: customerId, spoken: '老王', customerId: 'party-1', canonicalName: '王记餐饮',
    matchedBy: 'alias', merged: false };
  const turn = { id: 'turn-link', text: '老王两箱水饺', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('change', { lines: ['老王 → 王记餐饮（记住的叫法）'] }),
      event('customer_links', { links: [link,
        { ...link, draftCustomerId: 'merged-away', merged: true }] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] };
  setTurns([turn]);
  let payload;
  handle(request => {
    if (request.path === '/agent/customer-choice') {
      payload = request.data;
      request.ok({ revision: draft.revision + 1, remembered: null });
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();
  assert.equal(page.data.turns[0].links.length, 1);
  assert.equal(page.data.turns[0].links[0].label, '老王 → 王记餐饮');
  await page.notHim(tap({ turn: turn.id, customer: customerId }));
  assert.equal(payload.choice, 'unlink');
  assert.equal(payload.spoken, '老王');
  assert.equal(payload.draftCustomerId, customerId);
  assert.equal(payload.draftId, draft.id);
  assert.equal(payload.revision, draft.revision);

  const canonical = { ...draft, customers: [{ ...draft.customers[0], customer: '王记餐饮' }] };
  setDraft(canonical);
  setTurns([{ ...turn, id: 'turn-canonical', events: [event('change', { lines: ['王记餐饮：认出熟客'] }),
    event('customer_links', { links: [{ ...link, spoken: '王记餐饮', matchedBy: 'canonical' }] }),
    event('end', { status: 'completed', text: '草稿已更新。', revision: canonical.revision })] }]);
  await page.onShow();
  assert.equal(page.data.turns[0].links[0].label, '王记餐饮：认出熟客');
});

test('Profile lists remembered aliases and keeps them when the alias reload fails', async t => {
  const draft = order();
  const { pageFor, requests, handle } = setup(t, draft);
  const profile = pageFor('profile');
  const alias = { alias: '老王', normalizedAlias: '老王', customerId: 'party-1', canonicalName: '王记餐饮' };
  let aliasLoads = 0;
  handle(request => {
    if (request.path === '/workspace') {
      request.ok({ draft, parties: [{ id: 'party-1', name: '王记餐饮' }], draftConfirmed: false, currentTrip: null });
      return true;
    }
    if (request.path === '/customer-aliases') {
      aliasLoads += 1;
      if (aliasLoads === 1) request.ok({ aliases: [alias] });
      else request.fail();
      return true;
    }
    if (request.path === '/customer-aliases/unbind') {
      assert.equal(request.data.alias, '老王');
      assert.ok(request.data.requestId);
      request.ok({ removed: alias });
      return true;
    }
    return false;
  });
  await profile.onShow();
  await profile.login();
  assert.equal(profile.data.aliases.length, 1);
  assert.deepEqual(profile.data.aliases[0], { alias: '老王', canonicalName: '王记餐饮' });
  assert.equal(profile.data.aliasError, '');

  let modal;
  global.wx.showModal = spec => { modal = spec; };
  profile.unbindAlias(tap({ alias: '老王', name: '王记餐饮' }));
  assert.match(modal.content, /老王/);
  assert.match(modal.content, /王记餐饮/);
  assert.ok(modal.confirmText.length <= 4);
  assert.equal(requests.filter(request => request.path === '/customer-aliases/unbind').length, 0);

  delete global.wx.showModal;
  await profile.unbindAlias(tap({ alias: '老王', name: '王记餐饮' }));
  assert.equal(requests.filter(request => request.path === '/customer-aliases/unbind').length, 1);
  assert.equal(profile.data.aliases.length, 1);
  assert.notEqual(profile.data.aliasError, '');
});

test('A3-2 choice and alias controls avoid mini buttons and keep the alias card title', () => {
  const agentWxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  const profileWxml = fs.readFileSync(require.resolve('../code/dist/pages/profile/index.wxml'), 'utf8');
  assert.equal(agentWxml.includes('size="mini"'), false);
  assert.equal(profileWxml.includes('size="mini"'), false);
  assert.ok(profileWxml.includes('记住的叫法'));
  assert.ok(agentWxml.includes('!choices.length'));
});

function priceMemory(draft, prices) {
  return { draftId: draft.id, revision: draft.revision, confirmed: false, customers: [], mentions: [], prices };
}

function pricedDraft() {
  const draft = order();
  Object.assign(draft.customers[0], { customer: '王记餐饮', partyId: 'party-1' });
  const base = draft.customers[0].items[0];
  draft.customers[0].items = [
    { ...base, id: 'line-a', product: '水饺', price: null },
    { ...base, id: 'line-b', product: '馄饨', price: null },
    { ...base, id: 'line-c', product: '汤圆', price: null },
  ];
  return draft;
}

test('A3-2 price hints show latest, earlier and variant prices and only tapped suggestions are adopted', async t => {
  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  assert.ok(wxml.includes('全部沿用'));
  assert.ok(wxml.includes('沿用上次价并重新预览'));
  const draft = pricedDraft();
  const customerId = draft.customers[0].id;
  const prices = [
    { draftCustomerId: customerId, lineId: 'line-a', customerId: 'party-1', status: 'exact_match',
      unitPriceCents: 8200, issuedAt: '2026-11-18T12:00:00.000Z', previousDistinctPrice: null },
    { draftCustomerId: customerId, lineId: 'line-b', customerId: 'party-1', status: 'exact_match',
      unitPriceCents: 7800, issuedAt: '2026-11-17T12:00:00.000Z',
      previousDistinctPrice: { unitPriceCents: 8000, issuedAt: '2026-10-30T12:00:00.000Z', tripId: 't-old', sheetId: 's-old' } },
    { draftCustomerId: customerId, lineId: 'line-c', customerId: 'party-1', status: 'ambiguous_variants',
      candidates: [
        { unitPriceCents: 9000, issuedAt: '2026-11-16T12:00:00.000Z', tripId: 't-1', sheetId: 's-1', brand: '甲牌', spec: '500g' },
        { unitPriceCents: 9500, issuedAt: '2026-11-15T12:00:00.000Z', tripId: 't-2', sheetId: 's-2', brand: '乙牌', spec: '1kg' },
      ] },
  ];
  const { page, event, handle, setTurns } = setup(t, draft);
  const posts = [];
  handle(request => {
    if (request.path === '/agent/memory') { request.ok(priceMemory(draft, prices)); return true; }
    if (request.path === '/agent/price-adopt') {
      posts.push(request.data);
      request.ok({ revision: draft.revision + 1, adopted: request.data.lines.length });
      return true;
    }
    return false;
  });
  setTurns([{ id: 'turn-priced', text: '王记餐饮两箱水饺', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('change', { lines: ['王记餐饮 水饺 +2 箱'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] }]);
  await page.onShow();
  await page.login();
  assert.equal(posts.length, 0, '页面加载不得自动沿用');
  assert.equal(page.data.adoptableCount, 2);
  assert.match(page.data.priceHints['line-a'].text, /上次 ¥82\.00（11-18）/);
  assert.match(page.data.priceHints['line-b'].text, /更早 ¥80\.00（10-30）/);
  assert.equal(page.data.priceHints['line-c'].text, '上次买过几种，选一种');
  assert.equal(page.data.priceHints['line-c'].options[0].text, '甲牌 500g ¥90.00');
  assert.deepEqual(page.data.priceHints['line-a'].options, [{ cents: 8200, text: '沿用' }]);
  assert.equal(page.data.priceHints['line-b'].options[1].cents, 8000);

  await page.adoptPrice(tap({ line: 'line-a', customer: customerId, cents: 8200 }));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].lines.length, 1);
  assert.equal(posts[0].lines[0].unitPriceCents, 8200);
  assert.ok(Number.isInteger(posts[0].lines[0].unitPriceCents));
  assert.equal(posts[0].lines[0].draftCustomerId, customerId);
  assert.equal(posts[0].lines[0].lineId, 'line-a');
  assert.equal(posts[0].draftId, draft.id);
  assert.equal(posts[0].revision, draft.revision);
  assert.ok(posts[0].requestId);

  await page.adoptPrice(tap({ line: 'line-b', customer: customerId, cents: 8000 }));
  assert.equal(posts.at(-1).lines[0].unitPriceCents, 8000);
  assert.equal(posts.at(-1).lines[0].variant, undefined);

  await page.adoptPrice(tap({ line: 'line-c', customer: customerId, cents: 9500, brand: '乙牌', spec: '1kg' }));
  assert.deepEqual(posts.at(-1).lines[0].variant, { brand: '乙牌', spec: '1kg' });

  await page.adoptAll();
  assert.deepEqual(posts.at(-1).lines.map(line => [line.lineId, line.unitPriceCents]),
    [['line-a', 8200], ['line-b', 7800]]);
  assert.equal(posts.at(-1).lines.some(line => line.lineId === 'line-c'), false);
});

test('A3-2 adopt-all-and-preview writes before requesting a preview and stays quiet on failure', async t => {
  const draft = pricedDraft();
  const customerId = draft.customers[0].id;
  const prices = [
    { draftCustomerId: customerId, lineId: 'line-a', customerId: 'party-1', status: 'exact_match',
      unitPriceCents: 8200, issuedAt: '2026-11-18T12:00:00.000Z', previousDistinctPrice: null },
    { draftCustomerId: customerId, lineId: 'line-b', customerId: 'party-1', status: 'exact_match',
      unitPriceCents: 7800, issuedAt: '2026-11-17T12:00:00.000Z', previousDistinctPrice: null },
  ];
  const { page, handle } = setup(t, draft);
  const toasts = [];
  const writes = [];
  const turns = [];
  let fail = false;
  let failReload = false;
  let conversations = 0;
  global.wx.showToast = spec => toasts.push(spec);
  handle(request => {
    if (request.path === '/agent/conversation') {
      conversations++;
      if (failReload) { request.fail(); return true; }
      return false;
    }
    if (request.path === '/agent/memory') { request.ok(priceMemory(draft, prices)); return true; }
    if (request.path === '/agent/price-adopt') {
      if (fail) request.ok({ error: 'price_not_suggested', message: '这个价格不在历史成交价里，请刷新后再选。' }, 409);
      else {
        writes.push(request.data);
        request.ok({ revision: draft.revision + 1, adopted: request.data.lines.length });
      }
      return true;
    }
    if (request.path === '/agent/turns') {
      turns.push(request.data);
      request.ok({ turnId: 'preview-turn' }, 202);
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();
  await page.adoptAllAndPreview();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].lines.length, 2);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, '生成送货单');
  assert.deepEqual(turns[0].direct, { intent: 'preview' });
  assert.deepEqual(toasts, [{ title: '已填入单价', icon: 'success' }]);

  page.stopPolling();
  page.setData({ polling: false, error: '' });
  fail = true;
  const beforeConversations = conversations;
  const beforeTurns = turns.length;
  await page.adoptAllAndPreview();
  assert.equal(turns.length, beforeTurns, '写入失败不得发预览请求');
  assert.ok(conversations > beforeConversations, '冲突后应重新拉取对话');
  assert.match(page.data.error, /不在历史成交价里/);
  assert.equal(toasts.length, 1, '失败时不得提示已填入');

  failReload = true;
  await page.adoptAllAndPreview();
  assert.match(page.data.error, /不在历史成交价里/);
  assert.equal(turns.length, beforeTurns);
  assert.equal(toasts.length, 1);
});

test('A3-2 never adopts prices while loading, polling or reloading the conversation', async t => {
  const draft = pricedDraft();
  const customerId = draft.customers[0].id;
  const prices = [{ draftCustomerId: customerId, lineId: 'line-a', customerId: 'party-1', status: 'exact_match',
    unitPriceCents: 8200, issuedAt: '2026-11-18T12:00:00.000Z', previousDistinctPrice: null }];
  const { page, event, handle, setTurns } = setup(t, draft);
  let adopts = 0;
  handle(request => {
    if (request.path === '/agent/memory') { request.ok(priceMemory(draft, prices)); return true; }
    if (request.path === '/agent/price-adopt') { adopts++; request.ok({ revision: draft.revision + 1, adopted: 1 }); return true; }
    if (request.path === '/agent/turns/running-turn/events') {
      request.ok({ status: 'completed', events: [event('end', { status: 'completed', text: '好了', revision: draft.revision })] });
      return true;
    }
    return false;
  });
  setTurns([{ id: 'running-turn', text: '王记餐饮两箱水饺', materialIds: [], revision: draft.revision, status: 'running',
    events: [event('plan', { steps: [{ id: 'intent', text: '看懂你的意思' }] })] }]);
  await page.onShow();
  await page.login();
  page.stopPolling();
  assert.equal(page.data.adoptableCount, 1);
  await page.poll();
  assert.equal(adopts, 0);
  await page.reload();
  assert.equal(adopts, 0);
});
