const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function environment() {
  let config;
  let stored;
  let failWrites = false;
  let failImage = false;
  let albumError = '';
  let failAlbumIndex = -1;
  let text = [];
  const pictures = [];
  const saved = [];
  const canvas = {
    getContext: () => ({
      fillRect: () => {}, measureText: value => ({ width: Array.from(value).length * 28 }),
      fillText: (value, x, y) => text.push({ value, x, y }),
    }),
    set height(height) { this.pageHeight = height; text = []; },
  };
  global.wx = {
    getStorageSync: () => stored === undefined ? '' : JSON.parse(JSON.stringify(stored)),
    setStorageSync: (_, value) => {
      if (failWrites) throw new Error('模拟写入失败');
      stored = JSON.parse(JSON.stringify(value));
    },
    showModal: ({ success }) => success({ confirm: true }),
    createSelectorQuery() {
      return { select: () => ({ node: callback => ({ exec: () => callback({ node: canvas }) }) }) };
    },
    canvasToTempFilePath({ canvas: source, success, fail, destHeight }) {
      assert.equal(source, canvas);
      if (failImage) return fail({ errMsg: 'canvas failed' });
      assert.equal(destHeight, source.pageHeight);
      assert.ok(text.every(line => line.x === 48 && line.y < destHeight));
      pictures.push(text.map(line => line.value));
      success({ tempFilePath: `wxfile://customer-${pictures.length}.png` });
    },
    saveImageToPhotosAlbum({ filePath, success, fail }) {
      if (saved.length === failAlbumIndex) return fail({ errMsg: albumError });
      saved.push(filePath);
      success();
    },
    openSetting: ({ success }) => success({ authSetting: { 'scope.writePhotosAlbum': true } }),
  };
  global.Page = value => { config = value; };
  function load(name) {
    const filename = path.resolve(__dirname, `../code/dist/pages/${name}/index.js`);
    delete require.cache[filename];
    require(filename);
    return { ...config, data: JSON.parse(JSON.stringify(config.data)), setData(value) { Object.assign(this.data, value); } };
  }
  return { load, pictures, saved, failWrites: value => { failWrites = value; }, failImage: value => { failImage = value; },
    failAlbum(index, reason) { failAlbumIndex = index; albumError = reason; } };
}

function tap(data) { return { currentTarget: { dataset: data } }; }

function input(dataset, value) { return { ...tap(dataset), detail: { value } }; }

function edit(page, id, fields) {
  for (const [field, value] of Object.entries(fields)) page.editItem(input({ id, field }, value));
}

function nameCustomer(page, name) {
  page.editCustomer(input({ id: page.data.activeId }, name));
  page.chooseNew();
}

function openCustomer(page, index, trip = page.data.current) {
  page.openCustomer(tap({ tripId: trip.id, customerId: trip.customers[index].id }));
}

