const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  catalogCsvColumns, exportCatalogCsv, extractCatalogAliases, hasQuotedLinePrice, matchCatalogChoice, matchCatalogItem, parseCatalogCsv,
  parseSpecTokens, quotedLinePrices, resolveCatalogAutoPrice,
} = require('../code/dist/core/catalog');
const { lookupDeliveredPrice, lookupHistoricalPrice, collectHistoricalSales } = require('../code/dist/core/memory');
const { toPinyinTokens, toFuzzyPinyinTokens, pinyinSimilarity } = require('../code/dist/core/pinyin');
const { isDraft, preview } = require('../code/dist/core/orders');
const { pickingList, previewTrip } = require('../code/dist/core/trips');

const record = (overrides = {}) => ({
  code: 'P1', variant: '1', category: '冻品', original: '禾味丸120克', brand: '禾味', product: '鱼肉丸',
  packaging: '120g(原写120)', spec: '单规格', unit: '箱', price: '6.01', status: '在售', verified: '已核实',
  remarks: '', ...overrides,
});
const escapeCsv = value => '"' + value.replaceAll('"', '""') + '"';
const csv = rows => '\uFEFF' + [catalogCsvColumns, ...rows.map(row => Object.values(row))]
  .map(row => row.map(escapeCsv).join(',')).join('\r\n');
const variants = rows => parseCatalogCsv(csv(rows)).map(row => ({
  ...row, productId: row.productCode, variantId: row.productCode + '/' + row.variantCode,
}));
const line = (overrides = {}) => ({
  id: 'line-a', product: '鱼肉丸', brand: '', specification: '', unit: '箱', quantity: '2', price: null, ...overrides,
});
const priceFor = (item, rows, customerId, sales) =>
  resolveCatalogAutoPrice(item, matchCatalogItem(item, rows), customerId, sales);

test('catalog CSV validates shape, decimal cents, status, duplicate variants, and quoted cells before import', () => {
  const [row] = parseCatalogCsv(csv([record({ remarks: '包装印「海味鱼丸」\n说明："冷冻",已核实' })]));
  assert.equal(row.priceCents, 601);
  assert.equal(row.specification, '120g');
  assert.ok(row.aliases.includes('海味鱼丸'));
  assert.equal(parseCatalogCsv(csv([record({ price: '90071992547409.91' })]))[0].priceCents, Number.MAX_SAFE_INTEGER);
  for (const price of ['0', '0.00', '6.001', '6e2', '¥6', '-1', '01', '90071992547409.92']) {
    assert.throws(() => parseCatalogCsv(csv([record({ price })])), /挂牌价/);
  }
  assert.throws(() => parseCatalogCsv(csv([record(), record({ price: '7' })])), /重复/);
  assert.throws(() => parseCatalogCsv(csv([record({ status: '待上架' })])), /销售状态/);
  assert.throws(() => parseCatalogCsv(csv([record()]).replace('详情核实状态', '核实')), /表头/);
  assert.throws(() => parseCatalogCsv(csv([record()]).replace(/,""$/, '')), /13 列/);
  assert.throws(() => parseCatalogCsv(csv([record()]).slice(0, -1)), /引号未闭合/);
});

test('catalog CSV reimports 13 columns, Excel escapes, remarks, and explicit aliases losslessly', () => {
  const [sample] = parseCatalogCsv(csv([record()]));
  const original = {
    ...sample, originalName: "'原名", product: '=鱼肉丸', category: '\t冷冻', brand: '＠禾味',
    flavorOrGrade: '单规格', specification: '手工规格', unit: null, aliases: ['另一种叫法'],
    brandAliases: ['禾牌'], verificationStatus: '已核实',
    remarks: '[Dispatch Catalog v1] 人工原备注\n含逗号,和"引号"',
  };
  const exported = exportCatalogCsv([original]);
  assert.equal(exported.charCodeAt(0), 0xfeff);
  assert.deepEqual(parseCatalogCsv(exportCatalogCsv([])), []);
  assert.match(exported, /"'=鱼肉丸"/);
  assert.match(exported, /"''原名"/);
  assert.deepEqual(parseCatalogCsv(exported), [original]);
  const [edited] = parseCatalogCsv(exported.replace(/"120g","单规格"/, '"250g","鱼味"'));
  assert.equal(edited.specification, '250g·鱼味');
  assert.equal(edited.flavorOrGrade, '鱼味');
  assert.deepEqual(edited.aliases, original.aliases);
  for (const value of ['=1+2', '+启动', '-命令', '@计算', '\t文本', '\r文本', '  ＝表达式']) {
    assert.throws(() => parseCatalogCsv(csv([record({ product: value })])), /电子表格公式/);
  }
  assert.throws(() => parseCatalogCsv(csv([record({ brand: '\uD800' })])), /UTF-8/);
  assert.throws(() => parseCatalogCsv(csv([record(), record({ variant: '2' })]), 1), /最多支持 1 条/);
});

