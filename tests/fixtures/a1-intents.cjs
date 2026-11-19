const assert = require('node:assert/strict');
const { cases, revisionCases, add } = require('./a1-dialogues.cjs');

const expectedByCase = {
  standard: ['draft', 'draft', 'preview'],
  multiple: ['draft'],
  append: ['draft', 'draft', 'draft'],
  'same-name': ['draft', 'draft', 'preview'],
  'no-price': ['draft', 'preview'],
  injection: ['other'],
  'provider-failure': ['draft'],
  mixed: [null, 'draft', 'preview'],
};

function flags(classes, answering = false) {
  return { draft: classes.includes('draft'), preview: classes.includes('preview'), query: classes.includes('query'), answering };
}

function context(rows, questions, lastSummary) {
  const customers = new Map();
  for (const { customer, ...item } of rows) {
    if (!customers.has(customer)) customers.set(customer, { customer, items: [] });
    customers.get(customer).items.push(item);
  }
  return { customers: [...customers.values()], questions, lastSummary };
}

function originalSamples() {
  return cases.flatMap(({ id, steps }) => {
    assert.equal(steps.length, expectedByCase[id].length, id);
    const rows = id === 'injection' ? [add('老王', '水饺', '2', { price: '82' })] : [];
    let questions = [];
    let lastSummary = '';
    return steps.flatMap(([text, ...commands], index) => {
      const label = expectedByCase[id][index];
      assert.equal(Boolean(text), Boolean(label), id);
      const sample = { id: `${id}/${index + 1}`, group: 'original', text, expected: label ? flags([label], questions.length > 0 && label === 'draft') : null,
        context: context(rows, questions, lastSummary) };
      questions = [];
      for (const command of commands) {
        if (command === 'image') rows.push(add('老王', '水饺'), add('小李', '水饺', '3'));
        if (command?.[0] === 'ask_user') questions = command[1].questions;
        if (command?.[0] === 'edit_draft') {
          for (const op of command[1].operations) {
            if (op.action === 'add') rows.push(op);
            if (op.action === 'fill' || op.action === 'update') rows[op.target - 1] = { ...rows[op.target - 1], ...op };
          }
        }
      }
      lastSummary = questions.length ? '有草稿问题待确认。' : rows.length ? '本趟草稿已整理。' : '草稿没有变化。';
      return text ? [sample] : [];
    });
  });
}

function heldoutSamples(scenarios) {
  return scenarios.flatMap(({ id, turns }) => {
    const rows = new Map();
    let lastSummary = '';
    return turns.map(({ text, intents, context: pending, draft = [], ask }, index) => {
      const expected = flags(intents.map(kind => ['add', 'edit', 'answer'].includes(kind) ? 'draft' : kind), Boolean(pending && intents.includes('answer')));
      const sample = { id: `${id}/${index + 1}`, group: 'heldout', text, expected,
        context: context([...rows.values()], pending ? [{ customer: '', text: pending, options: [] }] : [], lastSummary) };
      for (const line of draft) {
        const key = JSON.stringify([line.customer, line.product]);
        rows.set(key, { ...rows.get(key), ...line });
      }
      lastSummary = ask ? '有草稿问题待确认。' : draft.length ? '本趟草稿已整理。' : '草稿没有变化。';
      return sample;
    });
  });
}
function questionSamples() {
  const { id, steps } = revisionCases.find(scenario => scenario.id === 'new-order-with-pending-question');
  return [{
    id: `${id}/2`, group: 'regression', text: steps[1][0], expected: flags(['draft']),
    context: context([], steps[0][1][1].questions, '有草稿问题待确认。'),
  }];
}
module.exports = { originalSamples, heldoutSamples, questionSamples };
