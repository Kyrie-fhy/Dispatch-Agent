const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spokenNumbers, hasSpokenNumber } = require('../code/dist/core/spoken-numbers.js');

test('A1 normalizes exact spoken quantities and prices without inventing a value for approximate quantities', () => {
  const values = text => spokenNumbers(text).map(number => number.value);
  assert.deepEqual(values('两箱、仨袋、二十三袋、一百零三袋、一百二袋、１２箱'), [2, 3, 23, 103, 120, 12]);
  assert.deepEqual(values('八块五、八十二块五毛、八块五分、十九点六、12.35元'), [8.5, 82.5, 8.05, 19.6, 12.35]);
  assert.deepEqual(values('十几袋、几十几箱'), [null, null]);
  assert.equal(hasSpokenNumber('还有十几袋', '10'), false);
  assert.equal(hasSpokenNumber('十二箱', '2'), false);
  assert.equal(hasSpokenNumber('八十二一箱', '82'), true);
});