test('catalog aliases use packaging and correction cues without treating negative remarks as aliases', () => {
  const patterns = [
    '包装全称「词」', '包装印「词」', '包装实印「词」', '包装实际印「词」', '包装上印有「词」',
    '包装品名「词」', '包装名称「词」', '包装标注「词」', '包装写着「词」', '包装印着「词」',
    '建议加别名「词」', '建议添加别名「词」', '建议补充别名「词」', '可增加别名「词」', '新增别名「词」',
    '设为别名「词」', '记为别名「词」', '用作别名「词」', '别名为「词」', '原名写「词」',
    '原商品名标为「词」', '原名叫「词」', '原写词', '原标：词', '原记词（旧称）', '原称词',
    '实际「词」', '实为「词」', '应为「词」', '更正为「词」', '又称「词」', '简称「词」',
  ];
  patterns.forEach((pattern, index) => {
    const alias = '示例别称' + index;
    assert.deepEqual(extractCatalogAliases(' 原商品 ', '管理页无「坏别名」；' + pattern.replace('词', alias)), ['原商品', alias], pattern);
  });
  assert.deepEqual(extractCatalogAliases(' Ａ丸 ', '建议加别名「a丸」；原写120；包装印「禾味丸」'), ['Ａ丸', '禾味丸']);
});

test('catalog differentiates brand clues from product aliases and matches qualified forms only', () => {
  const rows = variants([
    record({ brand: '海湾', remarks: '包装全称「海湾食品厂」；包装印「海味鱼丸」；包装全称「海湾牌鱼肉丸」' }),
    record({ code: 'P2', brand: '', product: '素馅丸', original: '素丸120g', remarks: '包装品牌似为「绿田」；厂牌「新绿田」' }),
    record({ code: 'P3', brand: '北湾', product: '虾肉丸', original: '湾虾丸', remarks: '品牌全称「北湾食品」' }),
  ]);
  assert.deepEqual(rows[0].brandAliases, ['海湾食品厂']);
  for (const input of [
    { brand: '海湾食品厂' }, { product: '海湾食品厂鱼肉丸' }, { product: '海湾食品厂海味鱼丸' },
    { product: '海味鱼丸' }, { product: '海湾牌鱼肉丸' },
  ]) assert.equal(matchCatalogItem(line(input), rows).status, 'active');
  assert.equal(matchCatalogItem(line({ product: '素馅丸', brand: '绿田' }), rows).status, 'active');
  assert.equal(matchCatalogItem(line({ product: '新绿田素馅丸' }), rows).status, 'active');
  assert.equal(matchCatalogItem(line({ product: '虾肉丸', brand: '北湾食品' }), rows).status, 'active');
  for (const input of [
    { product: '海湾食品厂' }, { product: '绿田' }, { product: '北湾食品' }, { brand: '北湾食品' },
  ]) assert.equal(matchCatalogItem(line(input), rows).status, 'unmatched');
});

test('catalog matching aligns aliases and exact specs, preserves distinct flavors and grades in picking', () => {
  const rows = variants([
    record({ remarks: '包装印「海味鱼丸」' }),
    record({ code: 'P2', original: '脆皮饺', product: '饺子', packaging: '500g（原写500克）', spec: '韭菜鸡蛋' }),
    record({ code: 'P2', variant: '2', original: '脆皮饺', product: '饺子', packaging: '500克', spec: '芹菜猪肉' }),
    record({ code: 'P2', variant: '3', original: '脆皮饺', product: '饺子', packaging: '500克', spec: '芹菜猪肉', unit: '袋' }),
    record({ code: 'P3', original: '生虾仁', product: '虾仁', packaging: '10公斤', spec: '40–50' }),
    record({ code: 'P3', variant: '2', original: '生虾仁', product: '虾仁', packaging: '10kg', spec: '110-130' }),
    record({ code: 'P4', product: '金汤包', packaging: '200g', spec: '20盒 / 箱' }),
  ]);
  const aligned = priceFor(line({ product: '海味鱼丸' }), rows);
  assert.deepEqual([aligned.product, aligned.brand, aligned.specification, aligned.price, aligned.priceSource],
    ['鱼肉丸', '禾味', '120g', '6.01', 'catalog']);
  assert.equal(rows.at(-1).flavorOrGrade, null);
  assert.equal(matchCatalogItem(line({ product: '饺子', specification: '500g' }), rows).status, 'ambiguous');
  assert.equal(matchCatalogItem(line({ product: '饺子', unit: '袋' }), rows).status, 'ambiguous');
  assert.equal(matchCatalogItem(line({ product: '虾仁', specification: '10kg' }), rows).status, 'ambiguous');
  const input = [
    line({ id: 'A', product: '脆皮饺', specification: '500克韭菜鸡蛋' }),
    line({ id: 'B', product: '禾味饺子芹菜猪肉' }),
    line({ id: 'C', product: '虾仁', specification: '40-50' }),
    line({ id: 'D', product: '虾仁', specification: '10kg·110-130' }),
  ];
  const items = input.map(item => priceFor(item, rows));
  assert.deepEqual(items.map(item => item.specification), ['500g·韭菜鸡蛋', '500g·芹菜猪肉', '10kg·40-50', '10kg·110-130']);
  const draft = { id: 'draft', revision: 1, customers: [{ id: 'customer', customer: '新店', items }] };
  const result = previewTrip(draft, true);
  assert.equal(pickingList(result.customers).length, 4);
  assert.equal(result.totalCents, 4808);
});

