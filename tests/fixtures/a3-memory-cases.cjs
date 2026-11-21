// A3 记忆场景题库。固定模式直接使用 fixture 里的 edit_draft 操作，
// 客户名按原话里的叫法填写；真实模式由模型自行整理。
const sale = (fields = {}) => ({
  product: '水饺', brand: '', specification: '', unit: '箱', quantity: '2', price: '80', ...fields,
});
const add = (customer, product, quantity = '2', extra = {}) =>
  ({ action: 'add', customer, product, quantity, unit: '箱', ...extra });
const edit = (...operations) => ['edit_draft', { operations }];
const line = (product, { quantity = '2', price = null, unit = '箱' } = {}) => ({ product, quantity, price, unit });

const cases = [
  {
    id: 'remembered-alias',
    customers: [{ name: '王记餐饮', aliases: ['老王'], history: [sale()] }],
    turns: [{
      text: '老王要两箱水饺',
      fixture: edit(add('老王', '水饺', '2')),
      expect: {
        links: [{ spoken: '老王', canonicalName: '王记餐饮', matchedBy: 'alias', merged: false }],
        customers: [{ name: '王记餐饮', party: 'linked', items: [line('水饺')] }],
        questions: false,
        mentions: [],
        suggestion: { product: '水饺', status: 'exact_match', unitPriceCents: 8000 },
        change: /老王 → 王记餐饮（记住的叫法）/,
      },
    }],
  },
  {
    id: 'canonical-name',
    customers: [{ name: '王记餐饮', history: [sale()] }],
    turns: [{
      text: '王记餐饮要两箱水饺',
      fixture: edit(add('王记餐饮', '水饺', '2')),
      expect: {
        links: [{ spoken: '王记餐饮', canonicalName: '王记餐饮', matchedBy: 'canonical', merged: false }],
        customers: [{ name: '王记餐饮', party: 'linked', items: [line('水饺')] }],
        questions: false,
        mentions: [],
        suggestion: { product: '水饺', status: 'exact_match', unitPriceCents: 8000 },
        change: /王记餐饮：认出熟客/,
      },
    }],
  },
  {
    id: 'new-call-name',
    customers: [{ name: '王记餐饮', aliases: ['老王'], history: [sale()] }],
    turns: [{
      text: '阿强一箱馄饨',
      fixture: edit(add('阿强', '馄饨', '1')),
      expect: {
        links: [],
        customers: [{ name: '阿强', party: 'pending', items: [line('馄饨', { quantity: '1' })] }],
        questions: true,
        mentions: [{ name: '阿强', status: 'new_customer', candidates: [] }],
        change: /阿强：待选店/,
      },
    }],
  },
  {
    id: 'similar-name',
    customers: [
      { name: '王记餐饮', history: [sale()] },
      { name: '王记酒楼', history: [sale({ product: '馄饨', price: '70' })] },
    ],
    turns: [{
      text: '王记两箱水饺',
      fixture: edit(add('王记', '水饺', '2')),
      expect: {
        links: [],
        customers: [{ name: '王记', party: 'pending', items: [line('水饺')] }],
        questions: true,
        mentions: [{ name: '王记', status: 'candidate_only', candidates: ['王记酒楼', '王记餐饮'] }],
        change: /王记：待选店/,
      },
    }],
  },
  {
    id: 'name-collision',
    customers: [
      { name: '王记餐饮', aliases: [{ alias: '老王', allowCanonicalConflict: true }], history: [sale()] },
      { name: '老王', history: [sale({ product: '馄饨', price: '70' })] },
    ],
    turns: [{
      text: '老王两箱水饺',
      fixture: edit(add('老王', '水饺', '2')),
      expect: {
        links: [],
        customers: [{ name: '老王', party: 'pending', items: [line('水饺')] }],
        questions: true,
        mentions: [{ name: '老王', status: 'ambiguous', candidates: ['王记餐饮', '老王'] }],
        change: /老王：待选店/,
      },
    }],
  },
  {
    id: 'normalized-alias',
    customers: [{ name: '肯德基', aliases: ['ＫＦＣ'], history: [sale({ product: '薯条', price: '60' })] }],
    turns: [{
      text: 'kfc 两箱薯条',
      fixture: edit(add('kfc', '薯条', '2')),
      expect: {
        links: [{ spoken: 'kfc', canonicalName: '肯德基', matchedBy: 'alias', merged: false }],
        customers: [{ name: '肯德基', party: 'linked', items: [line('薯条')] }],
        questions: false,
        mentions: [],
        suggestion: { product: '薯条', status: 'exact_match', unitPriceCents: 6000 },
        change: /kfc → 肯德基（记住的叫法）/,
      },
    }],
  },
  {
    id: 'two-customers',
    customers: [{ name: '王记餐饮', aliases: ['老王'], history: [sale()] }],
    turns: [{
      text: '老王两箱水饺，阿强一箱汤圆',
      fixture: edit(add('老王', '水饺', '2'), add('阿强', '汤圆', '1')),
      expect: {
        links: [{ spoken: '老王', canonicalName: '王记餐饮', matchedBy: 'alias', merged: false }],
        customers: [
          { name: '王记餐饮', party: 'linked', items: [line('水饺')] },
          { name: '阿强', party: 'pending', items: [line('汤圆', { quantity: '1' })] },
        ],
        questions: true,
        mentions: [{ name: '阿强', status: 'new_customer', candidates: [] }],
      },
    }],
  },
  {
    id: 'merge-existing',
    customers: [{ name: '王记餐饮', aliases: ['老王'], history: [sale()] }],
    draft: [{ customer: '王记餐饮', party: '王记餐饮', items: [line('水饺')] }],
    turns: [{
      text: '老王再加一箱春卷',
      fixture: edit(add('老王', '春卷', '1')),
      expect: {
        allowDirectExistingCustomer: true,
        links: [{ spoken: '老王', canonicalName: '王记餐饮', matchedBy: 'alias', merged: true }],
        customers: [{
          name: '王记餐饮', party: 'linked',
          items: [line('水饺'), line('春卷', { quantity: '1' })],
        }],
        questions: false,
        mentions: [],
        suggestion: { product: '水饺', status: 'exact_match', unitPriceCents: 8000 },
        change: /老王 → 王记餐饮（并入同一家）/,
      },
    }],
  },
  {
    id: 'previous-price',
    customers: [{ name: '王记餐饮', aliases: ['老王'], history: [sale({ price: '80' }), sale({ price: '82' })] }],
    turns: [{
      text: '老王两箱水饺',
      fixture: edit(add('老王', '水饺', '2')),
      expect: {
        links: [{ spoken: '老王', canonicalName: '王记餐饮', matchedBy: 'alias', merged: false }],
        customers: [{ name: '王记餐饮', party: 'linked', items: [line('水饺')] }],
        questions: false,
        mentions: [],
        suggestion: { product: '水饺', status: 'exact_match', unitPriceCents: 8200, previousDistinctPrice: 8000 },
      },
    }],
  },
  {
    id: 'variant-prices',
    customers: [{
      name: '王记餐饮', aliases: ['老王'],
      history: [
        sale({ brand: '三全', specification: '1kg', price: '75' }),
        sale({ brand: '安井', specification: '500g', price: '82' }),
      ],
    }],
    turns: [{
      text: '老王两箱水饺',
      fixture: edit(add('老王', '水饺', '2')),
      expect: {
        links: [{ spoken: '老王', canonicalName: '王记餐饮', matchedBy: 'alias', merged: false }],
        customers: [{ name: '王记餐饮', party: 'linked', items: [line('水饺')] }],
        questions: false,
        mentions: [],
        suggestion: {
          product: '水饺', status: 'ambiguous_variants',
          candidates: [['安井', '500g', 8200], ['三全', '1kg', 7500]],
        },
      },
    }],
  },
  {
    id: 'spoken-price',
    customers: [{ name: '王记餐饮', aliases: ['老王'], history: [sale({ price: '82' })] }],
    turns: [{
      text: '老王两箱水饺八十五一箱',
      spokenPrices: ['85'],
      fixture: edit(add('老王', '水饺', '2', { price: '85' })),
      expect: {
        links: [{ spoken: '老王', canonicalName: '王记餐饮', matchedBy: 'alias', merged: false }],
        customers: [{ name: '王记餐饮', party: 'linked', items: [line('水饺', { price: 85 })] }],
        questions: false,
        mentions: [],
        suggestion: null,
      },
    }],
  },
  {
    id: 'no-known-customers',
    customers: [],
    turns: [{
      text: '阿强一箱汤圆',
      fixture: edit(add('阿强', '汤圆', '1')),
      expect: {
        links: [],
        customers: [{ name: '阿强', party: 'new', items: [line('汤圆', { quantity: '1' })] }],
        questions: false,
        mentions: [],
      },
    }],
  },
  {
    id: 'remember-choice-flow',
    customers: [{ name: '王记餐饮', aliases: ['老王'], history: [sale()] }],
    turns: [
      {
        text: '阿强一箱馄饨',
        fixture: edit(add('阿强', '馄饨', '1')),
        expect: {
          links: [],
          customers: [{ name: '阿强', party: 'pending', items: [line('馄饨', { quantity: '1' })] }],
          questions: true,
          mentions: [{ name: '阿强', status: 'new_customer', candidates: [] }],
          change: /阿强：待选店/,
        },
      },
      {
        choice: { spoken: '阿强', customer: '王记餐饮', remember: true },
        text: '阿强加两箱汤圆',
        fixture: edit(add('阿强', '汤圆', '2')),
        expect: {
          links: [{ spoken: '阿强', canonicalName: '王记餐饮', matchedBy: 'alias', merged: true }],
          customers: [{
            name: '王记餐饮', party: 'linked',
            items: [line('馄饨', { quantity: '1' }), line('汤圆')],
          }],
          questions: false,
          mentions: [],
          suggestion: { product: '汤圆', status: 'no_match' },
          change: /阿强 → 王记餐饮（并入同一家）/,
        },
      },
    ],
  },
];

module.exports = { cases, sale, add, edit, line };
