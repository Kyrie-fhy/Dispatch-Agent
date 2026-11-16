const test = require('node:test');
const assert = require('node:assert/strict');
const { initialState, preview, money } = require('../code/dist/core/orders');
const { TripService, currentTrip, latest, pickingChanges, pickingList, previewTrip } = require('../code/dist/core/trips');

const now = '2026-11-15T00:00:00.000Z';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function fixture() {
  const item = (id, brand, quantity, price, unit = '箱') => ({ id, brand, product: '水饺', specification: '500g', unit, quantity, price });
  return [
    { id: 'a', customer: '客户 A', items: [item('ac', '安井', '2', '82')] },
    { id: 'b', customer: '客户 B', items: [item('bc', '安井', '3', '80'), item('bb', '安井', '3', '20', '袋')] },
    { id: 'c', customer: '客户 C', items: [item('cc', '三全', '1', '75')] },
  ];
}

function setup(raw) {
  let stored = clone(raw);
  let failure = false;
  let sequence = 0;
  const service = new TripService({ read: () => clone(stored), write: data => {
    if (failure) throw new Error('disk full');
    stored = clone(data);
  } }, () => `id-${++sequence}`, () => now);
  const saveFixture = () => service.saveDraft({ ...service.load().draft, customers: fixture() });
  function confirmFixture() {
    const draft = saveFixture();
    return service.confirm(draft.id, draft.revision);
  }
  return { service, saveFixture, confirmFixture, fail: value => { failure = value; }, raw: () => clone(stored) };
}

function takeList(version) {
  return pickingList(version.customers).map(({ brand, quantity, unit }) => [brand, quantity, unit]);
}

test('all customers must validate; previews are versioned and entire-trip confirmation is atomic and idempotent', () => {
  const { service, saveFixture, fail } = setup();
  const first = saveFixture();
  first.customers[2].items[0].brand = '';
  const missing = service.saveDraft(first);
  assert.throws(() => previewTrip(missing), /客户 C.*品牌/);
  assert.throws(() => service.confirm(missing.id, missing.revision), /客户 C.*品牌/);
  assert.throws(() => service.confirm(first.id, first.revision), /重新预览/);
  const fixed = saveFixture();
  assert.equal(previewTrip(fixed).totalCents, 53900);
  assert.deepEqual(service.load().trips, []);
  fail(true);
  assert.throws(() => service.confirm(fixed.id, fixed.revision), /disk full/);
  assert.deepEqual(service.load().trips, []);
  fail(false);
  const trip = service.confirm(fixed.id, fixed.revision);
  assert.deepEqual(service.confirm(fixed.id, fixed.revision), trip);
  assert.equal(service.load().trips.length, 1);
  assert.deepEqual(latest(trip).customers.map(customer => customer.totalCents), [16400, 30000, 7500]);
  assert.deepEqual(takeList(latest(trip)), [['安井', 5, '箱'], ['安井', 3, '袋'], ['三全', 1, '箱']]);
});