test('catalog leaves missing units, cross-unit prices, ambiguous products, discontinued items and external products unpriced', () => {
  const rows = variants([
    ...Array.from({ length: 26 }, (_, index) => record({ code: 'U' + index, product: '无单位冻品' + index, unit: '' })),
    record({ code: 'P1', price: '15', spec: '20盒/箱' }),
    record({ code: 'P1', variant: '2', unit: '盒', price: '0.80', spec: '1盒' }),
    record({ code: 'P2', original: '旧鱼肉丸', brand: '回味', status: '已下架' }),
  ]);
  assert.equal(rows.filter(row => row.unit === null).length, 26);
  rows.slice(0, 26).forEach(row => {
    const actual = priceFor(line({ product: row.product }), rows);
    assert.equal(actual.catalogStatus, 'unit_mismatch');
    assert.equal(actual.price, null);
    assert.match(actual.priceHint, /¥6.01（未标箱价）/);
  });
  const input = line();
  const ambiguous = matchCatalogItem(input, rows);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual(ambiguous.candidates.map(row => row.status), ['active', 'active', 'discontinued']);
  assert.equal(priceFor(input, rows).price, null);
  const mismatched = priceFor(line({ brand: '禾味', unit: '件' }), rows);
  assert.equal(mismatched.price, null);
  assert.equal(mismatched.priceHint, '库内仅记 箱 ¥15.00 / 盒 ¥0.80');
  const discontinued = priceFor(line({ brand: '回味' }), rows);
  assert.equal(discontinued.catalogStatus, 'discontinued');
  assert.equal(discontinued.price, null);
  assert.match(discontinued.priceHint, /已下架/);
  assert.equal(priceFor(line({ product: '临时新品' }), rows).catalogStatus, 'unmatched');
  const external = priceFor(line({ catalogStatus: 'external' }), rows);
  assert.deepEqual([external.catalogStatus, external.price, external.catalogVariantId], ['external', null, null]);
  for (const item of [input, line({ brand: '回味' }), line({ unit: '桶' }), line({ product: '临时新品' })]) {
    for (const source of ['spoken', 'manual']) {
      const priced = priceFor({ ...item, price: '5.50', priceSource: source }, rows);
      assert.deepEqual([priced.price, priced.priceSource], ['5.50', source]);
    }
  }
  assert.ok(isDraft({ id: 'draft', revision: 1, customer: '试验店', items: [mismatched] }));
  assert.equal(preview({ id: 'draft', revision: 1, customer: '试验店', items: [mismatched] }, true).items[0].amountCents, null);
});

