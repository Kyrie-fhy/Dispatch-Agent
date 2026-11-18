const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyTrip, previewTrip } = require('../code/dist/core/trips');
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
  global.wx = {
    login: ({ success }) => success({ code: 'example-login' }),
    request: request => {
      const url = new URL(request.url);
      const path = url.pathname.slice(3);
      const entry = { path, query: url.searchParams, data: request.data, method: request.method,
        ok: (data, statusCode = 200) => request.success({ statusCode, data }),
        fail: () => request.fail({ errMsg: 'offline' }) };
      requests.push(entry);
      if (path === '/session/wechat') return entry.ok({ token }, 201);
      assert.equal(request.header.Authorization, `Bearer ${token}`);
      if (path === '/session') return entry.ok(null, 204);
      if (path === '/agent/card-actions') return entry.ok({ recorded: true });
      if (onRequest?.(entry)) return;
      if (path === '/agent/conversation') return entry.ok({ draft: structuredClone(draft), draftConfirmed: confirmed, turns: structuredClone(turns) });
      if (path === '/workspace') return entry.ok({ draft: structuredClone(draft), parties: [], draftConfirmed: confirmed, currentTrip: null });
      assert.fail(`Unhandled request ${entry.method} ${path}`);
    },
    navigateTo: ({ url }) => navigation.push(url),
  };
  const page = pageFor('agent');
  t.after(() => { page.onHide(); agentSession.token = ''; agentSession.unsaved = null; });
  return { page, pageFor, requests, navigation, event, card,
    setDraft(value) { draft = value; }, setConfirmed(value) { confirmed = value; },
    setTurns(value) { turns = value; }, handle(fn) { onRequest = fn; },
  };
}

test('A1 chat restores original input on failed submission, then polls progress and submits a quick answer', async t => {
  const draft = order();
  const { page, requests, event, handle, setTurns } = setup(t, draft);
  await page.onShow();
  await page.login();
  assert.equal(page.data.signedIn, true);
  const progress = event('progress', { text: '核对这趟草稿', step: 1, done: true });
  const question = event('questions', { questions: [{ customer: '老王', text: '改成还是追加？', options: ['追加 3 箱'] }] });
  const end = event('end', { text: '待确认', revision: 1, status: 'completed' });
  const first = { id: 'turn-1', text: '再要三箱', materialIds: [], revision: 1, status: 'completed', events: [progress, question, end] };
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
      if (polls === 1) request.ok({ status: 'running', events: [progress] });
      else {
        setTurns([first]);
        request.ok({ status: 'completed', events: [question, end] });
      }
      return true;
    }
  });
  page.editText({ detail: { value: first.text } });
  await page.send();
  assert.equal(page.data.text, first.text);
  assert.match(page.data.error, /无法连接/);
  await page.send();
  assert.equal(page.data.text, '');
  assert.equal(page.data.polling, true);
  await page.poll();
  assert.equal(page.data.turns[0].progress[0].done, true);
  await page.poll();
  assert.equal(page.data.polling, false);
  assert.deepEqual(page.data.turns[0].questions[0].options, ['追加 3 箱']);
  await page.answer(tap({ option: '追加 3 箱' }));
  const sent = requests.filter(request => request.path === '/agent/turns');
  assert.equal(sent[0].data.requestId, sent[1].data.requestId);
  assert.equal(sent[2].data.text, '追加 3 箱');
  assert.ok(requests.some(request => request.path === '/agent/card-actions' && request.data.action === 'answer'));
});

test('A1 restores failed messages, renders revision-safe undo and only confirms through the existing trip API', async t => {
  const base = order();
  const { page, requests, card, event, handle, setDraft, setConfirmed, setTurns } = setup(t, base);
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
    events: [event('preview', { preview }), event('end', { status: 'completed', text: '请确认', revision: preview.revision })] });
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
        setConfirmed(true);
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
  await page.refresh();
  assert.equal(page.data.turns[0].preview.totalLabel, '整趟订单金额 ¥164.00');
  assert.equal(page.data.turns[0].preview.customers[0].items[0].productLabel, '水饺');
  assert.equal(requests.filter(r => r.path === '/trips/confirm').length, 0);
  await page.confirm(tap({ id: firstPreview.previewId }));
  assert.match(page.data.error, /重新预览/);
  assert.equal(page.data.confirmed, false);
  await page.send();
  await page.poll();
  assert.equal(retried, true);
  await page.confirm(tap({ id: secondPreview.previewId }));
  assert.equal(page.data.confirmed, true);
  page.showPickingList();
  assert.equal(page.data.showPicking, true);
  assert.equal(page.data.picking[0].quantity, 2);
  assert.ok(requests.filter(r => r.path === '/trips/confirm').every(r => r.data.requestId));
});

test('A1 manual form uses the same session and detects an unsaved edit after chat updates the draft', async t => {
  const base = order();
  const { page, pageFor, navigation, requests, setDraft } = setup(t, base);
  await page.onShow();
  await page.login();
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
