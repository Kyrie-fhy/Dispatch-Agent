const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const key = process.env.DISPATCH_TEXT_MODEL_KEY?.trim();
const model = process.env.DISPATCH_AGENT_MODEL?.trim() || 'deepseek-flash';
const tools = [
  {
    type: 'function',
    function: {
      name: 'add_line',
      description: '新增配送草稿行，单价未给时留空。',
      parameters: {
        type: 'object',
        properties: {
          customer: { type: 'string' }, product: { type: 'string' }, brand: { type: 'string' },
          specification: { type: 'string' }, quantity: { type: 'integer' }, unit: { type: 'string' },
        },
        required: ['customer', 'product', 'brand', 'specification', 'quantity', 'unit'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill_price',
      description: '根据最新回复给上下文中唯一的明细补单价，单价用元表示。',
      parameters: {
        type: 'object',
        properties: { target: { type: 'integer' }, price: { type: 'number' } },
        required: ['target', 'price'],
      },
    },
  },
];

async function call(messages, sample, step) {
  const started = performance.now();
  const trace = { sample, step, model, outcome: 'network_error' };
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(18_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, tools, temperature: 0, max_tokens: 350, thinking: { type: 'disabled' }, messages,
      }),
    });
    trace.outcome = `HTTP_${response.status}`;
    if (!response.ok) throw new Error(trace.outcome);
    trace.outcome = 'invalid_response';
    const payload = await response.json();
    trace.requestId = payload.id;
    trace.model = payload.model || model;
    trace.inputTokens = payload.usage?.prompt_tokens;
    trace.outputTokens = payload.usage?.completion_tokens;
    const choice = payload.choices?.[0];
    assert.ok(choice?.message);
    trace.outcome = choice.finish_reason;
    return choice.message;
  } finally {
    trace.elapsedMs = Math.round(performance.now() - started);
    console.log(JSON.stringify(trace));
    calls.push(trace);
  }
}

const calls = [];

function appendToolResult(messages, assistant, name, expected, result) {
  assert.equal(assistant.tool_calls?.length, 1);
  const call = assistant.tool_calls[0];
  assert.equal(call.type, 'function');
  assert.equal(call.function.name, name);
  assert.ok(call.id);
  assert.deepEqual(JSON.parse(call.function.arguments), expected);
  messages.push(assistant, { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
}

async function run(sample) {
  const order = { customer: '老王', product: '水饺', brand: '安井', specification: '500g', quantity: 2, unit: '箱' };
  const messages = [
    { role: 'system', content: '你负责冻品配送草稿。新报单调用 add_line，品牌与货品分开，规格保持原样。用户明确要求给已有明细补单价时调用 fill_price。从工具返回中取明细编号。每次收到工具结果后，只简短说明已经保存。不能自行填价或计算金额。' },
    { role: 'user', content: '老王要两箱安井水饺500g' },
  ];
  appendToolResult(messages, await call(messages, sample, 'add'), 'add_line', order, { ...order, target: 27, price: null });
  const added = await call(messages, sample, 'after_add');
  assert.ok(added.content?.trim() && !added.tool_calls?.length);
  messages.push(added, { role: 'user', content: '补价 82' });
  appendToolResult(messages, await call(messages, sample, 'fill'), 'fill_price', { target: 27, price: 82 }, { target: 27, price: 82 });
  const filled = await call(messages, sample, 'after_fill');
  assert.ok(filled.content?.trim() && !filled.tool_calls?.length);
}

async function main() {
  if (!key) {
    console.error('请在运行环境配置 DISPATCH_TEXT_MODEL_KEY。');
    process.exitCode = 2;
    return;
  }
  let passed = 0;
  for (let sample = 1; sample <= 5; sample++) {
    try {
      await run(sample);
      passed++;
      console.log(JSON.stringify({ sample, passed: true }));
    } catch (error) {
      console.log(JSON.stringify({ sample, passed: false, error: error.code ?? error.name }));
    }
  }
  const times = calls.map(call => call.elapsedMs).sort((left, right) => left - right);
  const medianMs = (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2;
  const sum = field => calls.reduce((total, call) => total + (call[field] ?? 0), 0);
  const gatePassed = passed >= 4 && medianMs <= 8000;
  console.log(JSON.stringify({ passed, samples: 5, calls: calls.length, medianMs, inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'), gatePassed }));
  process.exitCode = gatePassed ? 0 : 1;
}

void main();
