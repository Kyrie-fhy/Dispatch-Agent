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
  let loginCount = 0;
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
  agentSession.remarkName = '';
  agentSession.disabledMessage = '';
  agentSession.unsaved = null;
  agentSession.deliveryCustomer = null;
  agentSession.deliveryTarget = null;
  global.wx = {
    login: ({ success }) => success({ code: `example-login-${++loginCount}` }),
    request: request => {
      const url = new URL(request.url);
      const path = url.pathname.slice(3);
      const entry = { path, query: url.searchParams, data: request.data, method: request.method, headers: request.header,
        ok: (data, statusCode = 200) => request.success({ statusCode, data }),
        fail: () => request.fail({ errMsg: 'offline' }) };
      requests.push(entry);
      if (path === '/session/wechat') {
        if (onRequest?.(entry)) return;
        return entry.ok({ token }, 201);
      }
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
      if (path === '/catalog/summary') return entry.ok({ productCount: 0, variantCount: 0, activeVariantCount: 0,
        discontinuedVariantCount: 0, missingUnitVariantCount: 0 });
      assert.fail(`Unhandled request ${entry.method} ${path}`);
    },
    navigateTo: ({ url }) => navigation.push(url),
    switchTab: ({ url }) => navigation.push(url),
    setNavigationBarTitle: ({ title }) => titles.push(title),
  };
  const page = pageFor('agent');
  t.after(() => { page.onHide(); agentSession.token = ''; agentSession.remarkName = '';
    agentSession.disabledMessage = ''; agentSession.unsaved = null; });
  return { page, pageFor, requests, navigation, titles, event, card,
    loginCalls: () => loginCount,
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
  assert.match(page.data.draftSummary.label, /当前整单 · 1 家 1 样/);
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
  assert.ok(wxml.includes('trip-pill'), '顶部常驻本趟单据胶囊');

  const draft = order();
  const { page, requests, event, handle, setTurns, setConfirmed, setDelivery, titles, card } = setup(t, draft);
  await page.onShow();
  await page.login();
  assert.equal(page.data.turns.length, 0);
  assert.equal(page.data.draftSummary.hasLines, true);
  assert.match(page.data.draftSummary.label, /当前整单 · 1 家 1 样/);
  assert.equal(page.data.draftSummary.customerCount, 1);
  assert.equal(page.data.draftSummary.lineCount, 1);
  assert.equal(page.data.draftSummary.knownTotalLabel, '¥164.00');
  assert.equal(page.data.draftSummary.hasTodo, false);
  assert.equal(page.data.draftSummary.todoText, '单价齐全，可直接出单');
  assert.equal(page.data.navTitle, '录单助手');

  const first = { id: 'turn-1', text: '水饺两箱', materialIds: [], status: 'completed', revision: draft.revision,
    events: [event('change', { lines: ['老王 水饺 数量：1箱 → 2箱'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] };
  const second = { id: 'turn-2', text: '再加一箱', materialIds: [], status: 'completed', revision: draft.revision,
    events: [event('change', { lines: ['老王 水饺 数量：2箱 → 3箱'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] };
  setTurns([first, second]);
  await page.onShow();
  assert.equal(page.data.turns[0].showChangeList, true, '每轮只展示本轮增量微卡');
  assert.equal(page.data.turns[1].showChangeList, true);

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
  assert.equal(deliveryWxml.includes('size="mini"'), false);
  assert.equal(deliveryWxml.includes('cover-view'), false);
  assert.equal(deliveryWxml.includes('price-tag'), false, '正式送货单不出现草稿价格来源标签');
  const deliveryDetail = deliveryWxml.slice(0, deliveryWxml.indexOf('progress-card'));
  const deliveryList = deliveryWxml.slice(deliveryWxml.indexOf('progress-card'));
  assert.equal(deliveryDetail.includes('原订'), true, '门店详情展示原订数量');
  assert.equal(deliveryList.includes('原订'), false, '门店列表不展示原订数量');
  for (const token of ['确认送达并锁账', '点我改数/价', 'stepReceivedQuantity', 'toggleFieldEdit']) {
    assert.ok(deliveryDetail.includes(token), `门店详情缺少 ${token}`);
  }
  const pickingWxml = fs.readFileSync(require.resolve('../code/dist/pages/trip-picking/index.wxml'), 'utf8');
  const pickingFragment = fs.readFileSync(require.resolve('../code/dist/pages/workspace/picking.wxml'), 'utf8');
  for (const wxml of [pickingWxml, pickingFragment]) {
    assert.equal(wxml.includes('<checkbox'), false);
    assert.equal(wxml.includes('openSheet'), false);
  }
  assert.equal(pickingWxml.includes('size="mini"'), false);
  for (const token of ['冷库取货单', 'picking-qty-box', 'picking-qty-other']) {
    assert.ok(pickingWxml.includes(token), `取货单缺少 ${token}`);
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

test('6.5-2 tags draft and preview lines with price source, a discontinued flag and catalog hints', async t => {
  const draft = order();
  const customer = draft.customers[0];
  const base = customer.items[0];
  Object.assign(base, { price: '82', priceSource: 'customer_history', catalogStatus: 'active', priceHint: null });
  customer.items.push({ ...base, id: 'line-catalog', product: '鸭血', quantity: '2', unit: '盒', price: '6',
    priceSource: 'catalog', catalogStatus: 'discontinued',
    priceHint: '已下架，请核实库存。 库内仅记 ¥6.00（未标箱价）' });
  customer.items.push({ ...base, id: 'line-exact', product: '汤圆', quantity: '1', unit: '箱', price: '30',
    priceSource: 'catalog', catalogStatus: 'discontinued', priceHint: '已下架，请核实库存' });
  customer.items.push({ ...base, id: 'line-spoken', product: '馄饨', quantity: '3', unit: '袋', price: '15',
    priceSource: 'spoken', catalogStatus: 'active', priceHint: null });
  const { page, event, setTurns } = setup(t, draft);
  const preview = { ...previewTrip(draft, true), previewId: 'pre-1', draftId: draft.id, revision: draft.revision, choices: [null] };
  setTurns([{ id: 'preview-turn', text: '生成送货单', materialIds: [], status: 'completed', revision: draft.revision,
    events: [event('preview', { preview }),
      event('end', { status: 'completed', text: '请确认', revision: draft.revision })] }]);
  await page.onShow();
  await page.login();

  const lines = page.data.draftSummary.customers[0].lines;
  assert.equal(lines[0].priceSourceLabel, '熟客价');
  assert.equal(lines[0].discontinued, false);
  assert.equal(lines[0].catalogHint, '');
  assert.equal(lines[1].priceSourceLabel, '库内价');
  assert.equal(lines[1].priceSource, 'catalog');
  assert.equal(lines[1].discontinued, true);
  assert.equal(lines[1].catalogHint, '库里只有散价 ¥6，没箱价');
  assert.equal(lines[2].discontinued, true);
  assert.equal(lines[2].catalogHint, '', '黄牌已表达的下架文案不重复刷出');
  assert.equal(lines[3].priceSourceLabel, '');
  assert.equal(lines[3].discontinued, false);

  const items = page.data.turns[0].preview.customers[0].items;
  assert.equal(items[0].priceSourceLabel, '熟客价');
  assert.equal(items[1].priceSourceLabel, '库内价');
  assert.equal(items[1].discontinued, true);
  assert.equal(items[1].catalogHint, '库里只有散价 ¥6，没箱价');
  assert.equal(items[2].catalogHint, '');
  assert.equal(items[3].priceSourceLabel, '');

  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  for (const token of ['price-tag-history', 'price-tag-catalog', 'warn-tag', '已下架']) {
    assert.ok(wxml.includes(token), `缺少价格来源结构 ${token}`);
  }
  const deliveryWxml = fs.readFileSync(require.resolve('../code/dist/pages/trip-delivery/index.wxml'), 'utf8');
  assert.equal(deliveryWxml.includes('price-tag'), false, '正式送货单不展示草稿价格来源标签');
});

function catalogDraft() {
  const draft = order();
  Object.assign(draft.customers[0].items[0], { product: '鸭血', brand: '', specification: '', unit: '盒',
    quantity: '2', price: null, priceSource: null, catalogStatus: 'ambiguous', priceHint: null });
  return draft;
}

function catalogChoices() {
  return [{ draftCustomerId: '', lineId: '', status: 'ambiguous', priceHint: null, candidates: [
    { productId: 'p-duck', variantId: 'v-300', product: '鸭血', brand: '甲牌', specification: '300g', unit: '盒',
      priceCents: 700, status: 'active' },
    { productId: 'p-duck', variantId: 'v-500', product: '鸭血', brand: '乙牌', specification: '500g', unit: null,
      priceCents: 900, status: 'discontinued' },
  ] }];
}

test('6.5-2 catalog cards choose a variant or keep external with idempotent posts and conflict reloads', async t => {
  const draft = catalogDraft();
  const customer = draft.customers[0];
  const line = customer.items[0];
  const { page, requests, event, handle, setTurns } = setup(t, draft);
  const choices = () => catalogChoices().map(choice => ({ ...choice, draftCustomerId: customer.id, lineId: line.id }));
  const posts = [];
  const toasts = [];
  let conversations = 0;
  let mode = 'success';
  global.wx.showToast = spec => toasts.push(spec);
  setTurns([{ id: 'turn-catalog', text: '老王两盒鸭血', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('change', { lines: ['老王 鸭血 +2 盒'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] }]);
  handle(request => {
    if (request.path === '/agent/conversation') { conversations++; return false; }
    if (request.path === '/agent/memory') {
      request.ok({ draftId: draft.id, revision: draft.revision, confirmed: false, customers: [], mentions: [], prices: [],
        catalogChoices: choices() });
      return true;
    }
    if (request.path === '/agent/catalog-choice') {
      posts.push(request.data);
      if (mode === 'conflict') {
        request.ok({ error: 'catalog_choice_changed', message: '候选规格已更新，请刷新后重新选择' }, 409);
        return true;
      }
      if (request.data.choice === 'variant') {
        request.ok({ revision: draft.revision + 1, item: { ...line, price: '7.00', priceSource: 'catalog' },
          priceUpdates: [{ draftCustomerId: customer.id, lineId: line.id, product: '鸭血', beforePrice: null,
            beforeSource: null, price: '7.00', priceSource: 'catalog', text: '鸭血：待补价 → 库内价 ¥7.00' }] });
      } else {
        request.ok({ revision: draft.revision + 1, item: { ...line, catalogStatus: 'external', priceHint: null },
          priceUpdates: [] });
      }
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();

  assert.equal(page.data.catalogChoices.length, 1);
  const choice = page.data.catalogChoices[0];
  assert.equal(choice.customerName, '老王');
  assert.equal(choice.lineLabel, '鸭血 2 盒');
  assert.equal(choice.hint, '库内有多款货品或规格，请选定后核对单价');
  assert.deepEqual(choice.candidates.map(candidate => candidate.label), [
    '甲牌 鸭血 300g · 盒 ¥7.00',
    '乙牌 鸭血 500g · 库内 ¥9.00（未标单位） · 已下架',
  ]);
  assert.deepEqual(choice.candidates.map(candidate => candidate.warn), [false, true]);
  const cardWxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  assert.ok(cardWxml.includes('都不是，按新货记'));
  assert.ok(cardWxml.includes('catalog-choices'));

  await page.chooseCatalogVariant(tap({ line: line.id, variant: 'v-300' }));
  const variantPost = posts.at(-1);
  assert.equal(variantPost.choice, 'variant');
  assert.equal(variantPost.variantId, 'v-300');
  assert.equal(variantPost.draftCustomerId, customer.id);
  assert.equal(variantPost.lineId, line.id);
  assert.equal(variantPost.draftId, draft.id);
  assert.equal(variantPost.revision, draft.revision);
  assert.ok(variantPost.requestId, '货品选款复用幂等 requestId');
  assert.match(page.data.notice, /已选定规格/);
  assert.match(page.data.notice, /鸭血：待补价 → 库内价 ¥7\.00/);
  assert.equal(toasts.length, 0, '有价格更新说明时不再重复弹成功提示');
  assert.equal(page.data.error, '');

  page.setData({ notice: '旧的选款提示' });
  await page.keepExternalCatalog(tap({ line: line.id }));
  const externalPost = posts.at(-1);
  assert.equal(externalPost.choice, 'external');
  assert.equal(externalPost.variantId, undefined);
  assert.ok(externalPost.requestId);
  assert.equal(page.data.notice, '', '发起选款前清理上一轮提示');
  assert.deepEqual(toasts, [{ title: '已按库外新货保留', icon: 'success' }]);

  mode = 'conflict';
  page.setData({ notice: '', error: '' });
  const before = conversations;
  const toastsBefore = toasts.length;
  await page.chooseCatalogVariant(tap({ line: line.id, variant: 'v-500' }));
  assert.match(page.data.error, /候选规格已更新/);
  assert.ok(conversations > before, '冲突后自动刷新对话');
  assert.equal(toasts.length, toastsBefore, '失败时不得提示已选定');
  assert.equal(page.data.notice, '');
  assert.ok(requests.some(request => request.path === '/agent/catalog-choice'));
});

test('6.5-2 reports customer-price upgrades after choosing a shop without losing the name conflict note', async t => {
  const draft = order();
  Object.assign(draft.customers[0], { customer: '阿强' });
  delete draft.customers[0].partyId;
  const draftCustomerId = draft.customers[0].id;
  const lineId = draft.customers[0].items[0].id;
  const { page, event, handle, setTurns } = setup(t, draft);
  const toasts = [];
  let mode = 'remembered';
  global.wx.showToast = spec => toasts.push(spec);
  setTurns([{ id: 'turn-choice', text: '阿强两箱水饺', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('change', { lines: ['阿强：待选店'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] }]);
  handle(request => {
    if (request.path === '/agent/memory') {
      request.ok({ draftId: draft.id, revision: draft.revision, confirmed: false,
        customers: [{ id: 'p-qiang', name: '强记面馆' }], prices: [],
        mentions: [{ draftCustomerId, resolution: { status: 'resolved', customerId: 'p-qiang', canonicalName: '强记面馆' } }] });
      return true;
    }
    if (request.path === '/agent/customer-choice') {
      const priceUpdates = [{ draftCustomerId, lineId, product: '水饺', beforePrice: '82', beforeSource: 'catalog',
        price: '80', priceSource: 'customer_history', text: '水饺：库内价 ¥82.00 → 熟客价 ¥80.00' }];
      if (mode === 'remembered') request.ok({ revision: draft.revision + 1, remembered: true, priceUpdates });
      else request.ok({ revision: draft.revision + 1, remembered: false, rememberIssue: 'name_conflict', priceUpdates });
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();
  assert.equal(page.data.choices.length, 1);

  await page.chooseCustomer(tap({ customer: draftCustomerId, party: 'p-qiang' }));
  assert.match(page.data.notice, /按熟客价更新：水饺：库内价 ¥82\.00 → 熟客价 ¥80\.00/);
  assert.equal(page.data.error, '');
  assert.deepEqual(toasts, [{ title: '已记住叫法', icon: 'success' }]);

  page.setData({ notice: '' });
  mode = 'conflict';
  await page.chooseCustomer(tap({ customer: draftCustomerId, party: 'p-qiang' }));
  assert.match(page.data.notice, /没有记住这个叫法/);
  assert.match(page.data.notice, /按熟客价更新/);
  assert.equal(page.data.error, '');
});

test('6.5-2 profile shows the read-only catalog summary and degrades quietly when it fails', async t => {
  const draft = order();
  const { pageFor, handle } = setup(t, draft);
  const profile = pageFor('profile');
  let mode = 'loaded';
  handle(request => {
    if (request.path === '/workspace') {
      request.ok({ draft, parties: [{ id: 'party-1', name: '王记餐饮' }], draftConfirmed: false, currentTrip: null });
      return true;
    }
    if (request.path === '/catalog/summary') {
      if (mode === 'failed') request.fail();
      else if (mode === 'empty') request.ok({ productCount: 0, variantCount: 0, activeVariantCount: 0,
        discontinuedVariantCount: 0, missingUnitVariantCount: 0 });
      else request.ok({ productCount: 12, variantCount: 20, activeVariantCount: 18,
        discontinuedVariantCount: 2, missingUnitVariantCount: 1 });
      return true;
    }
    return false;
  });
  await profile.onShow();
  await profile.login();
  assert.deepEqual(profile.data.catalogSummary, { productCount: 12, variantCount: 20, activeVariantCount: 18,
    discontinuedVariantCount: 2, missingUnitVariantCount: 1 });
  assert.equal(profile.data.catalogError, '');

  mode = 'failed';
  await profile.reload();
  assert.deepEqual(profile.data.catalogSummary, { productCount: 12, variantCount: 20, activeVariantCount: 18,
    discontinuedVariantCount: 2, missingUnitVariantCount: 1 }, '刷新失败时保留上一次货品库概览');
  assert.equal(profile.data.catalogError, '货品库信息没加载出来');
  assert.equal(profile.data.loaded, true);
  assert.equal(profile.data.tripMode, '晚间录单中');
  assert.equal(profile.data.partyCount, 1);
  assert.equal(profile.data.error, '', '货品库失败不阻断整页');

  mode = 'empty';
  await profile.reload();
  assert.equal(profile.data.catalogSummary.productCount, 0);
  assert.equal(profile.data.catalogError, '');
  assert.equal(profile.data.partyCount, 1);

  const profileWxml = fs.readFileSync(require.resolve('../code/dist/pages/profile/index.wxml'), 'utf8');
  for (const token of ['货品库', '{{catalogSummary.productCount}} 种', '尚未导入', '正在同步']) {
    assert.ok(profileWxml.includes(token), `缺少货品库概览结构 ${token}`);
  }
  const profileSource = fs.readFileSync(require.resolve('../code/dist/pages/profile/index.js'), 'utf8');
  assert.ok(profileSource.includes('货品库信息没加载出来'));
});

test('6.5-2 catalog controls keep the native design baseline on both pages', () => {
  const agentWxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  const profileWxml = fs.readFileSync(require.resolve('../code/dist/pages/profile/index.wxml'), 'utf8');
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{FE0F}]/u;
  for (const [name, wxml] of [['agent', agentWxml], ['profile', profileWxml]]) {
    assert.equal(wxml.includes('size="mini"'), false, `${name} 不得使用 mini 按钮`);
    assert.equal(emoji.test(wxml), false, `${name} 不得出现 Emoji`);
  }
  for (const token of ['都不是，按新货记', '已下架', 'price-tag-history', 'price-tag-catalog']) {
    assert.ok(agentWxml.includes(token), `缺少 ${token}`);
  }
  assert.ok(profileWxml.includes('货品库'));
});

test('6.5-5 collapses the finished checklist into one running line and one plain summary', async t => {
  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  assert.equal(wxml.includes('wx:for="{{turn.checklist}}"'), false, '跑完后不再渲染多行步骤清单');
  assert.equal(wxml.includes('turn.checklist.length'), false, '卡片显隐不再依赖步骤清单长度');
  for (const token of ['running-bar', 'turn.runningStepText', 'turn.summaryText', 'turn-summary', 'change-list']) {
    assert.ok(wxml.includes(token), `缺少降噪结构 ${token}`);
  }

  const draft = order();
  const { page, event, setTurns } = setup(t, draft);
  await page.onShow();
  await page.login();

  const running = { id: 'turn-running', text: '水饺两箱', materialIds: [], revision: draft.revision, status: 'running',
    events: [
      event('plan', { steps: [{ id: 'intent', text: '看懂你的意思' }, { id: 'edit', text: '整理进草稿' }] }),
      event('step', { id: 'intent', state: 'done' }),
      event('step', { id: 'edit', state: 'running' }),
    ] };
  setTurns([running]);
  await page.onShow();
  assert.equal(page.data.turns[0].runningStepText, '整理进草稿');
  assert.equal(page.data.turns[0].summaryText, '');
  assert.equal(page.data.turns[0].checklist.length, 2, '数据层保留 checklist 供既有测试使用');

  const changed = { id: 'turn-changed', text: '水饺两箱', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('change', { lines: ['老王 水饺 数量：1箱 → 2箱'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] };
  const undone = { ...changed, id: 'turn-undone', events: [...changed.events, event('undo', { revision: draft.revision + 1 })] };
  const failed = { id: 'turn-failed', text: '水饺两箱', materialIds: [], revision: draft.revision, status: 'failed',
    events: [event('end', { status: 'failed', text: '处理失败。草稿没有变化。', revision: draft.revision })] };
  const silent = { id: 'turn-silent', text: '水饺两箱', materialIds: [], revision: draft.revision, status: 'interrupted',
    events: [] };
  const preview = { ...previewTrip(draft, true), previewId: 'pre-1', draftId: draft.id, revision: draft.revision, choices: [null] };
  const previewed = { id: 'turn-preview', text: '生成送货单', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('preview', { preview }), event('end', { status: 'completed', text: '', revision: draft.revision })] };
  setTurns([changed, undone, failed, silent, previewed]);
  await page.onShow();
  assert.equal(page.data.turns[0].runningStepText, '');
  assert.equal(page.data.turns[0].summaryText, '已更新本单明细');
  assert.equal(page.data.turns[0].reply, '', '同一句结果不再重复出现在回复字段');
  assert.equal(page.data.turns[1].summaryText, '这一步已撤回');
  assert.equal(page.data.turns[2].summaryText, '处理失败。草稿没有变化。');
  assert.equal(page.data.turns[3].summaryText, '这一步没跑完，可以把原消息放回输入框重试');
  assert.equal(page.data.turns[4].summaryText, '送货单预览已准备好，核对后点确认出单');
});

test('6.5-5 splits draft and preview lines into nameOnly plus brand and specification', async t => {
  const draft = order();
  const customer = draft.customers[0];
  const base = customer.items[0];
  customer.items[0] = { ...base, product: '芝心虾球', brand: '亚渔', specification: '160g' };
  customer.items.push({ ...base, id: 'line-spec', product: '鸭血', brand: '', specification: '300g', quantity: '2' });
  const { page, event, setTurns } = setup(t, draft);
  const preview = { ...previewTrip(draft, true), previewId: 'pre-1', draftId: draft.id, revision: draft.revision, choices: [null] };
  setTurns([{ id: 'preview-turn', text: '生成送货单', materialIds: [], status: 'completed', revision: draft.revision,
    events: [event('preview', { preview }), event('end', { status: 'completed', text: '请确认', revision: draft.revision })] }]);
  await page.onShow();
  await page.login();

  const lines = page.data.draftSummary.customers[0].lines;
  assert.equal(lines[0].nameOnly, '芝心虾球');
  assert.equal(lines[0].metaLabel, '亚渔 · 160g');
  assert.equal(lines[0].product, '亚渔 芝心虾球 · 160g', '保留原有 product 字段');
  assert.equal(lines[1].nameOnly, '鸭血');
  assert.equal(lines[1].metaLabel, '300g');
  const { lineView } = require('../code/dist/pages/order-view');
  const bare = lineView({ id: 'bare', product: '', brand: '', specification: '', unit: '箱', quantity: '1',
    price: null, amountCents: null });
  assert.equal(bare.nameOnly, '未命名货品');
  assert.equal(bare.metaLabel, '');

  const items = page.data.turns[0].preview.customers[0].items;
  assert.equal(items[0].nameOnly, '芝心虾球');
  assert.equal(items[0].metaLabel, '亚渔 · 160g');
  assert.equal(items[0].productLabel, '亚渔 芝心虾球 · 160g', '预览仍保留原有 productLabel 字段');
  assert.equal(items[1].nameOnly, '鸭血');

  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  for (const token of ['line-row', 'line-primary', 'line-name', 'line-qty', 'line-price', 'line-secondary',
    'line-meta', 'line-tags']) {
    assert.ok(wxml.includes(token), `两行排版缺少 ${token}`);
  }
});

test('6.5-5 shows a quiet voice correction hint and forwards voiceMeta only once', async t => {
  const draft = order();
  const { page, requests, handle } = setup(t, draft);
  const callbacks = {};
  Object.assign(global.wx, {
    authorize({ success }) { success(); },
    getRecorderManager: () => ({
      onStart(callback) { callbacks.start = callback; }, onStop(callback) { callbacks.stop = callback; },
      onError() {}, onInterruptionBegin() {}, start() { callbacks.start(); },
      stop() { callbacks.stop({ tempFilePath: 'corrected.pcm', duration: 1000 }); },
    }),
    getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: new ArrayBuffer(32000) }) }),
    arrayBufferToBase64: bytes => Buffer.from(bytes).toString('base64'),
  });
  let transcription = { draftId: draft.id, revision: draft.revision, text: '明天加两箱水饺', rawText: '明天加两箱水蛟',
    corrections: [{ from: '水蛟', to: '水饺' }, { from: '香姑', to: '香菇' }] };
  let posts = 0;
  handle(request => {
    if (request.path === '/agent/transcription') { request.ok(transcription); return true; }
    if (request.path === '/agent/turns') {
      posts++;
      assert.equal(request.data.text, '明天加两箱水饺');
      assert.deepEqual(request.data.voiceMeta, { rawText: '明天加两箱水蛟',
        corrections: [{ from: '水蛟', to: '水饺' }, { from: '香姑', to: '香菇' }] });
      request.ok({ turnId: 'voice-turn' }, 202);
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();

  const recording = page.record();
  page.stopRecording();
  await recording;
  assert.equal(page.data.text, '明天加两箱水饺');
  assert.equal(page.data.voiceCorrectionHint, '已自动纠正：水蛟→水饺、香姑→香菇');
  assert.deepEqual(page.voiceMeta, { rawText: '明天加两箱水蛟',
    corrections: [{ from: '水蛟', to: '水饺' }, { from: '香姑', to: '香菇' }] });

  await page.send();
  assert.equal(posts, 1);
  assert.equal(page.data.voiceCorrectionHint, '', '发送成功后隐藏纠偏提示');
  assert.equal(page.voiceMeta, null, 'voiceMeta 只随这一次发送透传');
  assert.equal(page.data.text, '');

  transcription = { draftId: draft.id, revision: draft.revision, text: '再来一箱香菇' };
  page.voiceFile = { draft, path: 'corrected.pcm' };
  await page.transcribe();
  assert.equal(page.data.voiceCorrectionHint, '');
  assert.equal(page.voiceMeta, null, '没有纠偏时不得透传 voiceMeta');

  transcription = { draftId: draft.id, revision: draft.revision, text: '明天加两箱水饺', rawText: '明天加两箱水蛟',
    corrections: [{ from: '水蛟', to: '水饺' }] };
  page.voiceFile = { draft, path: 'corrected.pcm' };
  await page.transcribe();
  assert.match(page.data.voiceCorrectionHint, /水蛟→水饺/);
  page.editText({ detail: { value: '' } });
  assert.equal(page.data.voiceCorrectionHint, '', '删空输入框后清空纠偏提示');
  assert.equal(page.voiceMeta, null);
  assert.equal(requests.some(request => request.path === '/agent/turns' && request.data.voiceMeta && posts > 1), false);
});

test('6.5-8 ships a full-width receipt card without nested scrolling or mini controls', () => {
  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxss'), 'utf8');
  assert.equal(/<scroll-view[^>]*draft-inline-body/.test(wxml), false, '明细不再套卡片内滚动框');
  assert.equal(wxss.includes('max-height: 360rpx'), false, '明细不再限高截断');
  assert.equal(wxml.includes('draft-inline'), false, '聊天流不再塞整单巨无霸卡');
  assert.equal(wxml.includes('avatar helper'), false, '取消左侧助手大头像');
  assert.equal(wxml.includes('card-header'), false, '取消旧卡头与「助」徽章');
  assert.equal(wxml.includes('size="mini"'), false, '不得使用 mini 按钮');
  assert.equal(/\benv\(safe-area-inset-top\)/.test(wxss), false, '页面根节点不得叠加顶部安全区');
  for (const token of ['trip-pill', 'order-sheet', 'composer-dock', 'focus-card', 'copy-bubble-btn',
    '撤回', '都不是，按新货记', '发截图、语音或打字记单…']) {
    assert.ok(wxml.includes(token), `缺少方案 A 结构 ${token}`);
  }
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{FE0F}]/u;
  assert.equal(emoji.test(wxml), false, '助手卡片必须是零 Emoji');
});

test('6.5-8 hides the duplicate change wall and spells out pending prices and discontinued lines', async t => {
  const draft = order();
  const customer = draft.customers[0];
  customer.items[0].price = null;
  const base = customer.items[0];
  customer.items.push({ ...base, id: 'line-gone', product: '鸭血', quantity: '2', unit: '盒', price: '6',
    priceSource: 'catalog', catalogStatus: 'discontinued',
    priceHint: '已下架，请核实库存。 库内仅记 ¥6.00（未标箱价）' });
  const { page, event, setTurns } = setup(t, draft);
  setTurns([{ id: 'turn-receipt', text: '老王两箱水饺、两盒鸭血', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('change', { lines: ['新增 2 行'] }),
      event('end', { status: 'completed', text: '草稿已更新。', revision: draft.revision })] }]);
  await page.onShow();
  await page.login();

  const card = page.data.turns[0];
  assert.equal(card.summaryText, '已记上 2 样货');
  assert.equal(card.showChangeList, true, '整单已分离进订单本，聊天流只展示本轮增量');
  const summary = page.data.draftSummary;
  assert.equal(summary.label, '当前整单 · 1 家 2 样');
  assert.equal(summary.lineCount, 2);
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.discontinuedCount, 1);
  assert.equal(summary.alertText, '1 样待填价 · 1 样已下架，请查库存');
  const lines = summary.customers[0].lines;
  assert.equal(lines[0].price, '待填价');
  assert.equal(lines[1].catalogHint, '库里只有散价 ¥6，没箱价');
  assert.equal(lines[1].secondaryText, '库里只有散价 ¥6，没箱价');

  const { catalogHintText } = require('../code/dist/pages/order-view');
  assert.equal(catalogHintText('已下架，请核实库存。 库内仅记 ¥6.00（未标箱价）', true), '库里只有散价 ¥6，没箱价');
  assert.equal(catalogHintText('已下架，请核实库存', true), '', '已下架只用状态标签说一次');
  assert.equal(catalogHintText('库内仅记 ¥6.00（未标计价单位）', false), '库里只记 ¥6，没写单位');
  assert.equal(catalogHintText('库内仅记 袋 ¥15.00', false), '库里只有 袋 ¥15');
  assert.equal(catalogHintText('库内仅记 ¥6.50（未标箱价）', false), '库里只有散价 ¥6.50，没箱价');
  assert.equal(catalogHintText('最近一张已送达单据有多个成交价，请核对', true),
    '最近一张已送达单据有多个成交价，请核对', '其它提示原样保留');
});

test('6.5-8 expands up to eight receipt lines naturally and folds only the overflow', async t => {
  const linesOf = count => {
    const draft = order();
    const base = draft.customers[0].items[0];
    draft.customers[0].items = Array.from({ length: count }, (_, index) => ({ ...base, id: `line-${index}`,
      product: `货品${index + 1}`, quantity: '1', unit: '箱', price: '10' }));
    return draft;
  };
  const short = setup(t, linesOf(8));
  await short.page.onShow();
  await short.page.login();
  const shortSummary = short.page.data.draftSummary;
  assert.equal(shortSummary.lineCount, 8);
  assert.equal(shortSummary.customers.length, 1);
  assert.equal(shortSummary.customers[0].lines.length, 8);

  const long = setup(t, linesOf(10));
  await long.page.onShow();
  await long.page.login();
  const summary = long.page.data.draftSummary;
  assert.equal(summary.lineCount, 10);
  assert.equal(summary.customerCount, 1);
  assert.equal(summary.customers[0].lines.length, 10, '订单本展示完整明细，不再聊天内折叠');
  assert.equal(summary.customers[0].lines[9].nameOnly, '货品10');

  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  assert.ok(wxml.includes('draftSummary.customers'));
  assert.equal(wxml.includes('previewCustomers'), false);
  assert.equal(wxml.includes('展开其余 '), false);
  assert.ok(wxml.includes('order-sheet'));
});

test('6.5-8 copies a user bubble back into the composer and asks before replacing typed text', async t => {
  const draft = order();
  const { page, event, setTurns } = setup(t, draft);
  const writes = [];
  const toasts = [];
  const modals = [];
  Object.assign(global.wx, {
    setClipboardData: spec => writes.push(spec.data),
    showToast: spec => toasts.push(spec),
    showModal: spec => modals.push(spec),
  });
  setTurns([{ id: 'turn-copy', text: '老王两箱水饺', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('end', { status: 'completed', text: '已整理', revision: draft.revision })] }]);
  await page.onShow();
  await page.login();

  page.setData({ text: '', inputMode: 'voice' });
  page.copyTurnText(tap({ turn: 'turn-copy' }));
  assert.equal(page.data.text, '老王两箱水饺');
  assert.equal(page.data.inputMode, 'text');
  assert.equal(page.data.focusInput, true);
  assert.equal(page.data.voiceCorrectionHint, '');
  assert.deepEqual(writes, ['老王两箱水饺']);
  assert.deepEqual(toasts, [{ title: '已放回输入框，改完即可发', icon: 'none' }]);
  assert.equal(modals.length, 0, '输入框为空时直接回填不弹框');

  page.setData({ busy: true, text: '正在发送的原话' });
  page.copyTurnText(tap({ turn: 'turn-copy' }));
  assert.equal(page.data.text, '正在发送的原话', '忙碌时不得覆盖输入框');
  page.setData({ busy: false });

  page.setData({ text: '输入框里已有别的字' });
  page.copyTurnText(tap({ turn: 'turn-copy' }));
  assert.equal(modals.length, 1);
  assert.equal(modals[0].content, '输入框里已有字，要换成这条原话重新编辑吗？');
  assert.ok(modals[0].confirmText.length <= 4, 'showModal 确认按钮最多 4 个字');
  assert.equal(page.data.text, '输入框里已有别的字');
  modals[0].success({ confirm: false });
  assert.equal(page.data.text, '输入框里已有别的字', '取消后保留原字');
  assert.equal(writes.length, 1, '取消时不写剪贴板');

  page.copyTurnText(tap({ turn: 'turn-copy' }));
  modals.at(-1).success({ confirm: true });
  assert.equal(page.data.text, '老王两箱水饺');
  assert.equal(page.data.focusInput, true);
  assert.deepEqual(writes, ['老王两箱水饺', '老王两箱水饺'], '确认后覆盖回填并写入剪贴板');
});

test('6.5-10 extracts only catalog reference prices as one-tap buttons', () => {
  const { catalogReferencePrices } = require('../code/dist/pages/order-view');
  assert.deepEqual(catalogReferencePrices('库内仅记 ¥8.00（未标袋价）'), [{ value: '8', label: '用 ¥8' }]);
  assert.deepEqual(catalogReferencePrices('库内仅记 ¥6.00（未标计价单位）'), [{ value: '6', label: '用 ¥6' }]);
  assert.deepEqual(catalogReferencePrices('已下架，请核实库存。 库内仅记 袋 ¥3.50'), [{ value: '3.5', label: '用 ¥3.5' }]);
  assert.deepEqual(catalogReferencePrices('库内仅记 包 ¥10.00'), [{ value: '10', label: '用 ¥10' }]);
  assert.deepEqual(catalogReferencePrices('库内仅记 袋 ¥3.50 / 箱 ¥80.00'), [
    { value: '3.5', label: '用 ¥3.5（袋）' },
    { value: '80', label: '用 ¥80（箱）' },
  ]);
  assert.deepEqual(catalogReferencePrices('原话有多个单价，请核对'), []);
  assert.deepEqual(catalogReferencePrices('图片疑似标价 ¥49.00（未自动填入，请核对）'), []);
  assert.deepEqual(catalogReferencePrices(''), []);
  assert.deepEqual(catalogReferencePrices(null), []);
});

test('6.5-10 fills a missing customer name inline and drops the stale prompt', async t => {
  const { page, event, handle, setDraft, setTurns } = setup(t, order());
  const draft = order();
  Object.assign(draft.customers[0], { customer: '', partyId: null });
  const customerId = draft.customers[0].id;
  setDraft(draft);
  const toasts = [];
  global.wx.showToast = spec => toasts.push(spec);
  const writes = [];
  const turn = { id: 'turn-name', text: '水饺两箱', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('questions', { questions: [{ customer: '第 1 位客户', text: '请填写客户名称', options: [] }] }),
      event('end', { text: '还差客户名', status: 'completed', revision: draft.revision })] };
  handle(request => {
    if (request.path === '/agent/memory') {
      request.ok({ draftId: draft.id, revision: draft.revision, confirmed: false,
        customers: [{ id: 'p-strong', name: '强记面馆' }], mentions: [], prices: [] });
      return true;
    }
    if (request.path === `/drafts/${draft.id}`) {
      assert.equal(request.method, 'PUT');
      writes.push(request.data);
      const updated = { ...draft, revision: draft.revision + 1, customers: request.data.customers };
      setDraft(updated);
      request.ok({ draft: updated });
      return true;
    }
    return false;
  });
  setTurns([turn]);
  await page.onShow();
  await page.login();
  assert.equal(page.data.draftSummary.unnamedCustomers.length, 1);
  assert.deepEqual(page.data.draftSummary.unnamedCustomers[0], { id: customerId, label: '第 1 位客户' });
  assert.equal(page.data.draftSummary.customers[0].unnamed, true);
  assert.equal(page.data.turns[0].questions.length, 1);
  assert.equal(page.data.turns[0].questions[0].missingCustomer, true);
  assert.deepEqual(page.data.memoryCustomers, [{ id: 'p-strong', name: '强记面馆' }]);

  page.editInlineCustomerName({ ...tap({ customer: customerId }), detail: { value: '新发商店' } });
  assert.equal(page.data.inlineCustomerDrafts[customerId], '新发商店');
  await page.saveInlineCustomerName(tap({ customer: customerId }));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].revision, draft.revision);
  assert.ok(writes[0].requestId);
  assert.equal(writes[0].customers[0].customer, '新发商店');
  assert.equal(page.data.draftSummary.unnamedCustomers.length, 0);
  assert.equal(page.data.turns[0].questions.length, 0, '补好后旧追问不再显示');
  assert.equal(page.data.inlineCustomerDrafts[customerId], undefined);
  assert.deepEqual(toasts.at(-1), { title: '已保存店名', icon: 'success' });
});

test('6.5-10 pins a quick customer and saves sheet names without leaving the sheet', async t => {
  const { page, handle, setDraft } = setup(t, order());
  let current = order();
  Object.assign(current.customers[0], { customer: '', partyId: null });
  setDraft(current);
  const choices = [];
  const writes = [];
  const save = () => { setDraft(current); };
  handle(request => {
    if (request.path === '/agent/memory') {
      request.ok({ draftId: current.id, revision: current.revision, confirmed: false,
        customers: [{ id: 'p-strong', name: '强记面馆' }], mentions: [], prices: [] });
      return true;
    }
    if (request.path === '/agent/customer-choice') {
      choices.push(request.data);
      current = { ...current, revision: current.revision + 1, customers: current.customers.map(customer =>
        ({ ...customer, customer: '强记面馆', partyId: request.data.customerId })) };
      save();
      request.ok({ revision: current.revision, remembered: null });
      return true;
    }
    if (request.path === `/drafts/${current.id}`) {
      writes.push(request.data);
      current = { ...current, revision: current.revision + 1, customers: request.data.customers };
      save();
      request.ok({ draft: current });
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();
  assert.equal(page.data.draftSummary.unnamedCustomers.length, 1);

  const customerId = current.customers[0].id;
  await page.pickQuickCustomer(tap({ customer: customerId, party: 'p-strong' }));
  assert.equal(choices.length, 1);
  assert.equal(choices[0].draftCustomerId, customerId);
  assert.equal(choices[0].choice, 'existing');
  assert.equal(choices[0].customerId, 'p-strong');
  assert.equal(choices[0].remember, false);
  assert.ok(choices[0].requestId);
  assert.equal(page.data.draftSummary.unnamedCustomers.length, 0);

  current = order();
  Object.assign(current.customers[0], { customer: '', partyId: null });
  save();
  await page.reload();
  const secondId = current.customers[0].id;
  page.openCustomerSheet(tap({ customer: secondId }));
  assert.equal(page.data.customerSheet.id, secondId);
  page.editSheetCustomerName({ detail: { value: '强记面馆' } });
  assert.equal(page.data.customerSheet.value, '强记面馆');
  await page.saveCustomerSheet();
  assert.equal(page.data.customerSheet, null);
  assert.equal(choices.at(-1).customerId, 'p-strong');
  assert.equal(choices.at(-1).remember, false);

  current = order();
  Object.assign(current.customers[0], { customer: '', partyId: null });
  save();
  await page.reload();
  const thirdId = current.customers[0].id;
  page.openCustomerSheet(tap({ customer: thirdId }));
  page.editSheetCustomerName({ detail: { value: '新发商店' } });
  await page.saveCustomerSheet();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].customers[0].customer, '新发商店');
  assert.equal(page.data.customerSheet, null);
});

test('6.5-10 fills only pending prices in the drawer and keeps typed input on failure', async t => {
  const draft = order();
  const customer = draft.customers[0];
  const base = customer.items[0];
  customer.items[0] = { ...base, product: '水饺', price: '82' };
  customer.items.push({ ...base, id: 'line-ref', product: '蛋挞皮', quantity: '5', unit: '盒', price: null,
    catalogStatus: 'unit_mismatch', priceHint: '已下架，请核实库存。 库内仅记 袋 ¥3.50 / 箱 ¥80.00' });
  customer.items.push({ ...base, id: 'line-plain', product: '烧卖', quantity: '2', unit: '箱', price: null,
    catalogStatus: null, priceHint: null });
  const { page, requests, handle, setDraft } = setup(t, draft);
  const toasts = [];
  const puts = [];
  const previews = [];
  let failOnce = true;
  let current = draft;
  global.wx.showToast = spec => toasts.push(spec);
  handle(request => {
    if (request.path === `/drafts/${draft.id}`) {
      puts.push(request.data);
      if (failOnce) {
        failOnce = false;
        request.ok({ error: 'server_error', message: '服务暂时不可用，请重试' }, 500);
        return true;
      }
      current = { ...current, revision: current.revision + 1, customers: request.data.customers };
      setDraft(current);
      request.ok({ draft: current });
      return true;
    }
    if (request.path === '/trips/preview') {
      previews.push(request.data);
      assert.equal(request.data.draftId, current.id);
      assert.equal(request.data.revision, current.revision);
      assert.ok(request.data.requestId);
      request.ok({ preview: { ...previewTrip(current, true), previewId: 'pre-sheet', draftId: current.id,
        revision: current.revision, choices: [null] } });
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();

  page.openPriceDrawer(tap({}));
  assert.equal(page.data.priceDrawerOpen, true);
  assert.equal(page.data.priceDrawerFocusId, '');

  page.closePriceDrawer();
  page.openPriceDrawer(tap({ line: 'line-ref' }));
  assert.equal(page.data.priceDrawerFocusId, 'pf-line-ref');
  assert.deepEqual(page.data.priceDrawerRows.map(row => row.lineId), ['line-ref', 'line-plain']);
  assert.deepEqual(page.data.priceDrawerRows[0].refButtons, [
    { value: '3.5', label: '用 ¥3.5（袋）' },
    { value: '80', label: '用 ¥80（箱）' },
  ]);
  assert.equal(page.data.priceDrawerRows[0].customerName, '老王');
  assert.equal(page.data.priceDrawerRows[0].showCustomer, false);
  assert.match(page.data.priceDrawerRows[0].metaLabel, /已下架|库里只有|库内仅记/);

  const before = requests.length;
  page.applyRefPrice(tap({ line: 'line-ref', value: '3.5' }));
  assert.equal(page.data.priceDrawerRows[0].price, '3.5');
  assert.equal(requests.length, before, '点参考价只填本地输入框，绝不自动提交');

  page.toggleDrawerSpec(tap({ line: 'line-ref' }));
  assert.equal(page.data.priceDrawerRows[0].showSpec, true);
  page.editPriceDrawerField({ ...tap({ line: 'line-ref', field: 'unit' }), detail: { value: '袋' } });
  page.editPriceDrawerField({ ...tap({ line: 'line-ref', field: 'specification' }), detail: { value: '1kg' } });
  assert.equal(page.data.priceDrawerRows[0].inputUnit, '袋');
  assert.equal(page.data.priceDrawerRows[0].inputSpecification, '1kg');

  page.editPriceDrawerPrice({ ...tap({ line: 'line-ref' }), detail: { value: '0' } });
  await page.savePriceDrawer();
  assert.equal(puts.length, 0);
  assert.equal(page.data.priceDrawerOpen, true);
  assert.match(page.data.priceDrawerError, /蛋挞皮/);
  assert.match(page.data.priceDrawerError, /单价/);
  assert.equal(page.data.priceDrawerRows[0].price, '0', '校验失败保留已填内容');

  page.editPriceDrawerPrice({ ...tap({ line: 'line-ref' }), detail: { value: 'abc' } });
  await page.savePriceDrawer();
  assert.equal(puts.length, 0);
  assert.match(page.data.priceDrawerError, /蛋挞皮/);

  page.editPriceDrawerField({ ...tap({ line: 'line-ref', field: 'unit' }), detail: { value: '' } });
  page.editPriceDrawerPrice({ ...tap({ line: 'line-ref' }), detail: { value: '8' } });
  await page.savePriceDrawer();
  assert.equal(puts.length, 0);
  assert.match(page.data.priceDrawerError, /单位不能为空/);
  page.editPriceDrawerField({ ...tap({ line: 'line-ref', field: 'unit' }), detail: { value: '袋' } });

  page.editPriceDrawerPrice({ ...tap({ line: 'line-ref' }), detail: { value: '8' } });
  page.editPriceDrawerPrice({ ...tap({ line: 'line-plain' }), detail: { value: '12' } });
  await page.savePriceDrawer();
  assert.equal(puts.length, 1);
  assert.ok(puts[0].requestId);
  assert.equal(puts[0].revision, draft.revision);
  assert.equal(page.data.priceDrawerOpen, true, '5xx 失败不关闭抽屉');
  assert.equal(page.data.priceDrawerRows[0].price, '8', '5xx 失败保留用户输入');
  assert.match(page.data.priceDrawerError, /服务暂时不可用/);

  await page.savePriceDrawer();
  assert.equal(puts.length, 2);
  assert.equal(puts[1].requestId, puts[0].requestId, '同一份输入复用幂等请求号');
  assert.equal(page.data.orderSheetOpen, true, '保存后平滑留在本趟订单本');
  assert.equal(page.data.orderSheetStep, 'list');
  assert.equal(page.data.priceDrawerOpen, true, '仍停留在只看待填价页签');
  assert.deepEqual(page.data.priceDrawerRows, []);
  assert.equal(page.data.priceDrawerDirty, false);
  assert.equal(page.data.draftSummary.pendingCount, 0);
  assert.deepEqual(toasts.at(-1), { title: '已保存修改', icon: 'success' });
  const refLine = puts[1].customers[0].items.find(line => line.id === 'line-ref');
  const plainLine = puts[1].customers[0].items.find(line => line.id === 'line-plain');
  assert.deepEqual([refLine.price, refLine.unit, refLine.specification], ['8', '袋', '1kg']);
  assert.deepEqual([plainLine.price, plainLine.unit], ['12', '箱']);
  assert.equal(puts[1].customers[0].items[0].price, '82', '已定价的行保持原价');

  await page.previewInSheet();
  assert.equal(previews.length, 1);
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.orderSheetStep, 'preview');
  assert.equal(page.data.sheetPreview.total, '228.00');
  assert.equal(page.data.sheetPreview.pendingPrices, 0);
  page.backToSheetList();
  assert.equal(page.data.orderSheetStep, 'list');
  assert.equal(page.data.sheetPreview, null);

  page.openPriceDrawer();
  assert.equal(page.data.priceDrawerOpen, false);
  assert.equal(page.data.orderSheetOpen, false);
  assert.equal(toasts.at(-1).title, '当前没有待填价货品');
});

test('6.5-10 profile retries failed alias and catalog loads in place', async t => {
  const draft = order();
  const { pageFor, handle } = setup(t, draft);
  const profile = pageFor('profile');
  let mode = 'failed';
  handle(request => {
    if (request.path === '/workspace') {
      request.ok({ draft, parties: [], draftConfirmed: false, currentTrip: null });
      return true;
    }
    if (request.path === '/customer-aliases') {
      if (mode === 'failed') request.fail();
      else request.ok({ aliases: [{ alias: '老王', canonicalName: '王记餐饮' }] });
      return true;
    }
    if (request.path === '/catalog/summary') {
      if (mode === 'failed') request.fail();
      else request.ok({ productCount: 12, variantCount: 20, activeVariantCount: 18,
        discontinuedVariantCount: 2, missingUnitVariantCount: 1 });
      return true;
    }
    return false;
  });
  await profile.onShow();
  await profile.login();
  assert.equal(profile.data.aliasError, '叫法列表没加载出来');
  assert.equal(profile.data.catalogError, '货品库信息没加载出来');

  mode = 'loaded';
  await profile.retryLoad();
  assert.equal(profile.data.aliasError, '');
  assert.equal(profile.data.catalogError, '');
  assert.equal(profile.data.aliasesLoaded, true);
  assert.deepEqual(profile.data.aliases, [{ alias: '老王', canonicalName: '王记餐饮' }]);
  assert.equal(profile.data.catalogSummary.productCount, 12);
  assert.equal(profile.data.error, '');
});

test('6.8-3 profile switches to the disabled gate when the alias load reports account_disabled', async t => {
  const draft = order();
  const { pageFor, handle } = setup(t, draft);
  const profile = pageFor('profile');
  handle(request => {
    if (request.path === '/workspace') {
      request.ok({ draft, parties: [], draftConfirmed: false, currentTrip: null });
      return true;
    }
    if (request.path === '/customer-aliases') {
      request.ok({ error: 'account_disabled', message: '当前账号已暂停使用，请联系管理员' }, 403);
      return true;
    }
    if (request.path === '/catalog/summary') {
      request.ok({ productCount: 12, variantCount: 20, activeVariantCount: 18,
        discontinuedVariantCount: 2, missingUnitVariantCount: 1 });
      return true;
    }
    return false;
  });
  await profile.onShow();
  await profile.login();
  assert.equal(agentSession.token, '', '遇到停用必须立刻清空本机会话');
  assert.equal(profile.data.signedIn, false);
  assert.equal(profile.data.authGate, 'disabled');
  assert.equal(profile.data.disabledMessage, '当前账号已暂停使用，请联系管理员');
  assert.equal(agentSession.disabledMessage, '当前账号已暂停使用，请联系管理员');
  assert.equal(profile.data.error, '', '停用提示不应落成普通错误条');
});

test('6.5-10 keeps the new sheets native, equal-width and reachable', () => {
  const read = file => fs.readFileSync(require.resolve(`../code/dist/${file}`), 'utf8');
  const agentWxml = read('pages/agent/index.wxml');
  const agentWxss = read('pages/agent/index.wxss');
  const profileWxml = read('pages/profile/index.wxml');
  const profileWxss = read('pages/profile/index.wxss');
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{FE0F}]/u;
  for (const [name, source] of [['agent.wxml', agentWxml], ['agent.wxss', agentWxss],
    ['profile.wxml', profileWxml], ['profile.wxss', profileWxss]]) {
    assert.equal(source.includes('size="mini"'), false, `${name} 不得使用 mini 按钮`);
    assert.equal(source.includes('cover-view'), false, `${name} 不得使用 cover-view`);
    assert.equal(emoji.test(source), false, `${name} 不得出现 Emoji`);
    assert.equal(source.includes('safe-area-inset-top'), false, `${name} 不得叠加顶部安全区`);
  }
  for (const token of ['openOrderSheet', 'savePriceDrawer', 'applyRefPrice', 'saveInlineCustomerName',
    'pickQuickCustomer', 'openCustomerSheet', 'saveCustomerSheet', '改单位/规格',
    '也可关掉窗口，直接语音一次报多行单价', '只看待填价', 'scroll-into-view="{{priceDrawerFocusId}}"',
    'id="pf-{{row.lineId}}"', '保存价格', '本趟订单本', '预览并出单', '确认出单', '保存店名',
    'drawer-price-input num', '/pages/agent/icons/check.svg', 'class="inline-customer-save"']) {
    assert.ok(agentWxml.includes(token), `缺少速填抽屉结构 ${token}`);
  }
  assert.equal(agentWxml.includes('card-btn-primary inline-customer-save'), false,
    '就地填店名保存图标按钮不得继承全宽 card-btn-primary');
  for (const token of ['z-index: 100', 'env(safe-area-inset-bottom)', 'height: 88rpx', 'height: 80rpx',
    '.drawer-price-input', '.sheet-mask']) {
    assert.ok(agentWxss.includes(token), `缺少抽屉样式 ${token}`);
  }
  for (const token of ['bindtap="retryLoad"', 'aliasError', 'catalogError', 'signedIn && !loaded && error']) {
    assert.ok(profileWxml.includes(token), `缺少就地重试入口 ${token}`);
  }
  for (const token of ['.retry-inline-btn', 'height: 80rpx', '.error-row']) {
    assert.ok(profileWxss.includes(token), `缺少重试样式 ${token}`);
  }
});

test('in-place agent actions keep current scroll position instead of jumping to bottom', async t => {
  const customerId = 'c-scroll';
  const lineId = 'l-scroll';
  let draft = {
    id: 'draft-scroll', revision: 1,
    customers: [{
      id: customerId, customer: '占位店',
      items: [{
        id: lineId, product: '蛋挞皮', brand: '鲁亿嘉腾', specification: '', unit: '袋', quantity: '5',
        price: null, catalogStatus: 'unit_mismatch', priceHint: '库内仅记 ¥8.00（未标袋价）',
      }],
    }],
  };
  const { page, handle, setDraft, setTurns } = setup(t, draft);
  draft = { ...draft, customers: [{ ...draft.customers[0], customer: '' }] };
  setDraft(draft);
  setTurns([{
    id: 't-scroll', text: '', materialIds: ['m-1'], revision: 1, status: 'completed',
    events: [
      { seq: 1, kind: 'change', payload: { lines: ['新增 1 行'] } },
      { seq: 2, kind: 'questions', payload: { questions: [{ customer: '第 1 位客户', text: '请填写客户名称', options: [] }] } },
      { seq: 3, kind: 'end', payload: { status: 'completed', text: '草稿已更新。', revision: 1 } },
    ],
  }]);
  handle(request => {
    if (request.path === '/agent/memory') {
      request.ok({ draftId: draft.id, revision: draft.revision, confirmed: false,
        customers: [{ id: 'p-1', name: '王记餐饮' }], mentions: [], prices: [], catalogChoices: [] });
      return true;
    }
    if (request.method === 'PUT' && request.path === `/drafts/${draft.id}`) {
      draft = { ...draft, revision: draft.revision + 1, customers: request.data.customers };
      setDraft(draft);
      request.ok({ draft });
      return true;
    }
    if (request.method === 'POST' && request.path === '/agent/turns') {
      request.ok({ turnId: 't-next' });
      return true;
    }
    return false;
  });

  await page.onShow();
  await page.login();
  assert.equal(page.data.scrollTo, 'latest', '首次进入滚动到最新位置');

  page.editInlineCustomerName({ ...tap({ customer: customerId }), detail: { value: '张记火锅' } });
  await page.saveInlineCustomerName(tap({ customer: customerId }));
  assert.equal(page.data.scrollTo, '', '保存客户名称后不跳到底部');

  page.openPriceDrawer(tap({ line: lineId }));
  assert.equal(page.data.priceDrawerFocusId, `pf-${lineId}`);
  page.applyRefPrice(tap({ line: lineId, value: '8' }));
  assert.equal(page.data.priceDrawerFocusId, '', '抽屉内点参考价后解除定位锚点，避免回弹');
  await page.savePriceDrawer();
  assert.equal(page.data.scrollTo, '', '保存速填抽屉后不跳到底部');

  await page.onShow();
  assert.equal(page.data.scrollTo, '', '切回同一趟页面时保持当前位置');

  page.editText({ detail: { value: '再加一箱水饺' } });
  await page.send();
  assert.equal(page.data.scrollTo, '', '发送后收到回执不再强行二次跳底');
});

test('6.6-2 runs the Plan A loop from the trip pill through the order book to confirmation', async t => {
  const bare = order();
  bare.customers[0].items[0].price = null;
  const barePage = setup(t, bare);
  await barePage.page.onShow();
  await barePage.page.login();
  assert.equal(barePage.page.data.draftSummary.hasKnownAmount, false);
  assert.equal(barePage.page.data.draftSummary.knownTotalCents, 0);
  assert.equal(barePage.page.data.draftSummary.knownTotalLabel, '待填价', '全单缺价时诚实显示待填价，不误显 ¥0.00');
  assert.equal(barePage.page.data.draftSummary.pendingCount, 1);
  assert.equal(barePage.page.data.draftSummary.todoText, '1 样待填价');

  const draft = order();
  const base = draft.customers[0].items[0];
  draft.customers[0].items[0] = { ...base, id: 'line-known', product: '水饺', quantity: '2', unit: '箱', price: '82' };
  draft.customers[0].items.push({ ...base, id: 'line-missing', product: '烧卖', quantity: '3', unit: '箱', price: null });
  const { page, requests, handle, setDraft, setConfirmed, setDelivery } = setup(t, draft);
  const toasts = [];
  let current = draft;
  global.wx.showToast = spec => toasts.push(spec);
  handle(request => {
    if (request.path === `/drafts/${draft.id}`) {
      assert.equal(request.method, 'PUT');
      assert.ok(request.data.requestId);
      current = { ...current, revision: current.revision + 1, customers: request.data.customers };
      setDraft(current);
      request.ok({ draft: current });
      return true;
    }
    if (request.path === '/trips/preview') {
      assert.equal(request.data.draftId, current.id);
      assert.equal(request.data.revision, current.revision);
      assert.ok(request.data.requestId, '抽屉预览复用幂等 requestId');
      request.ok({ preview: { ...previewTrip(current, true), previewId: 'pre-plan-a', draftId: current.id,
        revision: current.revision, choices: [null] } });
      return true;
    }
    if (request.path === '/trips/confirm') {
      assert.equal(request.data.previewId, 'pre-plan-a');
      assert.ok(request.data.requestId, '抽屉确认复用幂等 requestId');
      setConfirmed(true, 'pre-plan-a');
      setDelivery({ tripId: draft.id, version: 1, statusRevision: 0, shops: [
        { sheetId: draft.customers[0].id, customer: '老王', locked: false, totalCents: 20000, pendingPrices: 0 },
      ] });
      request.ok({ picking: [] });
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();
  assert.equal(page.data.draftSummary.customerCount, 1);
  assert.equal(page.data.draftSummary.lineCount, 2);
  assert.equal(page.data.draftSummary.knownTotalCents, 16400, '整数分累加，不混入缺价行');
  assert.equal(page.data.draftSummary.knownTotalLabel, '¥164.00');
  assert.equal(page.data.draftSummary.pendingCount, 1);
  assert.equal(page.data.draftSummary.hasTodo, true);

  page.setData({ scrollTo: '' });
  page.openOrderSheet(tap({ tab: 'all' }));
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.orderSheetTab, 'all');
  assert.equal(page.data.orderSheetStep, 'list');
  assert.equal(page.data.scrollTo, '', '打开订单本不跳底');

  page.switchOrderSheetTab(tap({ tab: 'pending' }));
  assert.equal(page.data.orderSheetTab, 'pending');
  assert.equal(page.data.priceDrawerOpen, true);
  assert.deepEqual(page.data.priceDrawerRows.map(row => row.lineId), ['line-missing']);
  assert.equal(page.data.scrollTo, '');

  page.editPriceDrawerPrice({ ...tap({ line: 'line-missing' }), detail: { value: '12' } });
  assert.equal(page.data.priceDrawerDirty, true);
  await page.savePriceDrawer();
  assert.equal(page.data.orderSheetOpen, true, '保存后平滑留在订单本');
  assert.equal(page.data.orderSheetTab, 'pending');
  assert.deepEqual(page.data.priceDrawerRows, []);
  assert.equal(page.data.priceDrawerDirty, false);
  assert.equal(page.data.scrollTo, '');

  await page.previewInSheet();
  assert.equal(page.data.orderSheetStep, 'preview');
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.sheetPreview.total, '200.00');
  assert.equal(page.data.sheetPreview.pendingPrices, 0);
  assert.equal(page.data.sheetPreview.allPending, false);
  assert.equal(page.data.sheetPreview.displayTotal, '¥200.00');
  assert.equal(page.data.sheetPreview.customers[0].pendingPrices, 0);
  assert.equal(page.data.sheetPreview.customers[0].allPending, false);
  assert.equal(page.data.sheetPreview.customers[0].displayTotal, '¥200.00');
  const previewRequest = requests.find(request => request.path === '/trips/preview');
  assert.deepEqual([previewRequest.data.draftId, previewRequest.data.revision], [draft.id, 2]);

  await page.confirmSheetPreview();
  assert.equal(page.data.orderSheetOpen, false);
  assert.equal(page.data.confirmed, true);
  assert.equal(page.data.deliverySummary.pillTitle, '送货中 · 0/1 家已送');
  assert.ok(page.data.deliverySummary.pillSub.startsWith('预计应收 ¥200.00'));
  assert.deepEqual(toasts.at(-1), { title: '已出单，取货单与送货单已生成', icon: 'none' });
  assert.ok(requests.some(request => request.path === '/agent/card-actions' && request.data.action === 'confirm'));
});

test('6.6-2 blocks drawer preview until prices are saved and keeps failures inside the sheet', async t => {
  const draft = order();
  const base = draft.customers[0].items[0];
  draft.customers[0].items[0] = { ...base, id: 'line-only', product: '水饺', quantity: '2', unit: '箱', price: null };
  const { page, requests, handle, setDraft } = setup(t, draft);
  let current = draft;
  let mode = 'validation';
  handle(request => {
    if (request.path === `/drafts/${draft.id}`) {
      current = { ...current, revision: current.revision + 1, customers: request.data.customers };
      setDraft(current);
      request.ok({ draft: current });
      return true;
    }
    if (request.path === '/trips/preview') {
      assert.ok(request.data.requestId);
      if (mode === 'validation') request.ok({ error: 'invalid_draft', message: '请填写客户名称' }, 400);
      else request.ok({ error: 'draft_changed', message: '草稿已更新，请重新预览' }, 409);
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();
  await page.onShow();
  assert.equal(page.data.scrollTo, '');

  page.openOrderSheet(tap({ tab: 'pending' }));
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.orderSheetTab, 'pending');
  assert.equal(page.data.scrollTo, '');

  page.editPriceDrawerPrice({ ...tap({ line: 'line-only' }), detail: { value: '8' } });
  assert.equal(page.data.priceDrawerDirty, true);
  await page.previewInSheet();
  assert.equal(requests.some(request => request.path === '/trips/preview'), false, '未保存时不发预览请求');
  assert.match(page.data.priceDrawerError, /保存价格/);
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.orderSheetStep, 'list');
  assert.equal(page.data.priceDrawerRows[0].price, '8', '拦截时保留已填单价');
  assert.equal(page.data.scrollTo, '');

  await page.savePriceDrawer();
  assert.equal(page.data.priceDrawerDirty, false);
  assert.equal(page.data.orderSheetOpen, true);

  await page.previewInSheet();
  assert.equal(page.data.orderSheetOpen, true, '预览校验失败不关抽屉');
  assert.equal(page.data.orderSheetStep, 'list');
  assert.equal(page.data.sheetPreview, null);
  assert.match(page.data.priceDrawerError, /请填写客户名称/);
  assert.equal(page.data.scrollTo, '');

  mode = 'changed';
  await page.previewInSheet();
  assert.equal(page.data.orderSheetOpen, true, '草稿冲突不关抽屉');
  assert.equal(page.data.orderSheetStep, 'list');
  assert.match(page.data.priceDrawerError, /草稿已更新/);
  assert.equal(page.data.scrollTo, '');
});

test('6.6-2 shows honest all-pending totals inside the order book preview', async t => {
  const pending = order();
  pending.customers[0].items[0].price = null;
  const first = setup(t, pending);
  first.handle(request => {
    if (request.path !== '/trips/preview') return false;
    request.ok({ preview: { ...previewTrip(pending, true), previewId: 'pre-all-pending', draftId: pending.id,
      revision: pending.revision, choices: [null] } });
    return true;
  });
  await first.page.onShow();
  await first.page.login();
  first.page.openOrderSheet(tap({ tab: 'all' }));
  await first.page.previewInSheet();
  assert.equal(first.page.data.orderSheetStep, 'preview');
  assert.equal(first.page.data.sheetPreview.total, '0.00', '预览接口原始金额仍是 0');
  assert.equal(first.page.data.sheetPreview.pendingPrices, 1);
  assert.equal(first.page.data.sheetPreview.allPending, true);
  assert.equal(first.page.data.sheetPreview.displayTotal, '待补价', '全单缺价不得显示 ¥0.00');
  assert.equal(first.page.data.sheetPreview.customers[0].pendingPrices, 1);
  assert.equal(first.page.data.sheetPreview.customers[0].allPending, true);
  assert.equal(first.page.data.sheetPreview.customers[0].displayTotal, '待补价');

  const mixed = order();
  const base = mixed.customers[0].items[0];
  mixed.customers[0].items[0] = { ...base, id: 'line-open', price: null };
  mixed.customers.push({ id: 'customer-paid', customer: '老李', partyId: null,
    items: [{ ...base, id: 'line-paid', product: '汤圆', quantity: '1', unit: '箱', price: '30' }] });
  const second = setup(t, mixed);
  second.handle(request => {
    if (request.path !== '/trips/preview') return false;
    request.ok({ preview: { ...previewTrip(mixed, true), previewId: 'pre-mixed', draftId: mixed.id,
      revision: mixed.revision, choices: [null] } });
    return true;
  });
  await second.page.onShow();
  await second.page.login();
  second.page.openOrderSheet(tap({ tab: 'all' }));
  await second.page.previewInSheet();
  assert.equal(second.page.data.sheetPreview.allPending, false);
  assert.equal(second.page.data.sheetPreview.displayTotal, '¥30.00');
  assert.equal(second.page.data.sheetPreview.pendingPrices, 1);
  assert.equal(second.page.data.sheetPreview.customers[0].allPending, true);
  assert.equal(second.page.data.sheetPreview.customers[0].displayTotal, '待补价', '单店全缺价不得显示 ¥0.00');
  assert.equal(second.page.data.sheetPreview.customers[1].allPending, false);
  assert.equal(second.page.data.sheetPreview.customers[1].displayTotal, '¥30.00');
  assert.equal(second.page.data.sheetPreview.customers[1].pendingPrices, 0);

  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  assert.equal(wxml.includes('¥{{sheetPreview.total}}'), false, '总金额不得写死 ¥ 加原始金额');
  assert.equal(wxml.includes('¥{{customer.total}}'), false, '门店小计不得写死 ¥ 加原始金额');
  assert.ok(wxml.includes('sheetPreview.displayTotal'));
  assert.ok(wxml.includes('customer.displayTotal'));
  assert.ok(wxml.includes('trip-pill-todo num {{draftSummary.hasTodo'));
});

test('6.6-1 ships v2.0 global visual tokens and native bar palette', async () => {
  const wxss = fs.readFileSync(require.resolve('../code/dist/app.wxss'), 'utf8');
  for (const token of [
    '--canvas: #F5F6F8', '--ink: #0F172A', '--primary: #0F6E52', '--warning: #B45309',
    '--warning-line: #FDE68A', '--danger: #C81E1E', '--radius-pill: 48rpx', '--shadow-float:',
    '.num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }',
    'box-shadow: var(--shadow-card);', '.btn-secondary:active { background: #E2E8F0; }',
  ]) {
    assert.ok(wxss.includes(token), `app.wxss 缺少 v2.0 令牌或工具类 ${token}`);
  }
  assert.equal(wxss.includes('#12664D'), false, 'app.wxss 仍残留旧主色 #12664D');
  assert.equal(wxss.includes('safe-area-inset-top'), false, '页面根节点严禁叠加顶部安全区');

  const app = require('../code/dist/app.json');
  assert.equal(app.tabBar.custom, undefined, '保持原生 tabBar，严禁 custom: true');
  assert.equal(app.tabBar.list.length, 5, 'tabBar 仍为原生 5 标签');
  assert.equal(app.window.navigationBarBackgroundColor, '#FFFFFF');
  assert.equal(app.window.backgroundColor, '#F5F6F8');
  assert.equal(app.tabBar.color, '#64748B');
  assert.equal(app.tabBar.selectedColor, '#0F6E52');
  assert.equal(app.tabBar.backgroundColor, '#FFFFFF');
});

test('6.6-3 builds the cold-storage picking summary with box and bag separation', () => {
  const { formalTripView } = require('../code/dist/pages/workspace/trip-view');
  const draft = order();
  const base = draft.customers[0].items[0];
  draft.customers.push({ id: 'c-2', customer: '老李', partyId: null, items: [
    { ...base, id: 'i-shared' },
    { id: 'i-bag', product: '汤圆', brand: '甲牌', specification: '500g', unit: '袋', quantity: '3', price: '10' },
  ] });
  const summary = previewTrip(draft, true);
  const formal = { trip: { id: draft.id, origin: 's2',
    versions: [{ ...summary, version: 1, savedAt: '2026-11-24T00:00:00Z' }],
    statuses: statusesFor(summary.customers, 'pending'), statusRevision: 0 },
  picking: pickingList(summary.customers), deliveryEdits: {}, sheets: [] };
  const view = formalTripView(formal);
  assert.equal(view.pickingKindCount, 2);
  assert.equal(view.pickingTotalQty, 7);
  assert.deepEqual(view.picking, formal.picking, '既有 picking 原结构保持不变');
  assert.deepEqual(formal.picking.map(row => row.quantity), [4, 3], '同一货品跨店汇总不变');

  const box = view.pickingRows.find(row => row.unit === '箱');
  assert.deepEqual(box, { ...formal.picking.find(row => row.unit === '箱'),
    title: '水饺', specMeta: '2 家要货', isBox: true });
  const bag = view.pickingRows.find(row => row.unit === '袋');
  assert.deepEqual(bag, { ...formal.picking.find(row => row.unit === '袋'),
    title: '甲牌 汤圆', specMeta: '500g · 1 家要货', isBox: false });

  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/trip-picking/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(require.resolve('../code/dist/pages/trip-picking/index.wxss'), 'utf8');
  for (const token of ['冷库取货单', '{{formal.pickingKindCount}} 种 · {{formal.pickingTotalQty}} 件',
    'picking-qty-box', 'picking-qty-other']) {
    assert.ok(wxml.includes(token), `取货单缺少 ${token}`);
  }
  for (const banned of ['<checkbox', 'openSheet', 'size="mini"', 'cover-view', 'safe-area-inset-top', '¥']) {
    assert.equal(wxml.includes(banned), false, `取货单不得出现 ${banned}`);
  }
  assert.ok(wxss.includes('--primary-weak') && wxss.includes('--canvas-sub'), '箱袋底色复用全局令牌');
  assert.equal(wxss.includes('@import'), false, '取货页不再引入旧 S5 样式');
  assert.equal(wxss.includes('safe-area-inset-top'), false, '页面根节点不得叠加顶部安全区');
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{FE0F}]/u;
  assert.equal(emoji.test(wxml) || emoji.test(wxss), false, '取货页零 Emoji');
});

test('6.6-3 shows honest pending totals, progress and blocks locking an unpriced line', async t => {
  const draft = order();
  const wang = { id: draft.customers[0].id, lineId: draft.customers[0].items[0].id };
  draft.customers[0].items[0].price = null;
  draft.customers.push({ id: 'c-li', customer: '老李', partyId: null,
    items: [{ id: 'i-li', product: '汤圆', brand: '', specification: '', unit: '箱', quantity: '1', price: null }] });
  const summary = previewTrip(draft, true);
  const [wangOrder, liOrder] = summary.customers;
  const baseStatuses = statusesFor(summary.customers, 'pending');
  Object.assign(baseStatuses, Object.fromEntries(liOrder.items.map(item => [item.id, 'delivered'])));

  const { pageFor, requests, handle } = setup(t, draft);
  let edits = {};
  let revision = 0;
  let wangDone = false;
  const statuses = () => wangDone
    ? { ...baseStatuses, ...Object.fromEntries(wangOrder.items.map(item => [item.id, 'delivered'])) }
    : baseStatuses;
  const trip = () => ({
    trip: { id: draft.id, origin: 's2',
      versions: [{ ...summary, version: 1, savedAt: '2026-11-24T00:00:00Z' }],
      statuses: statuses(), statusRevision: revision },
    picking: pickingList(summary.customers), deliveryEdits: edits,
    sheets: [
      { sheetId: wang.id, reviewed: wangDone, deliveryCompleted: wangDone },
      { sheetId: 'c-li', reviewed: true, deliveryCompleted: true },
    ],
  });
  const details = () => {
    const lines = deliveryLines(wangOrder, edits).map(line => ({ ...line, status: wangDone ? 'delivered' : 'pending' }));
    const execution = deliverySummary(lines);
    return { sheet: { tripId: draft.id, sheetId: wang.id, customer: wangOrder.customer, version: 1, statusRevision: revision,
      reviewed: wangDone, deliveryCompleted: wangDone, orderCents: wangOrder.totalCents, execution,
      amounts: { due: wangDone ? execution.totalCents : 0, remaining: 0, paid: 0, excess: 0 }, lines } };
  };
  handle(request => {
    if (request.path === '/workspace') {
      request.ok({ draft, parties: [], draftConfirmed: true, currentTrip: { id: draft.id } });
      return true;
    }
    if (request.path === `/trips/${draft.id}`) { request.ok(trip()); return true; }
    if (request.path === `/trips/${draft.id}/sheets/${wang.id}`) { request.ok(details()); return true; }
    if (request.path === `/trips/${draft.id}/sheets/${wang.id}/delivery/line`) {
      edits = { ...edits, [request.data.lineId]: { receivedQuantity: Number(request.data.receivedQuantity),
        unitPriceCents: request.data.price === null ? null : Math.round(Number(request.data.price) * 100) } };
      revision += 1;
      request.ok(details());
      return true;
    }
    if (request.path === `/trips/${draft.id}/sheets/${wang.id}/delivery/complete`) {
      wangDone = true;
      revision += 1;
      request.ok(details());
      return true;
    }
    return false;
  });

  agentSession.token = token;
  const delivery = pageFor('trip-delivery');
  await delivery.onShow();
  assert.equal(delivery.data.formal.deliveryAllPending, true);
  assert.equal(delivery.data.formal.deliveryTotalTitle, '待补价');
  assert.equal(delivery.data.formal.deliveryTotalAmount, '待补价');
  assert.equal(delivery.data.formal.deliveryTotalCents, 0);
  assert.equal(delivery.data.formal.deliveryPendingCount, 2);
  assert.equal(delivery.data.formal.deliveryProgressPercent, 50);
  assert.equal(delivery.data.formal.deliveredCount, 1);
  const rows = delivery.data.formal.deliveryRows;
  assert.equal(rows[0].dueLabel, '待补价');
  assert.notEqual(rows[0].dueLabel, '¥0.00');
  assert.equal(rows[0].actionHint, '点进核对');
  assert.equal(rows[1].dueLabel, '待补价');
  assert.notEqual(rows[1].dueLabel, '¥0.00');
  assert.equal(rows[1].actionHint, '已锁账');
  const deliveryWxml = fs.readFileSync(require.resolve('../code/dist/pages/trip-delivery/index.wxml'), 'utf8');
  for (const token of ['progress-card', 'progress-fill', 'deliveryProgressPercent', 'deliveryAllPending']) {
    assert.ok(deliveryWxml.includes(token), `送货列表缺少 ${token}`);
  }

  await delivery.openSheet(tap({ tripId: draft.id, sheetId: wang.id }));
  assert.equal(delivery.data.sheet.pendingCount, 1);
  assert.equal(delivery.data.sheet.allPending, true);
  assert.equal(delivery.data.sheet.dueTitle, '预计本次应收');
  assert.equal(delivery.data.sheet.dueDisplay, '待补价');
  assert.notEqual(delivery.data.sheet.dueDisplay, '¥0.00');

  const toasts = [];
  global.wx.showToast = spec => toasts.push(spec);
  await delivery.completeDelivery();
  assert.match(delivery.data.error, /水饺/);
  assert.equal(delivery.data.fieldEdit.id, wang.lineId);
  assert.equal(delivery.data.fieldEdit.receivedQuantity, '2');
  assert.deepEqual(toasts.at(-1), { title: '请先补填缺价货品单价', icon: 'none' });
  assert.equal(requests.filter(request => request.path.endsWith('/delivery/complete')).length, 0, '缺价拦截不得发锁账请求');

  delivery.toggleFieldEdit(tap({ id: wang.lineId }));
  assert.equal(delivery.data.fieldEdit, null, '再点同一行收起编辑');
  delivery.toggleFieldEdit(tap({ id: wang.lineId }));
  assert.equal(delivery.data.fieldEdit.id, wang.lineId);

  delivery.stepReceivedQuantity(tap({ delta: 1 }));
  assert.equal(delivery.data.fieldEdit.receivedQuantity, '3');
  for (let index = 0; index < 4; index += 1) delivery.stepReceivedQuantity(tap({ delta: -1 }));
  assert.equal(delivery.data.fieldEdit.receivedQuantity, '0');
  delivery.stepReceivedQuantity(tap({ delta: -1 }));
  assert.equal(delivery.data.fieldEdit.receivedQuantity, '0', '步进下限锁定 0，不出现负数');

  delivery.editDeliveryField({ ...tap({ field: 'receivedQuantity' }), detail: { value: '0' } });
  await delivery.saveFieldEdit();
  assert.equal(edits[wang.lineId].receivedQuantity, 0);
  assert.equal(edits[wang.lineId].unitPriceCents, null);
  assert.equal(delivery.data.sheet.lines[0].receivedQuantity, 0);
  assert.equal(delivery.data.sheet.lines[0].amountLabel, '¥0.00', '实收 0 计零分');
  assert.equal(delivery.data.fieldEdit, null);

  delivery.toggleFieldEdit(tap({ id: wang.lineId }));
  delivery.editDeliveryField({ ...tap({ field: 'receivedQuantity' }), detail: { value: '1' } });
  delivery.editDeliveryField({ ...tap({ field: 'price' }), detail: { value: '82' } });
  await delivery.saveFieldEdit();
  assert.deepEqual(edits[wang.lineId], { receivedQuantity: 1, unitPriceCents: 8200 });
  assert.equal(delivery.data.sheet.lines[0].amountLabel, '¥82.00');
  assert.equal(delivery.data.sheet.pendingCount, 0);
  assert.equal(delivery.data.sheet.dueDisplay, '¥82.00');
  assert.equal(delivery.data.formal.deliveryTotalCents, 8200);
  assert.equal(delivery.data.formal.deliveryTotalTitle, '已算金额');
  assert.equal(delivery.data.formal.deliveryTotalAmount, '¥82.00');
  assert.equal(delivery.data.formal.deliveryProgressPercent, 50);
  assert.equal(delivery.data.formal.deliveryAllPending, false);

  await delivery.completeDelivery();
  assert.equal(requests.filter(request => request.path.endsWith('/delivery/complete')).length, 1);
  assert.equal(delivery.data.sheet.reviewed, true);
  assert.equal(delivery.data.sheet.dueTitle, '本次实收锁定金额');
  assert.equal(delivery.data.sheet.dueDisplay, '¥82.00');
  assert.equal(delivery.data.formal.deliveryProgressPercent, 100);
  assert.equal(delivery.data.formal.deliveredCount, 2);
  assert.equal(delivery.data.formal.deliveryTotalCents, 8200);
});

test('6.6-4 completes customer naming inside the pending drawer without closing the order book', async t => {
  const draft = order();
  const { page, requests, handle, setDraft } = setup(t, draft);
  const customer = draft.customers[0];
  Object.assign(customer, { customer: '' });
  delete customer.partyId;
  const customerId = customer.id;
  customer.items[0] = { ...customer.items[0], id: 'line-pending', product: '水饺', quantity: '2', unit: '箱', price: null };
  const puts = [];
  const previews = [];
  const toasts = [];
  let current = draft;
  global.wx.showToast = spec => toasts.push(spec);
  handle(request => {
    if (request.path === '/agent/memory') {
      request.ok({ draftId: current.id, revision: current.revision, confirmed: false,
        customers: [], mentions: [], prices: [], catalogChoices: [] });
      return true;
    }
    if (request.method === 'PUT' && request.path === `/drafts/${draft.id}`) {
      puts.push(request.data);
      current = { ...current, revision: current.revision + 1, customers: request.data.customers };
      setDraft(current);
      request.ok({ draft: current });
      return true;
    }
    if (request.path === '/trips/preview') {
      previews.push(request.data);
      request.ok({ preview: { ...previewTrip(current, true), previewId: 'pre-zero-name', draftId: current.id,
        revision: current.revision, choices: [null] } });
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();
  assert.equal(page.data.draftSummary.unnamedCustomers.length, 1);
  assert.equal(page.data.draftSummary.pendingCount, 1);

  page.openOrderSheet(tap({ tab: 'pending' }));
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.orderSheetTab, 'pending');
  assert.deepEqual(page.data.priceDrawerRows.map(row => row.lineId), ['line-pending']);

  page.editPriceDrawerPrice({ ...tap({ line: 'line-pending' }), detail: { value: '8' } });
  await page.savePriceDrawer();
  assert.equal(page.data.orderSheetOpen, true);
  assert.deepEqual(page.data.priceDrawerRows, []);

  await page.previewInSheet();
  assert.equal(previews.length, 0, '未填店名时不得直接发预览请求');
  assert.equal(page.data.orderSheetOpen, true, '自动弹出补店名弹层前抽屉保持打开');
  assert.equal(page.data.customerSheet.id, customerId);
  assert.equal(page.data.customerSheet.label, '未命名客户');
  assert.equal(page.data.customerSheet.value, '');
  assert.ok(toasts.some(toast => toast.title === '先填上店名就能出单'));

  page.editSheetCustomerName({ detail: { value: '老白餐饮' } });
  await page.saveCustomerSheet();
  assert.equal(puts.length, 2);
  assert.equal(puts.at(-1).customers[0].customer, '老白餐饮');
  assert.equal(puts.at(-1).customers[0].partyId, null, '零熟客账号保存店名即按新建客户处理');
  assert.equal(page.data.customerSheet, null);
  assert.equal(page.data.orderSheetOpen, true, '保存店名后订单本仍保持打开');
  assert.equal(page.data.choices.length, 0);
  assert.equal(page.data.priceDrawerError, '');

  await page.previewInSheet();
  assert.equal(previews.length, 1, '补好店名后一次通过预览');
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.orderSheetStep, 'preview');
  assert.equal(page.data.priceDrawerError, '');
  assert.ok(requests.some(request => request.path === '/trips/preview'));
});

test('6.6-4 keeps choice and catalog cards, drawer scroll and pill todos in sync inside the order book', async t => {
  const draft = order();
  const customer = draft.customers[0];
  Object.assign(customer, { customer: '老白餐饮' });
  delete customer.partyId;
  const customerId = customer.id;
  const line = customer.items[0];
  Object.assign(line, { id: 'line-catalog', product: '鸭血', brand: '', specification: '', unit: '盒',
    quantity: '2', price: null, priceSource: null, catalogStatus: 'ambiguous', priceHint: null });
  const { page, requests, handle, setDraft } = setup(t, draft);
  const previews = [];
  const choices = [];
  const catalogs = [];
  let current = draft;
  global.wx.showToast = () => {};
  const pendingMention = () => ({ draftCustomerId: customerId, resolution: { status: 'candidate_only', customerId: null,
    candidates: [{ customerId: 'p-strong', canonicalName: '强记面馆' }] } });
  const catalogChoice = () => ({ draftCustomerId: customerId, lineId: line.id, status: 'ambiguous', priceHint: null,
    candidates: [{ productId: 'p-duck', variantId: 'v-300', product: '鸭血', brand: '甲牌', specification: '300g',
      unit: '盒', priceCents: 700, status: 'active' }] });
  handle(request => {
    if (request.path === '/agent/memory') {
      const state = current.customers[0];
      request.ok({ draftId: current.id, revision: current.revision, confirmed: false,
        customers: [{ id: 'p-strong', name: '强记面馆' }],
        mentions: state.partyId === undefined ? [pendingMention()] : [], prices: [],
        catalogChoices: state.items[0].catalogStatus === 'ambiguous' ? [catalogChoice()] : [] });
      return true;
    }
    if (request.path === '/agent/customer-choice') {
      choices.push(request.data);
      current = { ...current, revision: current.revision + 1, customers: current.customers.map(entry =>
        entry.id === customerId ? { ...entry, partyId: null } : entry) };
      setDraft(current);
      request.ok({ revision: current.revision, remembered: null });
      return true;
    }
    if (request.path === '/agent/catalog-choice') {
      catalogs.push(request.data);
      current = { ...current, revision: current.revision + 1, customers: current.customers.map(entry =>
        entry.id === customerId ? { ...entry, items: entry.items.map(item => item.id === line.id
          ? { ...item, price: '7.00', priceSource: 'catalog', catalogStatus: null } : item) } : entry) };
      setDraft(current);
      request.ok({ revision: current.revision, item: current.customers[0].items[0],
        priceUpdates: [{ draftCustomerId: customerId, lineId: line.id, product: '鸭血', beforePrice: null,
          beforeSource: null, price: '7.00', priceSource: 'catalog', text: '鸭血：待补价 → 库内价 ¥7.00' }] });
      return true;
    }
    if (request.path === '/trips/preview') {
      previews.push(request.data);
      request.ok({ preview: { ...previewTrip(current, true), previewId: 'pre-choice', draftId: current.id,
        revision: current.revision, choices: [null] } });
      return true;
    }
    return false;
  });
  await page.onShow();
  await page.login();
  assert.equal(page.data.choices.length, 1);
  assert.equal(page.data.catalogChoices.length, 1);
  assert.match(page.data.draftSummary.todoText, /待确认客户/);
  assert.match(page.data.draftSummary.todoText, /待选款/);

  page.openOrderSheet(tap({ tab: 'pending' }));
  assert.equal(page.data.orderSheetOpen, true);
  const beforeTop = page.data.orderSheetScrollTop;
  await page.previewInSheet();
  assert.equal(previews.length, 0, '待确认客户时不得发预览请求');
  assert.match(page.data.priceDrawerError, /请先在上方确认「老白餐饮」是已有熟客还是新建客户/);
  assert.notEqual(page.data.orderSheetScrollTop, beforeTop, '提示同时把订单本滚回顶部露出选店卡');
  assert.equal(page.data.orderSheetOpen, true);

  await page.newCustomer(tap({ customer: customerId }));
  assert.deepEqual(choices.map(choice => choice.choice), ['new']);
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.priceDrawerError, '');
  assert.deepEqual(page.data.priceDrawerRows.map(row => row.lineId), ['line-catalog'], '选店后待填价列表原地刷新');
  assert.equal(page.data.choices.length, 0);

  await page.chooseCatalogVariant(tap({ line: line.id, variant: 'v-300' }));
  assert.equal(catalogs.length, 1);
  assert.equal(catalogs[0].variantId, 'v-300');
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.priceDrawerError, '');
  assert.deepEqual(page.data.priceDrawerRows, [], '选款带回价格后待填价列表同步清空');
  assert.equal(page.data.catalogChoices.length, 0);

  await page.previewInSheet();
  assert.equal(previews.length, 1);
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.orderSheetStep, 'preview');
  assert.ok(requests.some(request => request.path === '/trips/preview'));

  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{FE0F}]/u;
  assert.ok(wxml.includes('sheet-pending-actions'));
  assert.ok(wxml.includes('scroll-top="{{orderSheetScrollTop}}"'));
  assert.ok(wxml.includes('id="pf-{{row.lineId}}"'), '待填价定位锚点保持');
  assert.equal(wxml.includes('size="mini"'), false);
  assert.equal(wxml.includes('cover-view'), false);
  assert.equal(wxml.includes('safe-area-inset-top'), false);
  assert.equal(emoji.test(wxml), false);
});

test('6.7-1 history archive ships the v2.0 read-only visual and honest trip totals', async t => {
  const read = file => fs.readFileSync(require.resolve(`../code/dist/${file}`), 'utf8');
  const wxml = read('pages/history/index.wxml');
  const wxss = read('pages/history/index.wxss');
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{FE0F}]/u;

  assert.equal(wxss.includes('@import'), false, '历史页不再引入旧 S5 workspace 样式');
  assert.equal(wxml.includes('<include'), false, '历史页不再内联 workspace 取货模板');
  assert.equal(wxml.includes('picking.wxml'), false, '历史页彻底脱离 workspace/picking.wxml');
  for (const token of ['avatar', 'avatar mine', 'avatar helper', 'class="title"']) {
    assert.equal(wxml.includes(token), false, `历史页不得保留旧版 ${token}`);
  }
  for (const token of ['picking-qty-box', 'picking-qty-other', 'deliveryProgressPercent', 'back-pill',
    'sheet-hero-card', 'sheet-lines-card', 'status-pill', 'trip-hero-card', 'trip-card', 'turn-card',
    '当时的待确认', '只读档案']) {
    assert.ok(wxml.includes(token), `历史页缺少 v2.0 结构 ${token}`);
  }
  for (const banned of ['size="mini"', 'cover-view', 'safe-area-inset-top', '欠款', '收款',
    '<input', 'bindinput', 'saveFieldEdit', '编辑货品']) {
    assert.equal(wxml.includes(banned), false, `历史页只读红线被破坏：${banned}`);
  }
  assert.equal(emoji.test(wxml) || emoji.test(wxss), false, '历史页零 Emoji');
  for (const token of ['.history-page', 'padding: 24rpx var(--page-x) calc(48rpx + env(safe-area-inset-bottom))',
    '--primary-weak', '--warning-weak', 'height: 80rpx', '.trip-progress-fill']) {
    assert.ok(wxss.includes(token), `历史页缺少 v2.0 样式 ${token}`);
  }

  const draft = order();
  const summary = previewTrip(draft, true);
  const formal = { trip: { id: 'trip-current', origin: 's2',
    versions: [{ ...summary, version: 1, savedAt: '2026-11-19T00:00:00Z' }],
    statuses: statusesFor(summary.customers, 'pending'), statusRevision: 0 },
  picking: pickingList(summary.customers), deliveryEdits: {}, sheets: [] };
  const rows = [
    { id: 'trip-current', issuedAt: '2026-11-25T10:30:00Z', customers: 2, lines: 3, totalCents: 16400,
      pendingPrices: 0, delivered: 0, current: true },
    { id: 'trip-all-pending', issuedAt: '2026-11-24T10:30:00Z', customers: 1, lines: 1, totalCents: 0,
      pendingPrices: 2, delivered: 1, current: false },
    { id: 'trip-partial', issuedAt: '2026-11-23T10:30:00Z', customers: 3, lines: 4, totalCents: 8200,
      pendingPrices: 1, delivered: 1, current: false },
    { id: 'trip-done', issuedAt: '2026-11-22T10:30:00Z', customers: 2, lines: 2, totalCents: 16400,
      pendingPrices: 0, delivered: 2, current: false },
    { id: 'trip-unfinished', issuedAt: '2026-11-21T10:30:00Z', customers: 2, lines: 2, totalCents: 16400,
      pendingPrices: 0, delivered: 1, current: false },
  ];
  const { page, pageFor, handle, titles } = setup(t, draft);
  handle(request => {
    if (request.path === '/trips') { request.ok({ trips: rows, nextBefore: null }); return true; }
    if (request.path === '/trips/trip-current') { request.ok(formal); return true; }
    if (request.path === '/trips/trip-current/turns') { request.ok({ tripId: 'trip-current', turns: [] }); return true; }
    return false;
  });
  await page.login();
  const history = pageFor('history');
  await history.onShow();
  const [current, allPending, partial, done, unfinished] = history.data.trips;

  assert.equal(current.allPending, false);
  assert.equal(current.amountDisplay, '¥164.00');
  assert.equal(current.pendingNote, '');
  assert.equal(current.statusLabel, '进行中');
  assert.equal(current.statusTone, 'current');

  assert.equal(allPending.allPending, true);
  assert.equal(allPending.amountDisplay, '待补价', '全单缺价诚实显示待补价，绝不混同为 ¥0.00');
  assert.equal(allPending.pendingNote, '');
  assert.equal(allPending.statusLabel, '已全部送达');
  assert.equal(allPending.statusTone, 'done');

  assert.equal(partial.allPending, false);
  assert.equal(partial.amountDisplay, '¥82.00');
  assert.equal(partial.pendingNote, '另有 1 样待补价');
  assert.match(partial.total, /待补价/);
  assert.equal(partial.statusLabel, '未送完');
  assert.equal(partial.statusTone, 'pending');

  assert.equal(done.statusLabel, '已全部送达');
  assert.equal(done.statusTone, 'done');
  assert.equal(unfinished.statusLabel, '未送完');
  assert.equal(unfinished.statusTone, 'pending');

  await history.openTrip(tap({ id: 'trip-current' }));
  assert.equal(history.data.formal.id, 'trip-current');
  assert.equal(titles.at(-1), '趟次档案', '切进单趟档案同步导航标题');
  await history.openHistoryShop(tap({ sheetId: draft.customers[0].id }));
  assert.equal(history.data.selectedShop.customer, '老王');
  assert.equal(titles.at(-1), '门店送货单', '只读门店详情同步导航标题');
  history.closeHistoryShop();
  assert.equal(history.data.selectedShop, null);
  assert.equal(titles.at(-1), '趟次档案', '返回单趟门店列表恢复趟次档案标题');
  history.backToList();
  assert.equal(history.data.formal, null);
  assert.equal(titles.at(-1), '历史', '返回趟次列表恢复历史标题');
  assert.equal(history.saveFieldEdit, undefined, '历史页绝不出现写操作');
});

test('6.7-1 profile ships the trip status bar, side-by-side metrics and full-width retry', () => {
  const read = file => fs.readFileSync(require.resolve(`../code/dist/${file}`), 'utf8');
  const wxml = read('pages/profile/index.wxml');
  const wxss = read('pages/profile/index.wxss');
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{FE0F}]/u;

  for (const token of ['trip-status-card', 'metrics-grid', 'metric-card', 'retry-banner',
    '记住的叫法', '货品库', '{{catalogSummary.productCount}} 种', '尚未导入', '正在同步',
    'bindtap="login"', 'bindtap="logout"', 'bindtap="retryLoad"', 'bindtap="unbindAlias"',
    'bindtap="openWorkspace"', '{{partyCount}} 家', '{{aliases.length}} 条', '本趟阶段']) {
    assert.ok(wxml.includes(token), `我的页缺少 v2.0 结构或既有契约 ${token}`);
  }
  for (const banned of ['size="mini"', 'cover-view', 'safe-area-inset-top']) {
    assert.equal(wxml.includes(banned), false, `我的页不得出现 ${banned}`);
  }
  assert.equal(emoji.test(wxml) || emoji.test(wxss), false, '我的页零 Emoji');
  for (const token of ['grid-template-columns: repeat(2, minmax(0, 1fr))', '.retry-banner',
    'height: 80rpx', 'width: 148rpx', 'height: 88rpx', 'var(--hairline-strong)', '.identity-card',
    '.trip-status-dot']) {
    assert.ok(wxss.includes(token), `我的页缺少 v2.0 样式 ${token}`);
  }
});

test('6.8-3 activation gate rebinds with a fresh wechat code and restores the remark name', async t => {
  const draft = order();
  const { page, pageFor, handle, loginCalls } = setup(t, draft);
  const sessions = [];
  handle(request => {
    if (request.path !== '/session/wechat') return false;
    sessions.push(request.data);
    if (!request.data.activationCode) {
      request.ok({ error: 'activation_required', message: '请输入管理员提供的开通码完成开通' }, 403);
    } else if (request.data.activationCode !== 'DZ-8F2K-9Q1M') {
      request.ok({ error: 'invalid_activation_code', message: '开通码无效或已被使用，请联系管理员核对' }, 403);
    } else {
      request.ok({ token, remarkName: '老张冻品' }, 201);
    }
    return true;
  });

  await page.onShow();
  await page.login();
  assert.equal(page.data.signedIn, false);
  assert.equal(page.data.authGate, 'activation', '首次进入安静切到输码界面');
  assert.equal(page.data.error, '', '不显示吓人的红色报错条');
  assert.equal(loginCalls(), 1);

  page.onActivationInput({ detail: { value: 'DZ-WRONG-CODE' } });
  await page.submitActivation();
  assert.equal(page.data.authGate, 'activation', '错码留在输码态');
  assert.equal(page.data.activationCode, 'DZ-WRONG-CODE', '错码提交后保留用户输入');
  assert.match(page.data.error, /开通码无效或已被使用/);
  assert.equal(loginCalls(), 2, '提交开通码必须重新调用 wechatCode');
  assert.notEqual(sessions[1].code, sessions[0].code, '重新取得全新微信凭证');

  page.onActivationInput({ detail: { value: ' DZ-8F2K-9Q1M ' } });
  await page.submitActivation();
  assert.equal(sessions[2].activationCode, 'DZ-8F2K-9Q1M', '开通码去掉首尾空白后提交');
  assert.notEqual(sessions[2].code, sessions[1].code, '成功绑定同样使用新凭证');
  assert.equal(loginCalls(), 3);
  assert.equal(page.data.signedIn, true);
  assert.equal(page.data.authGate, '');
  assert.equal(agentSession.token, token);
  assert.equal(agentSession.remarkName, '老张冻品');
  assert.equal(agentSession.disabledMessage, '');

  const profile = pageFor('profile');
  await profile.onShow();
  assert.equal(profile.data.signedIn, true);
  assert.equal(profile.data.remarkName, '老张冻品', '我的页身份卡显示后台备注名');
  const profileWxml = fs.readFileSync(require.resolve('../code/dist/pages/profile/index.wxml'), 'utf8');
  assert.ok(profileWxml.includes("{{remarkName || '微信账号已登录'}}"));
  assert.ok(profileWxml.includes('微信账号已登录 · 数据独立同步'));
  page.onHide();
});

test('6.8-3 wechat login lands on the disabled card without a scary error banner', async t => {
  const draft = order();
  const { page, handle } = setup(t, draft);
  handle(request => {
    if (request.path !== '/session/wechat') return false;
    request.ok({ error: 'account_disabled', message: '当前账号已暂停使用，请联系管理员' }, 403);
    return true;
  });

  await page.onShow();
  await page.login();
  assert.equal(page.data.signedIn, false);
  assert.equal(page.data.authGate, 'disabled');
  assert.equal(page.data.disabledMessage, '当前账号已暂停使用，请联系管理员');
  assert.equal(page.data.error, '');
  assert.equal(agentSession.token, '');
  assert.equal(agentSession.disabledMessage, '当前账号已暂停使用，请联系管理员');

  await page.onShow();
  assert.equal(page.data.authGate, 'disabled', '回到助手页仍保持停用态');

  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/agent/index.wxml'), 'utf8');
  for (const token of ['当前账号已暂停使用', '{{disabledMessage ||', '重新登录',
    '管理员在后台恢复启用后，可点击下方按钮重新登录']) {
    assert.ok(wxml.includes(token), `停用卡缺少 ${token}`);
  }
});

test('6.8-3 account disabled during use clears the agent session and stops polling', async t => {
  const draft = order();
  const { page, handle } = setup(t, draft);
  await page.login();
  assert.equal(page.data.signedIn, true);

  handle(request => {
    if (request.path === '/agent/conversation') {
      request.ok({ error: 'account_disabled', message: '当前账号已暂停使用，请联系管理员' }, 403);
      return true;
    }
    return false;
  });
  await page.onShow();
  assert.equal(agentSession.token, '', '立刻清空本机会话');
  assert.equal(agentSession.remarkName, '');
  assert.equal(page.data.signedIn, false);
  assert.equal(page.data.authGate, 'disabled');
  assert.equal(page.data.polling, false, '停止轮询');
  assert.equal(page.data.draftSummary, null, '草稿视图已清空');
  assert.equal(page.data.disabledMessage, '当前账号已暂停使用，请联系管理员');
  assert.equal(agentSession.disabledMessage, '当前账号已暂停使用，请联系管理员');
});

test('6.8-3 account disabled clears the profile session and shows the restricted card', async t => {
  const draft = order();
  const { pageFor, handle } = setup(t, draft);
  const profile = pageFor('profile');
  await profile.login();
  assert.equal(profile.data.signedIn, true);

  handle(request => {
    if (request.path === '/workspace') {
      request.ok({ error: 'account_disabled', message: '当前账号已暂停使用，请联系管理员' }, 403);
      return true;
    }
    return false;
  });
  await profile.onShow();
  assert.equal(agentSession.token, '');
  assert.equal(profile.data.signedIn, false);
  assert.equal(profile.data.authGate, 'disabled');
  assert.equal(profile.data.disabledMessage, '当前账号已暂停使用，请联系管理员');
  assert.equal(profile.data.partyCount, 0, '熟客等敏感数据已清空');
  assert.equal(profile.data.aliases.length, 0);
  assert.equal(agentSession.disabledMessage, '当前账号已暂停使用，请联系管理员');

  const wxml = fs.readFileSync(require.resolve('../code/dist/pages/profile/index.wxml'), 'utf8');
  for (const token of ['当前账号已暂停使用', '{{disabledMessage ||', '重新登录']) {
    assert.ok(wxml.includes(token), `我的页停用卡缺少 ${token}`);
  }
});

test('6.8-3 account disabled clears the history session and sensitive rows', async t => {
  const draft = order();
  const { page, pageFor, handle } = setup(t, draft);
  await page.login();
  const history = pageFor('history');
  handle(request => {
    if (request.path === '/trips') {
      request.ok({ error: 'account_disabled', message: '当前账号已暂停使用，请联系管理员' }, 403);
      return true;
    }
    return false;
  });
  await history.onShow();
  assert.equal(agentSession.token, '', '历史页收到停用立刻清会话');
  assert.equal(history.data.signedIn, false);
  assert.deepEqual(history.data.trips, []);
  assert.equal(history.data.formal, null);
  assert.equal(history.data.error, '当前账号已暂停使用，请联系管理员');
  assert.equal(agentSession.disabledMessage, '当前账号已暂停使用，请联系管理员');
});

test('6.8-3 gate pages keep the cold-chain v2.0 high-contrast native baseline', () => {
  const read = file => fs.readFileSync(require.resolve(`../code/dist/${file}`), 'utf8');
  const pairs = [['agent', read('pages/agent/index.wxml'), read('pages/agent/index.wxss')],
    ['profile', read('pages/profile/index.wxml'), read('pages/profile/index.wxss')]];
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{FE0F}]/u;
  for (const [name, wxml, wxss] of pairs) {
    for (const banned of ['size="mini"', 'cover-view']) {
      assert.equal(wxml.includes(banned), false, `${name} 不得出现 ${banned}`);
    }
    assert.equal(emoji.test(wxml), false, `${name} 不得出现 Emoji`);
    for (const token of ['首次使用请输入开通码', '确认开通', '返回微信登录',
      '当前账号已暂停使用', '重新登录', 'bindtap="submitActivation"', 'bindtap="cancelActivation"']) {
      assert.ok(wxml.includes(token), `${name} 缺少门禁结构 ${token}`);
    }
    for (const token of ['.gate-card', '.gate-input', '.gate-error', '.gate-card-disabled',
      'height: 96rpx', 'height: 88rpx', 'var(--primary)']) {
      assert.ok(wxss.includes(token), `${name} 缺少门禁样式 ${token}`);
    }
  }
});

test('UX & Motion: order sheet guards unsaved prices, voice pad explains tap flow, unlink scrolls, profile confirms logout', async t => {
  const read = file => fs.readFileSync(require.resolve(`../code/dist/${file}`), 'utf8');
  const appWxss = read('app.wxss');
  for (const token of ['--ease-out:', '--ease-spring:', '--dur-press:', '--dur-sheet:',
    'prefers-reduced-motion: reduce', '.skeleton-card']) {
    assert.ok(appWxss.includes(token), `app.wxss 缺少统一动效或骨架令牌 ${token}`);
  }
  const agentWxml = read('pages/agent/index.wxml');
  for (const token of ['scroll-with-animation="{{true}}"', 'confirm-type="done"', 'voice-pad-text',
    'orderSheetMounted', 'customerSheetRender', 'requestCloseOrderSheet', '点一下开始说', '点一下结束']) {
    assert.ok(agentWxml.includes(token), `助手页缺少体验/动效结构 ${token}`);
  }
  const deliveryWxml = read('pages/trip-delivery/index.wxml');
  assert.ok(deliveryWxml.includes("disabled=\"{{busy || fieldEdit.receivedQuantity === '0'}}\""), '数量为 0 时减号禁用');
  assert.ok(deliveryWxml.includes('sheet-lock-hint'), '编辑行时提示先保存这一行再锁账');

  const draft = order();
  draft.customers[0].items[0].price = null;
  draft.customers[0].partyId = 'p-wang';
  const { page, pageFor, navigation, event, handle, setTurns } = setup(t, draft);
  const linkTurn = { id: 'turn-link', text: '老王水饺2箱', materialIds: [], revision: draft.revision, status: 'completed',
    events: [event('customer_links', { links: [{ draftCustomerId: draft.customers[0].id, customerId: 'p-wang', spoken: '老王', canonicalName: '王记餐饮', merged: false }] }),
      event('end', { status: 'completed', text: '已记上', revision: draft.revision })] };
  setTurns([linkTurn]);
  handle(request => {
    if (request.path === '/agent/customer-choice') {
      draft.customers[0].partyId = undefined;
      draft.revision += 1;
      request.ok({ revision: draft.revision, remembered: null });
      return true;
    }
    return false;
  });

  await page.onShow();
  await page.login();

  // 1. Order sheet anti-loss guard when dirty + interruptible reopen
  page.openOrderSheet(tap({ tab: 'pending' }));
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.orderSheetMounted, true);
  page.editPriceDrawerPrice({ ...tap({ line: draft.customers[0].items[0].id }), detail: { value: '88' } });
  assert.equal(page.data.priceDrawerDirty, true);
  let modal = null;
  wx.showModal = spec => { modal = spec; };
  page.requestCloseOrderSheet();
  assert.ok(modal, '有未保存单价时关闭抽屉应弹二次确认');
  assert.ok(modal.confirmText.length <= 4, 'confirmText 须 ≤ 4 字');
  modal.success({ confirm: false });
  assert.equal(page.data.orderSheetOpen, true, '取消放弃后抽屉保持打开');
  assert.equal(page.data.priceDrawerRows[0].price, '88', '已填单价未丢失');
  modal.success({ confirm: true });
  assert.equal(page.data.orderSheetOpen, false, '确认放弃后抽屉关闭');
  // Interruptible reopen during exit transition
  page.openOrderSheet(tap({ tab: 'all' }));
  assert.equal(page.data.orderSheetOpen, true);
  assert.equal(page.data.orderSheetMounted, true);
  page.closeOrderSheet();

  // 2. Unlinking customer ("不是他") scrolls choice card into view
  await page.notHim(tap({ turn: linkTurn.id, customer: draft.customers[0].id }));
  assert.equal(page.data.scrollTo, 'latest', '点不是他后自动滚动露出选店卡');

  // 3. Profile stage card navigation + logout confirmation guard
  const profile = pageFor('profile');
  await profile.onShow();
  assert.equal(profile.data.loaded, true);
  profile.goCurrentStage();
  assert.equal(navigation.at(-1), '/pages/agent/index', '晚间录单中点阶段卡直达助手页');
  modal = null;
  wx.showModal = spec => { modal = spec; };
  profile.logout();
  assert.ok(modal, '真机环境下退出登录先弹确认防误碰');
  assert.ok(modal.confirmText.length <= 4, '退出确认按钮须 ≤ 4 字');
  assert.equal(profile.data.signedIn, true, '未点确认前保持登录');
  modal.success({ confirm: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(profile.data.signedIn, false, '确认后正常退出登录');
});