test('normal page entry: manual multi-customer input, preview, pickup, delivery, amendment, export and next trip', async () => {
  const env = environment();
  const assistant = env.load('assistant');
  const picking = env.load('picking');
  const delivery = env.load('delivery');
  assistant.onLoad();
  const common = { product: '水饺', brand: '安井', specification: '500g' };
  nameCustomer(assistant, '客户 A');
  edit(assistant, assistant.data.active.items[0].id, { ...common, quantity: '2', price: '82' });
  assistant.addCustomer();
  nameCustomer(assistant, '客户 B');
  edit(assistant, assistant.data.active.items[0].id, { ...common, quantity: '3', price: '80' });
  assistant.addItem();
  edit(assistant, assistant.data.active.items[1].id, { ...common, quantity: '3', price: '20', unit: '袋' });
  assistant.addCustomer();
  nameCustomer(assistant, '客户 C');
  const c = assistant.data.active.items[0].id;
  edit(assistant, c, { product: '水饺', specification: '500g', quantity: '1', price: '75' });
  assistant.showPreview();
  assert.match(assistant.data.error, /客户 C.*品牌/);
  assert.equal(assistant.data.draft.customers.length, 3);
  edit(assistant, c, { brand: '三全' });
  assistant.showPreview();
  assert.deepEqual(assistant.data.previewTrip.customers.map(item => item.total), ['164.00', '300.00', '75.00']);
  picking.onShow();
  delivery.onShow();
  assert.equal(picking.data.rows.length, 0);
  assert.equal(delivery.data.current, null);
  assistant.backToEdit();
  edit(assistant, c, { price: '76' });
  assert.equal(assistant.data.previewTrip, null);
  edit(assistant, c, { price: '75' });
  assistant.showPreview();
  assistant.confirmTrip();
  assistant.confirmTrip();
  assert.equal(assistant.data.confirmed.total, '539.00');
  picking.onShow();
  delivery.onShow();
  assert.deepEqual(picking.data.rows.map(line => [line.brand, line.quantity, line.unit]), [['安井', 5, '箱'], ['安井', 3, '袋'], ['三全', 1, '箱']]);
  const first = delivery.data.current.id;
  openCustomer(delivery, 0);
  delivery.deliverCustomer();
  assert.equal(delivery.data.detail.items[0].label, '已送达');
  delivery.backToList();
  openCustomer(delivery, 1);
  const b = delivery.data.detail.items[0].id;
  delivery.toggleLine(tap({ id: b }));
  assert.deepEqual(delivery.data.detail.items.map(item => item.label), ['已送达', '未配送']);
  await delivery.exportImages();
  assert.equal(delivery.data.images.version, 1);
  assert.ok(env.pictures[0].includes('订单金额 ¥300.00'));
  assert.ok(env.pictures[0].includes('客户 B'));
  assert.ok(!env.pictures[0].includes('客户 A'));
  await delivery.saveImages();
  delivery.closeImages();
  delivery.startAmendment();
  edit(delivery, b, { quantity: '2' });
  delivery.showAmendmentPreview();
  assert.equal(delivery.data.preview.after, '220.00');
  assert.equal(delivery.data.preview.changes[0].afterStatus, '已送达');
  delivery.cancelAmendment();
  assert.equal(delivery.data.detail.total, '300.00');
  delivery.startAmendment();
  edit(delivery, b, { quantity: '2' });
  delivery.showAmendmentPreview();
  picking.onShow();
  assert.equal(picking.data.rows[0].quantity, 5);
  env.failWrites(true);
  delivery.confirmAmendment();
  assert.match(delivery.data.error, /保存失败/);
  assert.equal(delivery.data.detail.version, 1);
  env.failWrites(false);
  delivery.confirmAmendment();
  delivery.confirmAmendment();
  assert.equal(delivery.data.detail.version, 2);
  assert.equal(delivery.data.detail.total, '220.00');
  picking.onShow();
  assert.deepEqual(picking.data.changes.map(({ before, after }) => [before, after]), [[5, 4]]);
  const reopened = env.load('delivery');
  reopened.onShow();
  assert.equal(reopened.data.current.total, '459.00');
  openCustomer(reopened, 1);
  assert.deepEqual(reopened.data.detail.items.map(item => item.label), ['已送达', '未配送']);
  await reopened.exportImages();
  assert.equal(reopened.data.images.version, 2);
  assert.ok(env.pictures[1].includes('订单金额 ¥220.00'));
  assert.ok(env.pictures[0].includes('订单金额 ¥300.00'));
  assistant.onShow();
  assistant.nextTrip();
  nameCustomer(assistant, '客户新');
  edit(assistant, assistant.data.active.items[0].id, { ...common, quantity: '7', price: '79' });
  assistant.showPreview();
  picking.onShow();
  assert.equal(picking.data.rows[0].quantity, 4);
  assistant.confirmTrip();
  picking.onShow();
  assert.deepEqual(picking.data.rows.map(line => line.quantity), [7]);
  delivery.backToList();
  delivery.onShow();
  assert.equal(delivery.data.current.total, '553.00');
  assert.equal(delivery.data.history[0].id, first);
  openCustomer(delivery, 1, delivery.data.history[0]);
  assert.equal(delivery.data.detail.active, false);
  assert.equal(delivery.data.detail.version, 2);
});

test('failed formal confirmation is visible and retry only confirms once', () => {
  const env = environment();
  const assistant = env.load('assistant');
  assistant.onLoad();
  assistant.fillSample();
  assistant.showPreview();
  env.failWrites(true);
  assistant.confirmTrip();
  assert.match(assistant.data.error, /保存失败/);
  assert.equal(assistant.data.confirmed, null);
  assert.equal(assistant.data.previewTrip.total, '539.00');
  env.failWrites(false);
  assistant.confirmTrip();
  assistant.confirmTrip();
  assert.equal(assistant.data.confirmed.total, '539.00');
  const delivery = env.load('delivery');
  delivery.onShow();
  assert.equal(delivery.data.history.length, 0);
});

test('long customer images paginate with all rows and album saving resumes after permission and partial failure', async () => {
  const env = environment();
  const assistant = env.load('assistant');
  assistant.onLoad();
  nameCustomer(assistant, '长单客户');
  for (let index = 0; index < 40; index++) {
    if (index) assistant.addItem();
    edit(assistant, assistant.data.active.items[index].id, { product: `第${index + 1}行${'长货品名称'.repeat(8)}`,
      brand: '安井', specification: '500g', quantity: '1', price: '2' });
  }
  assistant.showPreview();
  assistant.confirmTrip();
  const delivery = env.load('delivery');
  delivery.onShow();
  openCustomer(delivery, 0);
  env.failImage(true);
  await delivery.exportImages();
  assert.match(delivery.data.error, /图片生成失败/);
  assert.equal(delivery.data.images, null);
  env.failImage(false);
  await delivery.exportImages();
  const files = delivery.data.images.files;
  assert.ok(files.length > 1);
  const rendered = env.pictures.flat();
  assert.equal(rendered.filter(line => /1 箱 × ¥2/.test(line)).length, 40);
  assert.ok(env.pictures.every(page => page.includes('长单客户')));
  assert.ok(env.pictures[env.pictures.length - 1].includes('订单金额 ¥80.00'));
  env.failAlbum(0, 'saveImageToPhotosAlbum:fail auth deny');
  await delivery.saveImages();
  assert.equal(delivery.data.albumSettings, true);
  assert.equal(delivery.data.images.saved, 0);
  delivery.openAlbumSettings();
  env.failAlbum(1, 'saveImageToPhotosAlbum:fail file error');
  await delivery.saveImages();
  assert.equal(delivery.data.images.saved, 1);
  assert.match(delivery.data.error, /第 2 张保存失败/);
  env.failAlbum(-1, '');
  await delivery.saveImages();
  assert.deepEqual(env.saved, files);
  assert.equal(delivery.data.images.saved, files.length);
});

