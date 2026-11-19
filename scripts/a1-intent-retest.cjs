const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { configuredIntentModel, intentPrompt, combinedIntentPrompt } = require('../code/server-dist/server/agent/intent.js');
const { originalSamples, heldoutSamples } = require('../tests/fixtures/a1-intents.cjs');

const label = ({ draft, preview, query }) =>
  [draft && 'draft', query && 'query', preview && 'preview'].filter(Boolean).join('+') || 'other';

function summarize(traces, threshold) {
  const times = traces.map(call => call.elapsedMs).sort((left, right) => left - right);
  const correct = traces.filter(call => call.expected === call.actual).length;
  const accuracy = correct / traces.length;
  const medianMs = (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2;
  const confusion = {};
  for (const { expected, actual } of traces) {
    confusion[expected] ??= {};
    confusion[expected][actual] = (confusion[expected][actual] ?? 0) + 1;
  }
  return { calls: traces.length, correct, accuracy, medianMs, minMs: times[0], maxMs: times.at(-1), confusion,
    formatFailures: traces.filter(call => call.actual === 'invalid_output').length,
    transportFailures: traces.filter(call => call.actual === 'transport_error').length,
    intentErrors: traces.filter(call => call.outcome === 'stop' && call.expected !== call.actual).length,
    passed: accuracy >= 0.9 && medianMs <= threshold };
}

async function main() {
  const modes = { A: configuredIntentModel(process.env, 'A'), B: configuredIntentModel(process.env, 'B') };
  assert.ok(modes.A && modes.B, '请在运行环境配置 DISPATCH_TEXT_MODEL_KEY');
  const file = process.argv[2] ?? resolve(__dirname, '../tests/fixtures/a1-heldout.local.json');
  const original = originalSamples();
  const heldout = heldoutSamples(JSON.parse(readFileSync(file, 'utf8')));
  assert.equal(original.length, 16);
  assert.ok(heldout.length >= 15);
  const samples = [...original, ...heldout];
  for (const { text, id } of samples) {
    assert.ok(!intentPrompt.includes(text) && !combinedIntentPrompt.includes(text), `提示词包含用例原文：${id}`);
  }
  const results = { A: [], B: [] };
  for (let sample = 1; sample <= 3; sample++) {
    for (const { id, group, text, expected, context } of samples) {
      for (const [mode, model] of Object.entries(modes)) {
        let trace;
        let actual;
        try {
          actual = label(await model(text, context, AbortSignal.timeout(18_000), value => { trace = value; }));
        } catch {
          actual = trace?.outcome === 'invalid_output' ? 'invalid_output' : 'transport_error';
        }
        const result = { mode, id, group, text, sample, expected: label(expected), actual, ...trace };
        results[mode].push(result);
        console.log(JSON.stringify(result));
      }
    }
  }
  const A = summarize(results.A, 2000);
  const B = summarize(results.B, 3000);
  console.log(JSON.stringify({ A, B, selected: A.passed ? 'A' : B.passed ? 'B' : null }));
  process.exitCode = A.passed || B.passed ? 0 : 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 2; });
