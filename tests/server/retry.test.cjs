const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { configuredIntentModel } = require('../../code/server-dist/server/agent/intent');
const { configuredAgentModel } = require('../../code/server-dist/server/agent/model');
const { configuredDeliveryModel } = require('../../code/server-dist/server/agent/delivery-model');
const { configuredImageModel, configuredTextModel } = require('../../code/server-dist/server/text-model');
const { configuredSpeechModel } = require('../../code/server-dist/server/voice');
const { HttpError } = require('../../code/server-dist/server/http-error');
const { runWithSingleRetry, RetryableError, waitWithAbort } = require('../../code/server-dist/server/retry');
const { adminDataScript } = require('../../code/server-dist/server/admin/page-data');

const env = { DISPATCH_TEXT_MODEL_KEY: 'fixture-key' };
const fastRetry = { backoffMs: () => 1 };

test('7.0-2 scenario 1: all 5 pure-inference adapters recover from a single 502 and emit attempt 1 & 2 traces', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  // 1. configuredIntentModel
  {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({
        id: 'req-intent-2', model: 'deepseek-flash',
        usage: { prompt_tokens: 40, completion_tokens: 12 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ draft: true, preview: false, query: false, answering: false }) } }],
      }));
    };
    const traces = [];
    const model = configuredIntentModel(env, 'A', fastRetry);
    const result = await model('老王两箱水饺', { customers: [], questions: [], lastSummary: '' }, new AbortController().signal, trace => traces.push(trace));
    assert.deepEqual(result, { draft: true, preview: false, query: false, answering: false });
    assert.equal(calls, 2);
    assert.deepEqual(traces.map(item => [item.attempt, item.outcome]), [[1, 'provider_502'], [2, 'stop']]);
    assert.equal(traces[1].inputTokens, 40);
    assert.equal(traces[1].outputTokens, 12);
  }

  // 2. configuredAgentModel
  {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({
        id: 'req-agent-2', model: 'deepseek-flash',
        usage: { prompt_tokens: 100, completion_tokens: 25 },
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{
          id: 'tc-1', type: 'function', function: { name: 'ask_user', arguments: '{"questions":[]}' },
        }] } }],
      }));
    };
    const traces = [];
    const model = configuredAgentModel(env, fastRetry);
    const reply = await model([{ role: 'user', content: 'hi' }], new AbortController().signal, trace => traces.push(trace), ['ask_user']);
    assert.equal(reply.tool_calls.length, 1);
    assert.equal(calls, 2);
    assert.deepEqual(traces.map(item => [item.attempt, item.outcome]), [[1, 'provider_502'], [2, 'tool_calls']]);
  }

  // 3. configuredDeliveryModel
  {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({
        id: 'req-delivery-2', model: 'deepseek-flash',
        usage: { prompt_tokens: 55, completion_tokens: 10 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ adjust: true, query: false, answering: false, lookup: 'none', shop: '' }) } }],
      }));
    };
    const traces = [];
    const model = configuredDeliveryModel(env, fastRetry);
    const out = await model('intent', { text: '西桥少收一箱' }, new AbortController().signal, trace => traces.push(trace));
    assert.equal(out.adjust, true);
    assert.equal(calls, 2);
    assert.deepEqual(traces.map(item => [item.attempt, item.outcome]), [[1, 'provider_502'], [2, 'received_json']]);
  }

  // 4. configuredImageModel & configuredTextModel
  {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({
        id: 'req-img-2', model: 'deepseek-flash',
        usage: { prompt_tokens: 200, completion_tokens: 30 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ operations: [], question: '' }) } }],
      }));
    };
    const traces = [];
    const imageModel = configuredImageModel(env, undefined, fastRetry);
    const imgOut = await imageModel({ content: Buffer.from('img'), mime: 'image/png' }, {
      signal: new AbortController().signal, trace: trace => traces.push(trace),
    });
    assert.deepEqual(imgOut, { operations: [], question: '' });
    assert.equal(calls, 2);
    assert.deepEqual(traces.map(item => [item.attempt, item.outcome]), [[1, 'provider_502'], [2, 'received_json']]);

    calls = 0;
    const textTraces = [];
    const textModel = configuredTextModel(env, trace => textTraces.push(trace), fastRetry);
    const textOut = await textModel({ text: '老王两箱水饺', current: [] });
    assert.deepEqual(textOut, { operations: [], question: '' });
    assert.equal(calls, 2);
    assert.deepEqual(textTraces.map(item => [item.attempt, item.outcome]), [[1, 'provider_502'], [2, 'received_json']]);
  }

  // 5. configuredSpeechModel (fresh FormData per attempt + 502 recovery)
  {
    let calls = 0;
    const wave = Buffer.from('RIFFtestWAVEdata');
    global.fetch = async (_url, options) => {
      calls++;
      const file = options.body.get('file');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), wave);
      if (calls === 1) return new Response('bad gateway', { status: 502 });
      return new Response(JSON.stringify({ text: '老王要两箱水饺' }));
    };
    const speech = configuredSpeechModel(env, fastRetry);
    const out = await speech(wave);
    assert.deepEqual(out, { text: '老王要两箱水饺' });
    assert.equal(calls, 2);
  }
});