test('quantity grouping trims text, respects specs and original units, and ignores customer prices', () => {
  const customers = fixture();
  customers[1].customer = customers[0].customer;
  customers[0].items[0].product = ' 水饺 ';
  customers[2].items.push({ ...customers[0].items[0], id: 'extra', specification: '1kg' });
  const version = previewTrip({ id: 'trip', revision: 1, customers });
  assert.deepEqual(pickingList(version.customers).map(item => [item.specification, item.brand, item.quantity, item.unit]),
    [['500g', '安井', 5, '箱'], ['500g', '安井', 3, '袋'], ['500g', '三全', 1, '箱'], ['1kg', '安井', 2, '箱']]);
  for (const customer of customers) customer.items[0].price = '90071992547409.91';
  assert.throws(() => previewTrip({ id: 'trip', revision: 1, customers }), /超出/);
  assert.equal(money(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  const largeAmount = '45035996273704.96';
  for (const customer of customers) customer.items = [{ ...customer.items[0], price: largeAmount, quantity: '1' }];
  assert.throws(() => previewTrip({ id: 'trip', revision: 1, customers }), /整趟订单金额/);
});

test('delivery is scoped to the selected customer and keeps trip version and quantities', () => {
  const { service, confirmFixture, fail } = setup();
  const { id } = confirmFixture();
  assert.throws(() => service.setDelivery(id, 1, 'a', 'bc', 'delivered'), /明细已变化/);
  fail(true);
  assert.throws(() => service.setDelivery(id, 1, 'b', null, 'delivered'), /disk full/);
  assert.deepEqual(currentTrip(service.load()).statuses, { ac: 'pending', bc: 'pending', bb: 'pending', cc: 'pending' });
  fail(false);
  service.setDelivery(id, 1, 'b', null, 'delivered');
  service.setDelivery(id, 1, 'b', null, 'delivered');
  assert.equal(currentTrip(service.load()).statusRevision, 1);
  service.setDelivery(id, 1, 'b', 'bb', 'pending');
  const trip = currentTrip(service.load());
  assert.deepEqual(trip.statuses, { ac: 'pending', bc: 'delivered', bb: 'pending', cc: 'pending' });
  assert.equal(latest(trip).version, 1);
  assert.deepEqual(takeList(latest(trip)), [['安井', 5, '箱'], ['安井', 3, '袋'], ['三全', 1, '箱']]);
});

test('correction commits one new version, retains delivery status and recomputes quantity differences', () => {
  const { service, confirmFixture, fail } = setup();
  const first = confirmFixture();
  service.setDelivery(first.id, 1, 'b', 'bc', 'delivered');
  const change = service.startAmendment(first.id, 'b');
  change.customer.items[0].quantity = '2';
  const result = service.previewAmendment(change);
  assert.equal(result.totalCents, 45900);
  assert.equal(result.changes[0].afterStatus, 'delivered');
  assert.deepEqual(result.picking.map(row => [row.brand, row.before, row.after]), [['安井', 5, 4]]);
  assert.equal(latest(currentTrip(service.load())).totalCents, 53900);
  fail(true);
  assert.throws(() => service.confirmAmendment(change), /disk full/);
  assert.equal(latest(currentTrip(service.load())).version, 1);
  fail(false);
  const updated = service.confirmAmendment(change);
  assert.equal(updated.version, 2);
  assert.deepEqual(service.confirmAmendment(change), updated);
  assert.deepEqual(takeList(updated), [['安井', 4, '箱'], ['安井', 3, '袋'], ['三全', 1, '箱']]);
  assert.throws(() => service.setDelivery(first.id, 1, 'b', 'bc', 'pending'), /正式单已变化/);
  const trip = currentTrip(service.load());
  assert.equal(trip.versions.length, 2);
  assert.equal(trip.versions[0].customers[1].items[0].quantity, '3');
  assert.equal(trip.statuses.bc, 'delivered');
  const price = service.startAmendment(trip.id, 'a');
  price.customer.items[0].price = '80';
  const priceVersion = service.confirmAmendment(price);
  assert.deepEqual(pickingChanges(updated.customers, priceVersion.customers), []);
});

test('replacement and removal are limited to pending lines; stale statuses invalidate correction', () => {
  const { service, confirmFixture } = setup();
  const first = confirmFixture();
  const replacement = service.startAmendment(first.id, 'c');
  replacement.customer.items[0].brand = '安井';
  assert.equal(service.previewAmendment(replacement).changes[0].afterStatus, 'pending');
  service.setDelivery(first.id, 1, 'c', 'cc', 'delivered');
  assert.throws(() => service.confirmAmendment(replacement), /状态已变化/);
  const current = service.startAmendment(first.id, 'c');
  current.customer.items = replacement.customer.items;
  assert.throws(() => service.previewAmendment(current), /暂不支持换货或移除/);
  service.setDelivery(first.id, 1, 'b', 'bc', 'delivered');
  const delivered = service.startAmendment(first.id, 'b');
  delivered.customer.items.shift();
  assert.throws(() => service.previewAmendment(delivered), /暂不支持换货或移除/);
  service.setDelivery(first.id, 1, 'c', 'cc', 'pending');
  const pending = service.startAmendment(first.id, 'c');
  pending.customer.items = replacement.customer.items;
  const result = service.previewAmendment(pending);
  assert.deepEqual(result.picking.map(row => [row.brand, row.before, row.after]), [['安井', 5, 6], ['三全', 1, 0]]);
  service.confirmAmendment(pending);
  const removePending = service.startAmendment(first.id, 'b');
  removePending.customer.items.pop();
  const afterRemoval = service.confirmAmendment(removePending);
  assert.equal(currentTrip(service.load()).statuses.bb, undefined);
  assert.equal(afterRemoval.customers[1].items.length, 1);
});

test('new trip only takes effect when confirmed and earlier statuses are preserved read-only', () => {
  const { service, confirmFixture } = setup();
  const first = confirmFixture();
  service.setDelivery(first.id, 1, 'a', 'ac', 'delivered');
  service.startNext();
  const next = service.saveDraft({ ...service.load().draft, customers: [fixture()[0]] });
  assert.equal(currentTrip(service.load()).id, first.id);
  service.confirm(next.id, next.revision);
  const state = service.load();
  assert.equal(currentTrip(state).id, next.id);
  assert.equal(state.trips[0].statuses.ac, 'delivered');
  assert.equal(state.trips[1].statuses.ac, 'pending');
  assert.throws(() => service.setDelivery(first.id, 1, 'a', 'ac', 'pending'), /不在当前/);
});

test('migration preserves S1 orders and an unfinished draft and never overwrites damaged data', () => {
  const legacy = initialState('s1-draft');
  const a = fixture()[0];
  legacy.draft = { ...legacy.draft, customer: a.customer, items: a.items };
  const complete = { ...preview({ ...legacy.draft, id: 's1-order' }), confirmedAt: now };
  legacy.orders = [complete];
  const env = setup(legacy);
  env.fail(true);
  assert.throws(() => env.service.load(), /disk full/);
  assert.deepEqual(env.raw(), legacy);
  env.fail(false);
  const migrated = env.service.load();
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.draft.id, 's1-draft');
  assert.equal(migrated.draft.customers[0].customer, a.customer);
  assert.equal(currentTrip(migrated), undefined);
  assert.equal(latest(migrated.trips[0]).totalCents, 16400);
  assert.equal(migrated.trips[0].statuses.ac, 'unrecorded');
  const priorConfirmation = setup({ ...legacy, draft: { ...legacy.draft, id: complete.id } }).service.load();
  assert.notEqual(priorConfirmation.draft.id, complete.id);
  assert.equal(priorConfirmation.draft.customers[0].customer, '');
  for (const damaged of [{ schemaVersion: 99 }, { ...legacy, orders: [{ ...complete, totalCents: 1 }] },
    { ...migrated, trips: [{ ...migrated.trips[0], statuses: {} }] }]) {
    const invalid = setup(damaged);
    assert.throws(() => invalid.service.load());
    assert.deepEqual(invalid.raw(), damaged);
  }
});
