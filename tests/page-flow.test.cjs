const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
function environment() {
  let config;
  let stored;
  let failWrites = false;
  global.wx = {
    getStorageSync: () => stored === undefined ? '' : JSON.parse(JSON.stringify(stored)),
    setStorageSync: (_, value) => { if (failWrites) throw new Error('保存失败'); stored = JSON.parse(JSON.stringify(value)); },
    showModal: ({ success }) => success({ confirm: true }),
  };
  global.Page = value => { config = value; };
  function load(name) {
    const filename = path.resolve(__dirname, `../code/dist/pages/${name}/index.js`);
    delete require.cache[filename];
    require(filename);
    return { ...config, data: JSON.parse(JSON.stringify(config.data)), setData(value) { Object.assign(this.data, value); } };
  }
  return { load, fail: value => { failWrites = value; } };
}
test('normal page entry: empty -> form events -> preview -> edit -> confirm -> reload -> list', () => {
  const env = environment();
  const page = env.load('assistant');
  page.onLoad();
  assert.equal(page.data.loaded, true);
  assert.equal(page.data.confirmedOrder, null);
  page.editCustomer({ detail: { value: '客户 A' } });
  for (const [field, value] of Object.entries({ product: '水饺', brand: '安井', specification: '500g', quantity: '2', price: '82' })) {
    page.editItem({ currentTarget: { dataset: { index: 0, field } }, detail: { value } });
  }
  page.showPreview();
  assert.equal(page.data.previewOrder.total, '164.00');
  page.backToEdit();
  page.editItem({ currentTarget: { dataset: { index: 0, field: 'price' } }, detail: { value: '80' } });
  assert.equal(page.data.previewOrder, null);
  page.showPreview();
  assert.equal(page.data.previewOrder.total, '160.00');
  page.confirmOrder();
  page.confirmOrder();
  assert.equal(page.data.confirmedOrder.total, '160.00');
  const reopened = env.load('assistant');
  reopened.onLoad();
  assert.equal(reopened.data.confirmedOrder.total, '160.00');
  const list = env.load('delivery');
  list.onShow();
  assert.equal(list.data.list.length, 1);
  reopened.nextOrder();
  assert.equal(reopened.data.confirmedOrder, null);
  assert.equal(reopened.data.draft.customer, '');
});
test('page does not report success after failed persistence; user can retry', () => {
  const env = environment();
  const page = env.load('assistant');
  page.onLoad(); page.fillSample(); page.showPreview();
  env.fail(true);
  page.confirmOrder();
  assert.equal(page.data.error, '保存失败');
  assert.equal(page.data.confirmedOrder, null);
  assert.equal(page.data.previewOrder.total, '164.00');
  env.fail(false); page.confirmOrder();
  assert.equal(page.data.confirmedOrder.total, '164.00');
});
