const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const { initial, supplement, ambiguous, remaining } = require('./fixtures/s6-text-cases.cjs');
const { cases, revisionCases } = require('./fixtures/a1-dialogues.cjs');
const { cases: deliveryCases } = require('./fixtures/a2-delivery-cases.cjs');
const { cases: memoryCases } = require('./fixtures/a3-memory-cases.cjs');

test('A1, A2 and A3 model prompts contain no complete Harness or local holdout messages', () => {
  const file = resolve(__dirname, 'fixtures/a1-heldout.local.json');
  const heldout = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const messages = [...cases, ...revisionCases].flatMap(scenario => scenario.steps.filter(([, action]) => action !== 'direct').map(([text]) => text))
    .concat(initial, supplement, ambiguous, remaining)
    .concat(deliveryCases.flatMap(scenario => scenario.turns.map(turn => turn.text)))
    .concat(memoryCases.flatMap(scenario => scenario.turns.map(turn => turn.text)))
    .concat(heldout.flatMap(scenario => scenario.turns.map(turn => turn.text))).filter(Boolean);
  for (const filename of ['code/server/agent/intent.ts', 'code/server/agent/model.ts', 'code/server/agent/delivery-model.ts', 'code/server/text-model.ts']) {
    const source = ts.createSourceFile(filename, readFileSync(resolve(__dirname, '..', filename), 'utf8'), ts.ScriptTarget.Latest);
    function inspect(node) {
      if (ts.isVariableDeclaration(node) && /prompt$/i.test(node.name.getText(source)) &&
          node.initializer && (ts.isStringLiteralLike(node.initializer) || ts.isTemplateExpression(node.initializer))) {
        for (const text of messages) assert.ok(!node.initializer.getText(source).includes(text),
          `${node.name.getText(source)} 包含题目原文：${text}`);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
});