test('7.0-2 scenario 2: malformed/truncated JSON on attempt 1 retries and preserves both attempts token usage', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({
        id: 'bad-json-1', model: 'deepseek-flash',
        usage: { prompt_tokens: 120, completion_tokens: 60 },
        choices: [{ finish_reason: 'stop', message: { content: '{"draft": true, "preview":' } }],
      }));
    }
    return new Response(JSON.stringify({
      id: 'good-json-2', model: 'deepseek-flash',
      usage: { prompt_tokens: 120, completion_tokens: 18 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ draft: true, preview: false, query: false, answering: false }) } }],
    }));
  };
  const traces = [];
  const model = configuredIntentModel(env, 'A', fastRetry);
  const result = await model('老王两箱水饺', { customers: [], questions: [], lastSummary: '' }, new AbortController().signal, trace => traces.push(trace));
  assert.equal(result.draft, true);
  assert.equal(calls, 2);
  assert.equal(traces.length, 2);
  assert.deepEqual(traces[0], { ...traces[0], attempt: 1, outcome: 'invalid_output', inputTokens: 120, outputTokens: 60 });
  assert.deepEqual(traces[1], { ...traces[1], attempt: 2, outcome: 'stop', inputTokens: 120, outputTokens: 18 });
});

test('7.0-2 scenario 3: non-retryable 400/401 hard errors fail immediately in 1 call with original HttpError', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  for (const status of [400, 401]) {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return new Response('unauthorized', { status });
    };
    const traces = [];
    const model = configuredAgentModel(env, fastRetry);
    await assert.rejects(
      () => model([{ role: 'user', content: 'hi' }], new AbortController().signal, trace => traces.push(trace)),
      error => error instanceof HttpError && error.status === 502 && error.code === 'agent_model_failed',
    );
    assert.equal(calls, 1, `status ${status} must not retry`);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].attempt, 1);
    assert.equal(traces[0].outcome, `provider_${status}`);
  }
});

test('7.0-2 scenario 4: AbortSignal cancels backoff immediately and never issues a 2nd request', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  // 4a. Already aborted before attempt 1 fails -> no retry
  {
    let calls = 0;
    const controller = new AbortController();
    global.fetch = async () => {
      calls++;
      controller.abort(new Error('cancelled'));
      return new Response('server error', { status: 503 });
    };
    const model = configuredIntentModel(env, 'A', { backoffMs: () => 5_000 });
    const started = Date.now();
    await assert.rejects(
      () => model('hi', { customers: [], questions: [], lastSummary: '' }, controller.signal, () => {}),
      error => error instanceof HttpError && error.code === 'agent_intent_failed',
    );
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 500, 'must not wait for backoff when signal is aborted');
  }

  // 4b. Aborted during backoff sleep -> cancels immediately without calling attempt 2
  {
    let calls = 0;
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error('abort-during-backoff')), 25);
    await assert.rejects(
      () => runWithSingleRetry(async () => {
        calls++;
        throw new RetryableError('provider_503');
      }, { signal: controller.signal, backoffMs: () => 5_000 }),
      /abort-during-backoff/,
    );
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 500, 'backoff sleep must abort promptly');
  }

  // 4c. waitWithAbort rejects immediately when already aborted
  {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    await assert.rejects(() => waitWithAbort(5_000, controller.signal), /pre-aborted/);
  }
});