test('picked products with absent or different units keep their alignment and never use another price', () => {
  const rows = variants([
    record({ code: 'P1', brand: '', unit: '箱', price: '9' }),
    record({ code: 'P1', variant: '2', brand: '', unit: '盒', price: '3' }),
    record({ code: 'P2', brand: '', unit: '', price: '2.50' }),
    record({ code: 'P3', brand: '西味', unit: '盒', price: '5', status: '已下架' }),
  ]);
  const draft = line();
  assert.equal(matchCatalogItem(draft, rows).status, 'ambiguous');
  for (const [variant, status, hint] of [
    [rows[1], 'unit_mismatch', '库内仅记 盒 ¥3.00'],
    [rows[2], 'unit_mismatch', '库内仅记 ¥2.50（未标箱价）'],
    [rows[3], 'discontinued', '已下架，请核实库存。 库内仅记 盒 ¥5.00'],
  ]) {
    const selected = resolveCatalogAutoPrice(draft, matchCatalogChoice(draft, variant));
    assert.deepEqual([selected.product, selected.brand, selected.specification, selected.unit],
      [variant.product, variant.brand, variant.specification, draft.unit]);
    assert.deepEqual([selected.catalogProductId, selected.catalogVariantId, selected.catalogStatus, selected.price, selected.priceSource, selected.priceHint],
      [variant.productId, null, status, null, null, hint]);
    const updated = priceFor({ ...selected, quantity: '4' }, rows);
    assert.deepEqual([updated.catalogProductId, updated.catalogStatus, updated.price, updated.priceHint],
      [variant.productId, status, null, hint]);
    for (const priceSource of ['spoken', 'manual']) {
      const priced = resolveCatalogAutoPrice({ ...draft, price: '8.80', priceSource }, matchCatalogChoice(draft, variant));
      assert.deepEqual([priced.price, priced.priceSource], ['8.80', priceSource]);
    }
  }
  assert.equal(matchCatalogItem({ ...draft, catalogProductId: rows[2].productId }, rows).status, 'unit_mismatch');
});

test('catalog history uses completed delivery, actual receipt, strict variant/unit and latest sheet conflict', () => {
  const rows = variants([record()]);
  const variant = rows[0];
  const sale = (extra = {}) => ({
    customerId: 'one', tripId: 'trip-one', sheetId: 'sheet-one', issuedAt: '2026-01-01T00:00:00.000001Z',
    linePosition: 0, productName: variant.product, brand: variant.brand, spec: '120克', unit: '箱',
    receivedQuantity: 2, unitPriceCents: 501, deliveryCompleted: true, ...extra,
  });
  const sales = [
    sale(), sale({ customerId: 'two', unitPriceCents: 200, issuedAt: '2026-01-05T00:00:00Z' }),
    sale({ deliveryCompleted: false, unitPriceCents: 300, issuedAt: '2026-01-06T00:00:00Z' }),
    sale({ receivedQuantity: 0, unitPriceCents: 310, issuedAt: '2026-01-07T00:00:00Z' }),
    sale({ catalogVariantId: 'other', unitPriceCents: 400, issuedAt: '2026-01-08T00:00:00Z' }),
    sale({ unit: '盒', unitPriceCents: 410, issuedAt: '2026-01-09T00:00:00Z' }),
  ];
  assert.equal(priceFor(line(), rows, 'one', sales).price, '5.01');
  assert.equal(priceFor(line(), rows, 'one', sales).priceSource, 'customer_history');
  assert.equal(priceFor(line(), rows, null, sales).price, '6.01');
  assert.equal(priceFor(line({ price: '9', priceSource: 'spoken' }), rows, 'one', sales).price, '9');
  const modern = sale({ catalogVariantId: variant.variantId, productName: '改名前的旧货名', tripId: 'newer',
    issuedAt: '2026-01-02T00:00:00Z', unitPriceCents: 480 });
  assert.equal(priceFor(line(), rows, 'one', [...sales, modern]).price, '4.80');
  const conflict = [modern, { ...modern, linePosition: 1, unitPriceCents: 470 }];
  const noPrice = priceFor(line(), rows, 'one', [...sales, ...conflict]);
  assert.equal(noPrice.price, null);
  assert.match(noPrice.priceHint, /多个成交价/);
  const request = { productName: variant.product, brand: variant.brand, spec: '120克', unit: '箱', catalogVariantId: variant.variantId };
  assert.equal(lookupDeliveredPrice(sales, 'one', request).unitPriceCents, 501);
  assert.equal(lookupHistoricalPrice(sales.slice(0, 3), 'one', request).unitPriceCents, 300);

  const item = { ...line({ price: '5.01', catalogVariantId: variant.variantId }), unitPriceCents: 501 };
  const historical = { tripId: 'trip', sheetId: 'sheet', issuedAt: sale().issuedAt, customerId: 'one', reviewed: true,
    deliveryCompleted: true, customer: { items: [item, { ...item, id: 'zero' }, { ...item, id: 'pending' }] },
    statuses: { pending: 'pending' }, edits: { zero: { receivedQuantity: 0 } } };
  assert.deepEqual(collectHistoricalSales([historical]).map(row => [row.catalogVariantId, row.receivedQuantity]), [[variant.variantId, 2]]);
});

