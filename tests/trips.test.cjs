const test = require('node:test');
const assert = require('node:assert/strict');
const { initialState, preview, money } = require('../code/dist/core/orders');
const { TripService, currentTrip, latest, pickingChanges, pickingList, previewTrip } = require('../code/dist/core/trips');
const { customerDebts, localDay, sheetBalance, tripBalance } = require('../code/dist/core/settlement');

const now = '2026-11-15T00:00:00.000Z';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function fixture() {
  const item = (id, brand, quantity, price, unit = '箱') => ({ id, brand, product: '水饺', specification: '500g', unit, quantity, price });
  return [
    { id: 'a', customer: '客户 A', partyId: null, items: [item('ac', '安井', '2', '82')] },
    { id: 'b', customer: '客户 B', partyId: null, items: [item('bc', '安井', '3', '80'), item('bb', '安井', '3', '20', '袋')] },
    { id: 'c', customer: '客户 C', partyId: null, items: [item('cc', '三全', '1', '75')] },
  ];
}

function setup(raw) {
  let stored = clone(raw);
  let failure = false;
  let sequence = 0;
  let timestamp = now;
  const service = new TripService({ read: () => clone(stored), write: data => {
    if (failure) throw new Error('disk full');
    stored = clone(data);
  } }, () => `id-${++sequence}`, () => timestamp);
  const saveFixture = () => service.saveDraft({ ...service.load().draft, customers: fixture() });
  function confirmFixture() {
    const draft = saveFixture();
    return service.confirm(draft.id, draft.revision);
  }
  return { service, saveFixture, confirmFixture, fail: value => { failure = value; }, raw: () => clone(stored),
    time: value => { timestamp = value; } };
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

test('delivered replacement requires an explicit status; removal and stale delivery states are handled', () => {
  const { service, confirmFixture } = setup();
  const first = confirmFixture();
  const replacement = service.startAmendment(first.id, 'c');
  replacement.customer.items[0].brand = '安井';
  assert.equal(service.previewAmendment(replacement).changes[0].afterStatus, 'pending');
  service.setDelivery(first.id, 1, 'c', 'cc', 'delivered');
  assert.throws(() => service.confirmAmendment(replacement), /状态已变化/);
  const current = service.startAmendment(first.id, 'c');
  current.customer.items = replacement.customer.items;
  assert.throws(() => service.previewAmendment(current), /确认替换货品的配送状态/);
  current.replacementStatuses = { cc: 'delivered' };
  assert.equal(service.previewAmendment(current).changes[0].afterStatus, 'delivered');
  service.setDelivery(first.id, 1, 'b', 'bc', 'delivered');
  const delivered = service.startAmendment(first.id, 'b');
  delivered.customer.items.shift();
  assert.equal(service.previewAmendment(delivered).changes[0].after, undefined);
  assert.equal(service.previewAmendment(delivered).after.due, 0);
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

test('new trip only takes effect when confirmed and changes to history stay in their trip', () => {
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
  service.setDelivery(first.id, 1, 'a', 'ac', 'pending');
  assert.equal(currentTrip(service.load()).id, next.id);
  assert.equal(service.load().trips[0].statuses.ac, 'pending');
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
  assert.equal(migrated.schemaVersion, 3);
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

function target(trip, sheetId = 'a') { return { tripId: trip.id, sheetId }; }

function reconcile(service, trip, sheetId = 'a', lineId = null) {
  const before = service.load().trips.find(entry => entry.id === trip.id);
  const version = latest(before).version;
  service.setDelivery(trip.id, version, sheetId, lineId, 'delivered');
  const stored = service.load().trips.find(entry => entry.id === trip.id);
  service.reviewSheet(target(trip, sheetId), version, stored.statusRevision);
}

function nextOrder(service, partyId, price, name = '客户 A') {
  const draft = service.startNext();
  const [customer] = fixture();
  customer.customer = name;
  customer.partyId = partyId;
  customer.items[0].quantity = '1';
  customer.items[0].price = price;
  const saved = service.saveDraft({ ...draft, customers: [customer] });
  return service.confirm(saved.id, saved.revision);
}

test('older balances are paid first, paid amounts follow the customer across trips, and retries are atomic', () => {
  const { service, confirmFixture, fail, raw } = setup();
  const first = confirmFixture();
  const account = target(first);
  reconcile(service, first);
  reconcile(service, first, 'b', 'bc');
  service.reviewSheet(target(first, 'c'), 1, service.load().trips[0].statusRevision);
  const opening = service.previewOpening(account, '2026-11-13', '60.00', '旧手账 1');
  let before = raw();
  fail(true);
  assert.throws(() => service.confirmOpening(opening), /disk full/);
  assert.deepEqual(raw(), before);
  fail(false);
  service.confirmOpening(opening);
  service.confirmOpening(opening);
  assert.throws(() => service.previewOpening(account, opening.day, '60', '旧手账 1'), /已存在/);
  assert.throws(() => service.previewOpening(account, '2026-02-30', '1', ''), /有效/);
  assert.deepEqual(tripBalance(service.load(), service.load().trips[0]),
    { due: 40400, paid: 0, remaining: 40400, excess: 0, unchecked: 0, historical: 6000, reviewed: 3, count: 3 });
  const plan = service.previewReceipt(account, '100');
  assert.deepEqual(plan.allocations.map(entry => [entry.cents, entry.remaining]), [[6000, 0], [4000, 12400]]);
  before = raw();
  fail(true);
  assert.throws(() => service.confirmReceipt(plan), /disk full/);
  assert.deepEqual(raw(), before);
  fail(false);
  const receipt = service.confirmReceipt(plan);
  assert.deepEqual(service.confirmReceipt(plan), receipt);
  const a = service.load().ledger.accounts[0];
  const next = nextOrder(service, a.partyId, '50.00');
  assert.equal(tripBalance(service.load(), next).historical, 12400);
  assert.throws(() => service.previewReceipt(target(next), '1'), /先确认对账/);
  const final = service.previewReceipt(account, '124');
  assert.deepEqual(final.allocations.map(entry => entry.cents), [12400]);
  service.confirmReceipt(final);
  assert.equal(service.load().ledger.receipts.length, 2);
  assert.equal(tripBalance(service.load(), next).historical, 0);
});

test('same-day priority uses the original timestamp and places date-only debts at the end', () => {
  const { service, confirmFixture, time } = setup();
  const first = confirmFixture();
  const partyId = service.load().ledger.accounts[0].partyId;
  time('2026-11-16T09:00:00+08:00');
  const morning = nextOrder(service, partyId, '30');
  reconcile(service, morning);
  time('2026-11-16T15:00:00+08:00');
  const afternoon = nextOrder(service, partyId, '40');
  reconcile(service, afternoon);
  const afternoonSheet = target(afternoon);
  const day = localDay(new Date(afternoon.versions[0].savedAt));
  const sameDay = service.previewOpening(afternoonSheet, day, '50', '旧手账');
  service.confirmOpening(sameDay);
  const amendment = service.startAmendment(morning.id, 'a');
  amendment.customer.items[0].quantity = '2';
  amendment.customer.items[0].price = '15';
  service.confirmAmendment(amendment);
  const plan = service.previewReceipt(afternoonSheet, '80');
  assert.deepEqual(plan.allocations.map(entry => entry.cents), [3000, 4000, 1000]);
  const order = customerDebts(service.load(), partyId);
  assert.equal(order[0].sheet.tripId, morning.id);
  assert.equal(order[1].sheet.tripId, afternoon.id);
  assert.equal(order[2].time, null);
  const equalTime = nextOrder(service, partyId, '15');
  reconcile(service, equalTime);
  const tied = customerDebts(service.load(), partyId).filter(entry => entry.time === Date.parse(afternoon.versions[0].savedAt));
  assert.deepEqual(tied.map(entry => entry.id), tied.map(entry => entry.id).sort());
  assert.notEqual(first.id, afternoon.id);
});

test('old previews are rejected after money or delivery changes, and correction keeps paid amounts', () => {
  const { service, confirmFixture, fail, raw } = setup();
  const first = confirmFixture();
  const change = service.startAmendment(first.id, 'a');
  change.customer.items[0].price = '100';
  service.confirmAmendment(change);
  reconcile(service, first);
  const account = target(first);
  const firstPlan = service.previewReceipt(account, '200');
  const duplicatePlan = service.previewReceipt(account, '200');
  const higher = service.startAmendment(first.id, 'a');
  higher.customer.items[0].price = '110';
  service.previewAmendment(higher);
  service.confirmReceipt(firstPlan);
  assert.throws(() => service.confirmReceipt(duplicatePlan), /账目已变化/);
  assert.throws(() => service.confirmAmendment(higher), /账目已变化/);
  const fresh = { ...higher, accountBasis: service.startAmendment(first.id, 'a').accountBasis };
  const expected = service.previewAmendment(fresh);
  assert.deepEqual(expected.after, { due: 22000, paid: 20000, remaining: 2000, excess: 0 });
  service.confirmAmendment(fresh);
  const extra = service.previewReceipt(account, '20');
  const lower = service.startAmendment(first.id, 'a');
  lower.customer.items[0].price = '90';
  const result = service.previewAmendment(lower);
  assert.deepEqual(result.after, { due: 18000, paid: 20000, remaining: 0, excess: 2000 });
  const before = raw();
  fail(true);
  assert.throws(() => service.confirmAmendment(lower), /disk full/);
  assert.deepEqual(raw(), before);
  fail(false);
  service.confirmAmendment(lower);
  assert.throws(() => service.confirmReceipt(extra), /账目已变化/);
  const stored = service.load();
  assert.deepEqual(stored.ledger.receipts[0], before.ledger.receipts[0]);
  const after = stored.trips[0];
  const delivery = service.previewDelivery({ ...account, version: latest(after).version, status: 'pending', lineId: 'ac' });
  assert.equal(delivery.after.excess, 20000);
  fail(true);
  assert.throws(() => service.confirmDelivery(delivery), /disk full/);
  fail(false);
  service.confirmDelivery(delivery);
  service.confirmDelivery(delivery);
  assert.equal(service.load().trips[0].statuses.ac, 'pending');
  const next = nextOrder(service, stored.ledger.accounts[0].partyId, '50');
  reconcile(service, next);
  const state = service.load();
  assert.equal(tripBalance(state, currentTrip(state)).remaining, 5000);
});

test('same-name customers are separate and separate equal-cent receipts still record independently', () => {
  const { service } = setup();
  const [a, b] = fixture();
  a.items[0].quantity = '1';
  a.items[0].price = '0.03';
  b.customer = a.customer;
  const draft = service.saveDraft({ ...service.load().draft, customers: [a, b] });
  const first = service.confirm(draft.id, draft.revision);
  reconcile(service, first);
  reconcile(service, first, 'b', 'bc');
  const account = target(first);
  for (const input of ['', '0', '-1', '0.001', '0.04', '90071992547409.92']) {
    assert.throws(() => service.previewReceipt(account, input));
  }
  const one = service.previewReceipt(account, '0.01');
  service.confirmReceipt(one);
  const two = service.previewReceipt(account, '0.01');
  service.confirmReceipt(two);
  service.confirmReceipt(two);
  const state = service.load();
  assert.equal(state.ledger.receipts.length, 2);
  assert.notEqual(state.ledger.accounts[0].partyId, state.ledger.accounts[1].partyId);
  const trip = state.trips[0];
  assert.deepEqual(sheetBalance(state.ledger, trip, latest(trip).customers[0]), { due: 3, paid: 2, remaining: 1, excess: 0 });
  assert.equal(sheetBalance(state.ledger, trip, latest(trip).customers[1]).paid, 0);
  const next = nextOrder(service, state.ledger.accounts[1].partyId, '1', b.customer);
  assert.equal(tripBalance(service.load(), next).historical, 24000);
});

test('S2 upgrade preserves orders without guessing identity or payment and S1 can be manually reviewed', () => {
  const before = setup();
  const first = before.confirmFixture();
  before.service.setDelivery(first.id, 1, 'a', null, 'delivered');
  const { draft, trips } = before.raw();
  const v2 = { schemaVersion: 2, draft, trips };
  const migrated = setup(v2);
  migrated.fail(true);
  assert.throws(() => migrated.service.load(), /disk full/);
  assert.deepEqual(migrated.raw(), v2);
  migrated.fail(false);
  assert.deepEqual(migrated.service.load().trips, trips);
  assert.deepEqual(migrated.raw().ledger.accounts, []);
  assert.throws(() => migrated.service.reviewSheet(target(first), 1, 1), /客户归属/);
  migrated.service.linkCustomer(target(first), null);
  migrated.service.reviewSheet(target(first), 1, 1);
  assert.equal(migrated.service.previewReceipt(target(first), '164').allocations[0].remaining, 0);

  const legacy = initialState('old-draft');
  const a = fixture()[0];
  legacy.orders = [{ ...preview({ ...legacy.draft, ...a, id: 's1-order' }), confirmedAt: now }];
  const old = setup(legacy).service;
  const legacySheet = { tripId: 's1-order', sheetId: 's1-order' };
  old.linkCustomer(legacySheet, null);
  assert.throws(() => old.reviewSheet(legacySheet, 1, 0), /未记录/);
  old.setDelivery(legacySheet.tripId, 1, legacySheet.sheetId, 'ac', 'pending');
  old.reviewSheet(legacySheet, 1, 1);
  assert.throws(() => old.previewReceipt(legacySheet, '1'), /最多可抵扣 ¥0.00/);
  assert.equal(currentTrip(old.load()), undefined);
});
