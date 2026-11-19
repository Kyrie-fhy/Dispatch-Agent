const test = require('node:test');
const assert = require('node:assert/strict');
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
      if (path === '/session') return entry.ok(null, 204);
      if (path === '/agent/card-actions') return entry.ok({ recorded: true });
      if (onRequest?.(entry)) return;
      if (path === '/agent/conversation') return entry.ok({ draft: structuredClone(draft), draftConfirmed: confirmed, confirmedPreviewId, turns: structuredClone(turns), delivery: structuredClone(delivery) });
      if (path === '/workspace') return entry.ok({ draft: structuredClone(draft), parties: [], draftConfirmed: confirmed, currentTrip: null });
      assert.fail(`Unhandled request ${entry.method} ${path}`);
    },
    navigateTo: ({ url }) => navigation.push(url),
    switchTab: ({ url }) => navigation.push(url),
  };
  const page = pageFor('agent');
  t.after(() => { page.onHide(); agentSession.token = ''; agentSession.unsaved = null; });
  return { page, pageFor, requests, navigation, event, card,
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
  assert.match(page.data.deliveryStrip.label, /0\/1/);
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
  assert.match(page.data.deliveryStrip.label, /1\/1/);
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
  const { page, requests, navigation, card, event, handle, setDraft, setConfirmed, setTurns } = setup(t, base);
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
  await page.confirm(tap({ id: secondPreview.previewId }));
  assert.equal(page.data.confirmed, true);
  page.showPickingList();
  assert.equal(navigation.at(-1), '/pages/trip-picking/index');
  assert.equal(page.data.turns.at(-1).checklist[0].state, 'done');
  page.onHide();
  await page.onShow();
  assert.equal(page.data.turns.at(-1).checklist[0].state, 'done');
  assert.equal(page.data.turns.at(-1).issued, true);
  assert.ok(requests.filter(r => r.path === '/trips/confirm').every(r => r.data.requestId));
});

test('A1 manual form uses the same session and detects an unsaved edit after chat updates the draft', async t => {
  const base = order();
  const { page, pageFor, navigation, requests, setDraft } = setup(t, base);
  await page.onShow();
  await page.login();
  assert.match(page.data.draftStrip.label, /1 家 1 行/);
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
  modal.success({ confirm: false });
  assert.ok(!requests.some(r => r.path.endsWith('next-draft')));
  await history.onShow();
  assert.equal(history.data.trips[0].current, true);
  await history.loadMore();
  assert.equal(history.data.trips.length, 2);
  assert.match(history.data.trips[1].total, /待补价/);
  await history.openTrip(tap({ id: old.id }));
  assert.equal(history.data.formal.id, old.id);
  assert.equal(history.data.formal.deliveryRows[0].lines[0].originalQuantity, '2');
  assert.equal(history.data.formal.deliveryRows[0].lines[0].quantity, '2');
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