test('catalog homophones share exact pricing guards and near matches only suggest a choice', () => {
  const rows = variants([
    record({ code: '013', original: '亚渔芝心虾球160g', brand: '亚渔', product: '芝心虾球', packaging: '160g',
      unit: '盒', price: '10', remarks: '包装全称「亚洲渔港」' }),
    record({ code: '013', variant: '2', original: '亚渔芝心虾球160g', brand: '亚渔', product: '芝心虾球', packaging: '160g',
      price: '190', remarks: '包装全称「亚洲渔港」' }),
    ...['芹菜猪肉', '白菜猪肉', '酸菜猪肉', '牛肉', '三鲜', '香菇猪肉', '韭菜鸡蛋', '猪肉'].map((spec, index) =>
      record({ code: '142', variant: String(index + 1), original: '益家德手工水饺500g', brand: '益家德', product: '手工水饺',
        packaging: '500g', spec, unit: '包', price: '5' })),
    record({ code: '041', original: '德炎龙虾尾4.5kg', brand: '德炎', product: '龙虾尾', packaging: '4.5kg',
      unit: '', price: '145', status: '已下架' }),
    record({ code: '002', original: '巧总管响铃卷120g', brand: '巧总管', product: '响铃卷', packaging: '120g', unit: '', price: '6' }),
    record({ code: '049', original: '渔家姑娘龙虾尾4.5kg', brand: '渔家姑娘', product: '龙虾尾', packaging: '4.5kg', price: '120' }),
  ]);
  assert.deepEqual(toPinyinTokens(' 知心虾球，１６０g '), ['zhi', 'xin', 'xia', 'qiu', '1', '6', '0', 'g']);
  assert.deepEqual(toFuzzyPinyinTokens('南蓝，山三，陈程，林灵'), ['lan', 'lan', 'san', 'san', 'cen', 'cen', 'lin', 'lin']);
  assert.notDeepEqual(toPinyinTokens('绿'), toPinyinTokens('路'));
  assert.equal(pinyinSimilarity('芝心虾球', '芝心虾球'), 1);

  const shrimp = line({ product: '知心虾球' });
  const aligned = priceFor(shrimp, rows);
  assert.deepEqual([aligned.product, aligned.brand, aligned.specification, aligned.price, aligned.priceSource, aligned.catalogStatus],
    ['芝心虾球', '亚渔', '160g', '190.00', 'catalog', 'active']);
  assert.equal(matchCatalogItem(shrimp, rows).matchMethod, 'homophone');
  assert.equal(priceFor({ ...shrimp, unit: '袋' }, rows).price, null);
  assert.equal(matchCatalogItem({ ...shrimp, specification: '161g' }, rows).status, 'unmatched');
  assert.equal(matchCatalogItem({ ...shrimp, catalogProductId: '013' }, rows).status, 'unmatched');
  assert.equal(matchCatalogItem({ ...shrimp, catalogVariantId: '013/2' }, rows).status, 'unmatched');
  assert.equal(matchCatalogItem({ ...shrimp, catalogStatus: 'external' }, rows).status, 'external');
  const changedSize = matchCatalogItem(line({ product: '试制知心虾球45g' }), variants([
    record({ original: '试制芝心虾球4.5g', product: '试制芝心虾球', packaging: '4.5g', price: '190' }),
  ]));
  assert.notEqual(changedSize.status, 'active');

  for (const input of [{ product: '手工水饺', brand: '易家得' }, { product: '易家得手工水饺' }]) {
    const row = line({ ...input, unit: '包', quantity: '5' });
    const match = matchCatalogItem(row, rows);
    assert.equal(match.status, 'ambiguous');
    assert.equal(match.matchMethod, 'homophone');
    assert.equal(match.candidates.length, 8);
    assert.equal(priceFor(row, rows).price, null);
  }
  for (const input of [{ product: '龙虾尾', brand: '德盐' }, { product: '德盐龙虾尾' }]) {
    const row = priceFor(line({ ...input, quantity: '1' }), rows);
    assert.equal(row.catalogStatus, 'discontinued');
    assert.equal(row.price, null);
    assert.match(row.priceHint, /已下架.*未标箱价/);
  }
  for (const [input, expected] of [
    [{ brand: '乔总管', product: '想卷帘' }, '响铃卷'],
    [{ product: '乔总管想卷帘' }, '响铃卷'],
    [{ product: '巧总管想卷帘' }, '响铃卷'],
    [{ product: '芝心虾' }, '芝心虾球'],
  ]) {
    const row = line({ ...input, price: '99', priceSource: 'spoken' });
    const match = matchCatalogItem(row, rows);
    assert.equal(match.status, 'ambiguous');
    assert.equal(match.matchMethod, 'similar');
    assert.ok(match.candidates.some(candidate => candidate.product === expected));
    assert.match(match.hint, /未完全对上/);
    assert.equal(priceFor(row, rows).price, null);
  }
  for (const product of ['新到带鱼', '新道带鱼', '临时冻虾', '灵石冻虾', '带鱼', '冻虾', '羊肉', '虾']) {
    const row = priceFor(line({ product }), rows);
    assert.deepEqual([row.catalogStatus, row.price], ['unmatched', null], product);
  }
});

