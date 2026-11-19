const assert = require('node:assert/strict');
const test = require('node:test');
const {
  collectHistoricalSales, lookupHistoricalPrice, mergeDraftCustomers, normalizeMemoryText, resolveCustomerMention,
  suggestDraftCustomerMentions, suggestDraftPrices,
} = require('../code/dist/core/memory');

const product = { productName: '冷冻 水饺', brand: '安井', spec: '500g', unit: '箱' };
const issuedAt = '2026-11-19T00:00:00.000Z';
const oldAt = '2026-11-18T00:00:00.000Z';
const item = (id, unitPriceCents, changes = {}) => ({
  id, product: product.productName, brand: product.brand, specification: product.spec,
  unit: product.unit, unitPriceCents, quantity: '2', ...changes,
});
const sheet = (tripId, items, changes = {}) => ({
  tripId, sheetId: 'sheet-1', customer: { id: 'sheet-1', items }, customerId: 'customer-a',
  issuedAt, statuses: {}, edits: {}, reviewed: false, ...changes,
});
const lookup = (sheets, query = product, customerId = 'customer-a') =>
  lookupHistoricalPrice(collectHistoricalSales(sheets), customerId, query);

test('matching folds spaces, widths and case and requires the original pricing unit', () => {
  assert.equal(normalizeMemoryText(null), '');
  assert.equal(normalizeMemoryText(undefined), '');
  assert.equal(normalizeMemoryText('　 ＷHite\n\t Ｐｅｐｐｅｒ　'), 'white pepper');
  const history = [sheet('new', [item('case', 7800, {
    product: '冷冻\t水饺', specification: '５００Ｇ', unit: ' 箱 ',
  }), item('bag', 900, { unit: '袋' })])];
  const result = lookup(history, { ...product, spec: ' 500G ' });
  assert.deepEqual(result, {
    status: 'exact_match', unitPriceCents: 7800, brand: '安井', spec: '５００Ｇ', unit: ' 箱 ',
    tripId: 'new', sheetId: 'sheet-1', issuedAt, previousDistinctPrice: null,
  });
  assert.equal(lookup(history, { ...product, unit: '袋' }).unitPriceCents, 900);
  for (const query of [{ unit: '件' }, { unit: ' ' }, { productName: null }, { brand: '其他' }, { spec: '1kg' }]) {
    assert.deepEqual(lookup(history, { ...product, ...query }), { status: 'no_match' });
  }
});

test('historical sales apply on-site overrides independently and drop invalid, returned and reviewed pending lines', () => {
  const history = [sheet('new', [
    item('repriced', 8000), item('fill', null), item('cleared', 8000), item('null', null),
    item('zero', 0), item('fraction', 1.3), item('unsafe', Number.MAX_SAFE_INTEGER + 1),
    item('returned', 8000), item('reviewed', 8000), item('reviewed-price-only', 8000),
    item('received', 8100), item('legacy-price', undefined, { price: ' 79.25 ' }),
  ], {
    reviewed: true,
    statuses: { reviewed: 'pending', 'reviewed-price-only': 'pending', received: 'pending' },
    edits: {
      repriced: { unitPriceCents: 7800 }, fill: { receivedQuantity: 1, unitPriceCents: 7600 },
      cleared: { unitPriceCents: null }, returned: { receivedQuantity: 0 },
      received: { receivedQuantity: 1 }, 'reviewed-price-only': { unitPriceCents: 7800 },
    },
  }), sheet('unlinked', [item('unlinked', 7900)], { customerId: null })];
  assert.deepEqual(collectHistoricalSales(history).map(row => [row.linePosition, row.unitPriceCents]), [
    [0, 7800], [1, 7600], [10, 8100], [11, 7925],
  ]);
  assert.equal(lookup([sheet('just-issued', [item('pending', 7800)], { statuses: { pending: 'pending' } })],
    product).unitPriceCents, 7800);
});

test('latest sale and closest distinct price follow full issue time with stable ties', () => {
  const history = [
    sheet('z', [item('last-ms', 8200)], { issuedAt: '2026-11-19T00:00:00.000001Z' }),
    sheet('a', [item('early-line', 7900), item('late-line', 7800)], { issuedAt: '2026-11-19T00:00:00.000002Z' }),
    sheet('before', [item('before', 8000)], { issuedAt: oldAt }),
    sheet('a', [item('other-sheet', 8800)], { issuedAt: '2026-11-19T00:00:00.000002Z', sheetId: 'sheet-2' }),
    sheet('same-price', [item('same-price', 7800)], { issuedAt: '2026-11-19T00:00:00.000002Z' }),
    sheet('other', [item('other', 5000)], { customerId: 'customer-b' }),
  ];
  const result = lookup(history);
  assert.equal(result.tripId, 'same-price');
  assert.equal(result.unitPriceCents, 7800);
  assert.deepEqual(result.previousDistinctPrice, {
    unitPriceCents: 7900, issuedAt: '2026-11-19T00:00:00.000002Z', tripId: 'a', sheetId: 'sheet-1',
  });
  assert.deepEqual(lookup([...history].reverse()), result);
  assert.equal(lookup([history[1]]).unitPriceCents, 7800);
  assert.equal(lookup([history[4], sheet('older', [item('older', 7800)], { issuedAt: oldAt })]).previousDistinctPrice, null);
});