test('7.0-2 scenario 5: consecutive 503 failures attempt exactly twice and preserve original HttpError codes/messages', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const checks = [
    {
      name: 'intent',
      run: () => configuredIntentModel(env, 'A', fastRetry)('hi', { customers: [], questions: [], lastSummary: '' }, new AbortController().signal, () => {}),
      code: 'agent_intent_failed', message: '助手暂时没有看懂，请重试。',
    },
    {
      name: 'agent',
      run: () => configuredAgentModel(env, fastRetry)([{ role: 'user', content: 'hi' }], new AbortController().signal, () => {}),
      code: 'agent_model_failed', message: '助手暂时没有完成，请重试。',
    },
    {
      name: 'delivery',
      run: () => configuredDeliveryModel(env, fastRetry)('intent', { text: 'hi' }, new AbortController().signal, () => {}),
      code: 'delivery_model_failed', message: '现场助手没能处理这条消息，请重试或去送货单修改。',
    },
    {
      name: 'text',
      run: () => configuredTextModel(env, undefined, fastRetry)({ text: 'hi', current: [] }),
      code: 'text_model_failed', message: '文字整理暂未完成。原文仍在，可以重试或手动填写。',
    },
    {
      name: 'image',
      run: () => configuredImageModel(env, undefined, fastRetry)({ content: Buffer.from('x'), mime: 'image/png' }),
      code: 'image_model_failed', message: '图片识别暂未完成。图片已保留，可以重试或手动填写。',
    },
    {
      name: 'voice',
      run: () => configuredSpeechModel(env, fastRetry)(Buffer.from('RIFFtestWAVEdata')),
      code: 'voice_model_failed', message: '语音转写暂未完成，可用原录音重试。',
    },
  ];

  for (const check of checks) {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return new Response('unavailable', { status: 503 });
    };
    await assert.rejects(
      check.run,
      error => error instanceof HttpError && error.status === 502 && error.code === check.code && error.message === check.message,
      check.name,
    );
    assert.equal(calls, 2, `${check.name} must attempt exactly twice`);
  }
});

test('7.0-2 admin techDetailsHtml renders attempt badge only when attempt > 1', async () => {
  let renderedHtml = '';
  const viewEl = {
    get innerHTML() { return renderedHtml; },
    set innerHTML(html) { renderedHtml = String(html); },
    querySelectorAll() { return []; },
  };
  const turnsFixture = [{
    id: 'turn-retry', createdAt: '2026-11-27T05:00:00Z', elapsedMs: 1500,
    status: 'completed', undone: false, unpriced: false, question: false,
    userText: '重试单', assistantText: '已更新', materials: [],
    events: [
      { seq: 1, kind: 'model', payload: { model: 'deepseek-flash', promptVersion: 'a1-agent-v5', outcome: 'provider_502', attempt: 1, elapsedMs: 120, inputTokens: 0, outputTokens: 0 } },
      { seq: 2, kind: 'model', payload: { model: 'deepseek-flash', promptVersion: 'a1-agent-v5', outcome: 'tool_calls', attempt: 2, elapsedMs: 420, inputTokens: 100, outputTokens: 20 } },
    ],
  }];
  const esc = value => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const views = {};
  const sandbox = {
    window: {
      __dispatchAdmin: {
        state: { token: 'tok', section: 'quality', accountId: 'acc-1', qualityFilter: { filter: 'all' } },
        views, esc, centsToYuan: c => (c / 100).toFixed(2), moneyText: c => `¥${(c / 100).toFixed(2)}`,
        fmtDay: s => s, fmtTime: s => s, toast: () => {}, copyText: () => {}, openModal: () => {},
        currentAccount: () => ({ id: 'acc-1', remarkName: '老张' }),
        accountLabel: () => '老张',
        errorCard: m => `<div>${m}</div>`,
        loadMaterialUrl: () => Promise.resolve(''),
        loadAccounts: () => Promise.resolve(),
      },
    },
    document: {
      getElementById: id => id === 'view' ? viewEl : null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ turns: turnsFixture }) }),
    setTimeout, clearTimeout, URL, encodeURIComponent,
  };
  vm.runInNewContext(adminDataScript, sandbox);
  views.quality.mount();
  await new Promise(resolveWait => setTimeout(resolveWait, 30));
  assert.ok(renderedHtml.includes('· 第 2 次尝试'), 'attempt > 1 应显示第 2 次尝试');
  assert.equal(renderedHtml.includes('第 1 次尝试'), false, 'attempt === 1 不应多余显示第 1 次尝试');
});