test('reuse of a catalog variant ID after a packaging change does not reuse the delivered price', () => {
  const [oldVariant] = variants([record({ packaging: '500g' })]);
  const updated = variants([record({ packaging: '1kg', price: '9.25' })]);
  assert.equal(oldVariant.variantId, updated[0].variantId);
  const sales = [{
    customerId: 'one', tripId: 'trip', sheetId: 'sheet', issuedAt: '2026-01-01T00:00:00Z', linePosition: 0,
    catalogVariantId: oldVariant.variantId, productName: oldVariant.product, brand: oldVariant.brand,
    spec: '500克', unit: oldVariant.unit, receivedQuantity: 2, unitPriceCents: 501, deliveryCompleted: true,
  }];
  assert.equal(priceFor(line(), [oldVariant], 'one', sales).priceSource, 'customer_history');
  const current = priceFor(line(), updated, 'one', sales);
  assert.deepEqual([current.price, current.priceSource], ['9.25', 'catalog']);
});

test('catalog crosses soft spec slots but locks weight, flavor and unit hard slots', () => {
  const rows = variants([
    record({ code: 'Q1', original: '安井锁鲜鱼豆腐240g', brand: '安井', product: '锁鲜鱼豆腐', packaging: '240g',
      unit: '箱', price: '88' }),
    record({ code: 'Q2', original: '安井包心鱼豆腐2.5kg', brand: '安井', product: '包心鱼豆腐', packaging: '2.5kg',
      unit: '箱', price: '150' }),
    record({ code: 'Q3', original: '某厂尊宴羔羊肉片400g', brand: '某厂', product: '尊宴羔羊肉片', packaging: '400g',
      unit: '箱', price: '100' }),
    record({ code: 'Q3', variant: '2', original: '某厂尊宴羔羊肉片1kg', brand: '某厂', product: '尊宴羔羊肉片',
      packaging: '1kg', unit: '箱', price: '200' }),
    record({ code: 'Q4', original: '甲厂锁鲜鱼子福袋150g', brand: '甲厂', product: '锁鲜鱼子福袋', packaging: '150g',
      unit: '箱', price: '70' }),
    record({ code: 'Q5', original: '甲厂鱼籽福袋2.5kg', brand: '甲厂', product: '鱼籽福袋', packaging: '2.5kg',
      unit: '箱', price: '210' }),
    record({ code: 'Q6', original: '甲牌糯米烧麦1kg', brand: '甲牌', product: '糯米烧麦', packaging: '1kg',
      unit: '袋', price: '30' }),
    record({ code: 'Q7', original: '甲牌锁鲜松叶蟹味棒250g', brand: '甲牌', product: '锁鲜松叶蟹味棒', packaging: '250g',
      unit: '袋', price: '45' }),
    record({ code: 'Q8', original: '三全豆沙春卷300g', brand: '三全', product: '豆沙春卷', packaging: '300g',
      unit: '袋', price: '12' }),
    record({ code: 'Q9', original: '甲牌馄饨400g', brand: '甲牌', product: '馄饨', packaging: '400g',
      spec: '荠菜猪肉', unit: '袋', price: '20' }),
    record({ code: 'Q9', variant: '2', original: '甲牌馄饨400g', brand: '甲牌', product: '馄饨', packaging: '400g',
      spec: '香菇猪肉', unit: '袋', price: '22' }),
  ]);

  // A series modifier may sit in specification, inside the product name, or in the brand prefix.
  for (const input of [
    { brand: '安井', product: '鱼豆腐', specification: '锁鲜装' },
    { brand: '安井', product: '锁鲜装鱼豆腐' },
    { brand: '安井锁鲜装', product: '鱼豆腐' },
  ]) {
    const priced = priceFor(line(input), rows);
    assert.deepEqual([priced.product, priced.brand, priced.specification, priced.price, priced.priceSource],
      ['锁鲜鱼豆腐', '安井', '240g', '88.00', 'catalog'], JSON.stringify(input));
  }
  // A series word merged into the brand becomes part of the product name.
  const lamp = priceFor(line({ brand: '某厂尊宴', product: '羔羊肉片', specification: '1千克' }), rows);
  assert.deepEqual([lamp.product, lamp.brand, lamp.specification, lamp.price],
    ['尊宴羔羊肉片', '某厂', '1kg', '200.00']);
  const noWeight = matchCatalogItem(line({ brand: '某厂尊宴', product: '羔羊肉片' }), rows);
  assert.equal(noWeight.status, 'ambiguous');
  assert.equal(priceFor(line({ brand: '某厂尊宴', product: '羔羊肉片' }), rows).price, null);
  // Homophones may still use the soft series word to select the right package.
  const bag = priceFor(line({ brand: '甲厂', product: '鱼籽福袋', specification: '锁鲜装' }), rows);
  assert.deepEqual([bag.product, bag.specification, bag.price, matchCatalogItem(
    line({ brand: '甲厂', product: '鱼籽福袋', specification: '锁鲜装' }), rows).matchMethod],
  ['锁鲜鱼子福袋', '150g', '70.00', 'homophone']);

  // A hard weight cannot be traded for a similar one.
  assert.equal(matchCatalogItem(line({ brand: '安井', product: '鱼豆腐', specification: '500g' }), rows).status,
    'unmatched');
  const kiloOnly = rows.filter(row => row.product !== '尊宴羔羊肉片' || row.packaging === '1kg');
  assert.equal(matchCatalogItem(line({ brand: '某厂尊宴', product: '羔羊肉片', specification: '400g' }), kiloOnly)
    .status, 'unmatched');
  assert.equal(priceFor(line({ brand: '安井', product: '鱼豆腐', specification: '500g' }), rows).price, null);

  // An unknown flavor is never silently dropped.
  const spicy = matchCatalogItem(line({ brand: '安井', product: '鱼豆腐', specification: '麻辣' }), rows);
  assert.deepEqual([spicy.status, priceFor(line({ brand: '安井', product: '鱼豆腐', specification: '麻辣' }), rows).price],
    ['unmatched', null]);
  assert.equal(matchCatalogItem(line({ brand: '甲牌', product: '馄饨' }), rows).status, 'ambiguous');
  assert.equal(priceFor(line({ brand: '甲牌', product: '馄饨' }), rows).price, null);
  const flavorMismatch = priceFor(line({ brand: '甲牌', product: '馄饨', specification: '荠菜猪肉', unit: '箱' }), rows);
  assert.deepEqual([flavorMismatch.catalogStatus, flavorMismatch.price], ['unit_mismatch', null]);
  assert.match(flavorMismatch.priceHint, /库内仅记 袋 ¥20\.00/);

  // Unit mismatch always leaves the price empty with a reference hint.
  const unitMismatch = priceFor(line({ brand: '安井', product: '鱼豆腐', specification: '锁鲜装', unit: '盒' }), rows);
  assert.deepEqual([unitMismatch.catalogStatus, unitMismatch.price], ['unit_mismatch', null]);
  assert.match(unitMismatch.priceHint, /库内仅记 箱 ¥88\.00/);

  // A known brand plus a short name only suggests a choice, never a price.
  for (const [input, product] of [
    [{ brand: '甲牌', product: '烧卖' }, '糯米烧麦'],
    [{ brand: '甲牌', product: '蟹味棒', specification: '锁鲜装' }, '锁鲜松叶蟹味棒'],
  ]) {
    const match = matchCatalogItem(line({ ...input, unit: '袋' }), rows);
    assert.equal(match.status, 'ambiguous', JSON.stringify(input));
    assert.equal(match.matchMethod, 'similar');
    assert.ok(match.candidates.some(candidate => candidate.product === product));
    assert.equal(priceFor(line({ ...input, unit: '袋' }), rows).price, null);
  }
  for (const input of [
    { product: '奶香芝士棒', unit: '袋' }, { brand: '三全', product: '豆沙包', unit: '袋' },
    { brand: '乙牌', product: '玉米水饺', unit: '袋' }, { product: '新到带鱼', unit: '箱' },
    { product: '临时冻虾', unit: '箱' }, { product: '鱼丸', unit: '袋' }, { product: '虾肉', unit: '袋' },
  ]) {
    const priced = priceFor(line(input), rows);
    assert.deepEqual([priced.catalogStatus, priced.price], ['unmatched', null], JSON.stringify(input));
  }
  // Numeric specs must not swallow adjacent non-unit Chinese flavor or product words.
  assert.deepEqual(parseSpecTokens('40-50虾仁'), {
    fullDetail: '40-50虾仁', hardSpecs: ['40-50'], textSpecs: ['虾仁'], tokens: ['40-50', '虾仁'],
  });
  assert.deepEqual(parseSpecTokens('9寸披萨'), {
    fullDetail: '9寸披萨', hardSpecs: ['9寸'], textSpecs: ['披萨'], tokens: ['9寸', '披萨'],
  });
  // Parenthetical notes in catalog packaging normalize cleanly and still match the hard weight.
  const notedRows = variants([record({ code: 'N1', brand: '甲厂', product: '锁鲜鱼籽包', packaging: '240g(详情页标240克)', unit: '袋', price: '9.80' })]);
  assert.equal(notedRows[0].specification, '240g');
  const noted = priceFor(line({ brand: '甲厂', product: '鱼籽包', specification: '锁鲜装 240g', unit: '袋' }), notedRows);
  assert.deepEqual([noted.catalogStatus, noted.price], ['active', '9.80']);
  const legacyNoted = priceFor(line({ brand: '甲厂', product: '锁鲜鱼籽包', specification: '240g(详情页标240g)', unit: '袋' }), notedRows);
  assert.deepEqual([legacyNoted.catalogStatus, legacyNoted.price], ['active', '9.80']);
});