test('missing variants distinguish exact empty, unique completions and multiple candidates', () => {
  const plain = item('plain', 8100, { brand: '', specification: '' });
  const branded = item('branded', 7800);
  const different = item('different', 7300, { brand: '三全' });
  const blank = { ...product, brand: null, spec: '　' };
  assert.equal(lookup([sheet('trip', [plain])], blank).status, 'exact_match');
  assert.equal(lookup([sheet('trip', [branded])], blank).status, 'unique_variant_match');
  assert.equal(lookup([sheet('trip', [branded])], { ...product, brand: null }).brand, '安井');
  const partiallyDefined = item('partial', 7700, { specification: '' });
  assert.equal(lookup([sheet('trip', [partiallyDefined])], { ...product, spec: '' }).status, 'exact_match');
  const history = [sheet('new', [plain, different]), sheet('old', [branded], { issuedAt: oldAt })];
  const ambiguous = lookup(history, blank);
  assert.equal(ambiguous.status, 'ambiguous_variants');
  assert.deepEqual(ambiguous.candidates.map(({ brand, spec, unit, unitPriceCents }) => [brand, spec, unit, unitPriceCents]),
    [['三全', '500g', '箱', 7300], ['', '', '箱', 8100], ['安井', '500g', '箱', 7800]]);
  const unique = lookup(history, { ...product, spec: '' });
  assert.equal(unique.status, 'unique_variant_match');
  assert.equal(unique.spec, '500g');
  assert.equal(lookup(history, { ...product, brand: '无记录', spec: '' }).status, 'no_match');
});

test('draft suggestions attach only to missing prices and never infer the customer from a name', () => {
  const line = (id, unitPriceCents, changes) => Object.freeze({ id, ...product, unitPriceCents, ...changes });
  const customers = [
    { id: 'draft-a', customerId: 'customer-a', items: [line('missing', null), line('explicit', 8000), line('new-sku', null, { unit: '袋' })] },
    { id: 'draft-b', items: [line('unresolved', null), line('zero-is-explicit', 0)] },
    { id: 'draft-c', customerId: null, items: [line('unlinked', null)] },
    { id: 'draft-d', customerId: 'customer-b', items: [line('other-price', null)] },
  ];
  const before = structuredClone(customers);
  const sales = collectHistoricalSales([
    sheet('trip', [item('existing', 7800)]),
    sheet('other', [item('existing', 6900)], { customerId: 'customer-b' }),
  ]);
  const suggestions = suggestDraftPrices(sales, customers);
  assert.deepEqual(suggestions.map(result => [result.draftCustomerId, result.lineId, result.status, result.unitPriceCents]), [
    ['draft-a', 'missing', 'exact_match', 7800], ['draft-a', 'new-sku', 'no_match', undefined],
    ['draft-b', 'unresolved', 'unresolved_customer', undefined], ['draft-c', 'unlinked', 'unresolved_customer', undefined],
    ['draft-d', 'other-price', 'exact_match', 6900],
  ]);
  assert.deepEqual(customers, before);
});

const customer = { id: 'a', name: '王记餐饮' };
const alias = { customerId: 'a', alias: ' 老王 ', normalizedAlias: '老王' };
const directory = { customers: [customer], aliases: [alias] };

test('exact alias and canonical matches resolve to one formal customer and preserve the canonical display name', () => {
  assert.deepEqual(resolveCustomerMention(directory, '老王'), {
    status: 'resolved', customerId: 'a', canonicalName: '王记餐饮', matchedBy: 'alias', matchedAlias: ' 老王 ',
  });
  const ownName = { ...directory, aliases: [...directory.aliases, { customerId: 'a', alias: '王记餐饮', normalizedAlias: '王记餐饮' }] };
  assert.deepEqual(resolveCustomerMention(ownName, ' 王记餐饮 '), {
    status: 'resolved', customerId: 'a', canonicalName: '王记餐饮', matchedBy: 'canonical', matchedAlias: null,
  });
  const drafts = [
    { id: 'first', customer: '王记餐饮', items: [{ id: 'line-1' }] },
    { id: 'second', customer: '老王', items: [{ id: 'line-2' }] },
    { id: 'similar', customer: '王记', items: [{ id: 'line-3' }] },
    { id: 'explicit-new', customer: '老王', partyId: null, items: [{ id: 'line-4' }] },
    { id: 'linked', customer: '旧显示名', partyId: 'a', items: [{ id: 'line-5' }] },
  ];
  assert.deepEqual(suggestDraftCustomerMentions(drafts, directory).map(row => [row.draftCustomerId, row.resolution.status]),
    [['first', 'resolved'], ['second', 'resolved'], ['similar', 'candidate_only']]);
  const before = structuredClone(drafts);
  assert.deepEqual(mergeDraftCustomers(drafts, directory), [
    { id: 'first', customer: '王记餐饮', partyId: 'a', items: [{ id: 'line-1' }, { id: 'line-2' }, { id: 'line-5' }] },
    drafts[2], drafts[3],
  ]);
  assert.deepEqual(drafts, before);
});

test('canonical name collisions and alias collisions require manual selection in stable order', () => {
  for (const name of ['王记餐饮', '老王']) {
    const collision = { ...directory, customers: [{ id: 'b', name }, customer] };
    const result = resolveCustomerMention(collision, name);
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.customerId, null);
    assert.deepEqual(result.candidates.map(candidate => candidate.customerId).sort(), ['a', 'b']);
    assert.deepEqual(resolveCustomerMention({ ...collision, customers: [...collision.customers].reverse() }, name), result);
  }
});

test('unrecorded near names only suggest candidates and one-character, empty or new names stay unresolved', () => {
  for (const input of ['王记', '王记餐饮店', '老王店']) {
    assert.deepEqual(resolveCustomerMention(directory, input), {
      status: 'candidate_only', customerId: null, candidates: [{ customerId: 'a', canonicalName: '王记餐饮' }],
    });
  }
  for (const input of ['王', '新店', ' ']) {
    assert.deepEqual(resolveCustomerMention(directory, input), { status: 'new_customer', customerId: null });
  }
});
