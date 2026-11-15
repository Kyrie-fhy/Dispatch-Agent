const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderService, preview, readState } = require('../code/dist/core/orders');
function setup() {
  let data;
  let fail = false;
  let sequence = 0;
  const service = new OrderService({
    read: () => data === undefined ? undefined : JSON.parse(JSON.stringify(data)),
    write: value => { if (fail) throw new Error('disk full'); data = JSON.parse(JSON.stringify(value)); },
  }, () => `id-${++sequence}`, () => '2026-11-15T00:00:00.000Z');
  const draft = service.load().draft;
  draft.customer = '客户 A';
  Object.assign(draft.items[0], { product: '水饺', brand: '安井', specification: '500g', quantity: '2', price: '82' });
  return { service, draft, failWrites: value => { fail = value; } };
}
test('preview 164 yuan creates no order; confirmation is idempotent and survives reload', () => {
  const { service, draft } = setup();
  const saved = service.save(draft).draft;
  assert.equal(preview(saved).totalCents, 16400);
  assert.equal(service.load().orders.length, 0);
  const order = service.confirm(saved.id, saved.revision);
  assert.equal(service.confirm(saved.id, saved.revision).id, order.id);
  assert.equal(service.load().orders.length, 1);
  assert.equal(service.load().orders[0].totalCents, 16400);
  assert.throws(() => service.save(service.load().draft), /已确认/);
});
test('edited price invalidates old preview and confirmation uses revised amount', () => {
  const { service, draft } = setup();
  const old = service.save(draft).draft;
  const edited = JSON.parse(JSON.stringify(old));
  edited.items[0].price = '80';
  const saved = service.save(edited).draft;
  assert.throws(() => service.confirm(old.id, old.revision), /重新预览/);
  assert.equal(service.confirm(saved.id, saved.revision).totalCents, 16000);
});
test('decimal money is exact, missing fields and unsupported inputs are rejected', () => {
  const { draft } = setup();
  draft.items[0].quantity = '3';
  draft.items[0].price = '0.10';
  assert.equal(preview(draft).totalCents, 30);
  for (const value of ['', '-1', '0', '1.001', '1e3', 'Infinity']) {
    draft.items[0].price = value;
    assert.throws(() => preview(draft));
  }
  draft.items[0].price = '82';
  draft.items[0].quantity = '1.5';
  assert.throws(() => preview(draft), /正整数/);
  draft.items[0].quantity = '2';
  draft.items[0].brand = '';
  assert.throws(() => preview(draft), /品牌/);
});
test('failed confirmation writes nothing, retry records once', () => {
  const { service, draft, failWrites } = setup();
  const saved = service.save(draft).draft;
  failWrites(true);
  assert.throws(() => service.confirm(saved.id, saved.revision), /disk full/);
  assert.equal(service.load().orders.length, 0);
  failWrites(false);
  service.confirm(saved.id, saved.revision);
  assert.equal(service.load().orders.length, 1);
});
test('next draft preserves previous orders; stale writes cannot replace new draft', () => {
  const { service, draft } = setup();
  const saved = service.save(draft).draft;
  service.confirm(saved.id, saved.revision);
  const next = service.startNext();
  assert.notEqual(next.draft.id, saved.id);
  assert.equal(next.orders.length, 1);
  assert.throws(() => service.save(saved), /草稿已更新/);
});
test('corrupt or unknown schema does not silently reset', () => {
  assert.throws(() => readState({ schemaVersion: 2 }, 'new'), /无法读取/);
  const { service, draft } = setup();
  const saved = service.save(draft).draft;
  service.confirm(saved.id, saved.revision);
  const data = service.load();
  data.orders[0].totalCents = 1;
  assert.throws(() => readState(data, 'new'), /金额校验/);
});
