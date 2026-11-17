// Synthetic delivery inputs and independently enumerated answers, in yuan and original units.
module.exports = {
  version: 's6-cases-v1',
  initial: '老王要两箱安井水饺 500g',
  supplement: '单价82元一箱',
  ambiguous: '老王水饺三箱',
  remaining: '小李要安井水饺500g，3箱每箱80元，再要同款3袋每袋20元。赵记另要三全水饺500g一箱，每箱75元。',
  expected: [
    ['老王', '水饺', '安井', '500g', '箱', '2', '82'],
    ['小李', '水饺', '安井', '500g', '箱', '3', '80'],
    ['小李', '水饺', '安井', '500g', '袋', '3', '20'],
    ['赵记', '水饺', '三全', '500g', '箱', '1', '75'],
  ],
  orderCents: 53900,
  customerOrderCents: [16400, 30000, 7500],
  picking: [['安井', '箱', 5], ['安井', '袋', 3], ['三全', '箱', 1]],
  dueA: 16400,
  partialDueB: 24000,
};