test('quoted price evidence belongs to the specified item, customer and unit', () => {
  const carrot = { products: ['香菇丸'], customers: ['甲店'], unit: '箱' };
  const duplicate = { ...carrot, customers: ['乙店'] };
  const other = { products: ['荠菜饺'], customers: ['甲店'], unit: '盒' };
  const candidates = [carrot, duplicate, other];
  const source = '甲店香菇丸2箱，八十二一箱，荠菜饺2盒按六块；乙店香菇丸3箱，90元';
  assert.equal(hasQuotedLinePrice(source, 8200, carrot, candidates), true);
  assert.equal(hasQuotedLinePrice(source, 8200, duplicate, candidates), false);
  assert.equal(hasQuotedLinePrice(source, 8200, other, candidates), false);
  assert.equal(hasQuotedLinePrice(source, 600, other, candidates), true);
  assert.equal(hasQuotedLinePrice(source, 9000, duplicate, candidates), true);
  assert.equal(hasQuotedLinePrice('甲店香菇丸要82箱', 8200, carrot), false);
  assert.equal(hasQuotedLinePrice('甲店香菇丸80元/盒', 8000, carrot), false);
});

test('totals are ignored and both price units must agree with the ordered unit', () => {
  const boxes = { products: ['临时肠'], customers: ['甲店'], unit: '箱' };
  for (const label of ['一共', '总共是', '合计为', '总计收', '共计算', '总价付', '总金额', '共收', '共要', '总共算', '一共算', '共卖']) {
    assert.deepEqual(quotedLinePrices(`甲店临时肠两箱，${label}￥80元`, boxes), [], label);
  }
  assert.deepEqual(quotedLinePrices('甲店临时肠两箱，单价40元，一共八十元', boxes), [4000]);
  const rollBoxes = { products: ['香酥卷'], unit: '箱' };
  const rollBags = { ...rollBoxes, unit: '袋' };
  const candidates = [rollBoxes, rollBags];
  assert.deepEqual(quotedLinePrices('香酥卷两箱，每袋10元', rollBoxes, candidates), []);
  assert.deepEqual(quotedLinePrices('香酥卷两箱，每袋单价10元', rollBoxes, candidates), []);
  assert.deepEqual(quotedLinePrices('香酥卷每 袋 10元/袋', rollBags, candidates), [1000]);
  for (const row of candidates) assert.deepEqual(quotedLinePrices('香酥卷每袋10元/箱', row, candidates), []);
  assert.deepEqual(quotedLinePrices('临时肠两箱，每袋10元，香酥卷两袋', rollBags, [boxes, rollBags]), []);
});

test('the complete brand-qualified mention owns a quote ahead of a product-name suffix', () => {
  const earlier = { products: ['鱼肉丸', '禾味鱼肉丸'], customers: ['试验店'], unit: '箱' };
  const later = { products: ['水湾鱼肉丸', '鱼肉丸'], customers: ['试验店'], unit: '箱' };
  for (const text of ['试验店水湾鱼肉丸两箱每箱12元', '试验店每箱12元水湾鱼肉丸两箱']) {
    assert.equal(hasQuotedLinePrice(text, 1200, later, [earlier, later]), true);
    assert.equal(hasQuotedLinePrice(text, 1200, earlier, [earlier, later]), false);
  }
});