test('delivery page reconciles A/B/C, previews split payments and receives a historical balance', () => {
  const env = environment();
  const assistant = env.load('assistant');
  const delivery = env.load('delivery');
  assistant.onLoad();
  assistant.fillSample();
  assistant.showPreview();
  assistant.confirmTrip();
  delivery.onShow();
  openCustomer(delivery, 0);
  delivery.deliverCustomer();
  delivery.startReconcile();
  delivery.confirmReconcile();
  delivery.startOpening();
  delivery.editDay(input({}, '2026-07-01'));
  delivery.editAmount(input({}, '60'));
  delivery.editSource(input({}, '旧手账 1'));
  delivery.showEntryPreview();
  delivery.confirmEntry();
  assert.equal(delivery.data.detail.account.historic, '60.00');
  delivery.backToList();
  openCustomer(delivery, 1);
  delivery.startReconcile();
  assert.equal(delivery.data.detail.unchecked.length, 2);
  delivery.toggleLine(tap({ id: delivery.data.detail.items[0].id }));
  delivery.confirmReconcile();
  assert.equal(delivery.data.detail.account.due, '240.00');
  assert.equal(delivery.data.detail.total, '300.00');
  delivery.backToList();
  openCustomer(delivery, 2);
  delivery.startReconcile();
  delivery.confirmReconcile();
  assert.equal(delivery.data.current.reviewed, 3);
  assert.equal(delivery.data.current.due, '404.00');
  delivery.backToList();

  openCustomer(delivery, 0);
  delivery.startReceipt();
  delivery.editAmount(input({}, '100'));
  delivery.showEntryPreview();
  assert.deepEqual(delivery.data.entryPreview.allocations.map(entry => entry.value), ['60.00', '40.00']);
  delivery.cancelEntry();
  assert.equal(delivery.data.detail.account.remaining, '164.00');
  delivery.startReceipt();
  delivery.editAmount(input({}, '100'));
  delivery.showEntryPreview();
  env.failWrites(true);
  delivery.confirmEntry();
  assert.match(delivery.data.error, /保存失败/);
  assert.equal(delivery.data.detail.account.paid, '0.00');
  assert.equal(delivery.data.entryPreview.amount, '100.00');
  env.failWrites(false);
  delivery.confirmEntry();
  delivery.confirmEntry();
  assert.equal(delivery.data.detail.account.remaining, '124.00');
  assert.equal(delivery.data.detail.account.receipts.length, 1);

  assistant.onShow();
  assistant.nextTrip();
  const a = assistant.data.parties.findIndex(party => party.name === '客户 A');
  assistant.chooseExisting(input({}, String(a)));
  edit(assistant, assistant.data.active.items[0].id, { product: '水饺', brand: '安井', specification: '500g', quantity: '1', price: '50' });
  assistant.showPreview();
  assert.match(assistant.data.previewTrip.identities[0], /客户 A · 客户 1/);
  assistant.confirmTrip();
  const reopened = env.load('delivery');
  reopened.onShow();
  openCustomer(reopened, 0, reopened.data.history[0]);
  reopened.startReceipt();
  reopened.editAmount(input({}, '124'));
  reopened.showEntryPreview();
  reopened.confirmEntry();
  assert.equal(reopened.data.detail.account.paid, '164.00');
  assert.equal(reopened.data.detail.account.remaining, '0.00');
  assert.equal(reopened.data.detail.account.receipts.length, 2);
  assert.equal(reopened.data.current.historic, '0.00');
  assert.equal(reopened.data.current.paid, '0.00');

  const line = reopened.data.detail.items[0].id;
  reopened.startAmendment();
  edit(reopened, line, { brand: '三全', price: '90' });
  reopened.showAmendmentPreview();
  assert.match(reopened.data.error, /确认替换货品的配送状态/);
  reopened.selectReplacement(tap({ id: line, status: 'delivered' }));
  reopened.showAmendmentPreview();
  assert.equal(reopened.data.preview.afterBalance.remaining, '16.00');
  reopened.confirmAmendment();
  assert.equal(reopened.data.detail.version, 2);
  assert.equal(reopened.data.detail.account.paid, '164.00');
  assert.equal(reopened.data.current.total, '50.00');
  reopened.toggleLine(tap({ id: line }));
  assert.equal(reopened.data.deliveryPreview.after.excess, '164.00');
  reopened.cancelDelivery();
  assert.equal(reopened.data.detail.account.remaining, '16.00');
  reopened.toggleLine(tap({ id: line }));
  reopened.confirmDelivery();
  assert.equal(reopened.data.detail.account.excess, '164.00');
});
