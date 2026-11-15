import { Draft, emptyItem, initialState, ItemInput, money, Order, preview } from '../../core/orders';
import { newId, orders } from '../../services/orders';
function displayOrder(order: Order) {
  return { ...order, total: money(order.totalCents), items: order.items.map(item => ({ ...item, amount: money(item.amountCents) })) };
}
Page({
  data: {
    draft: initialState('loading').draft,
    previewOrder: null as ReturnType<typeof displayOrder> | null,
    confirmedOrder: null as ReturnType<typeof displayOrder> | null,
    error: '', loaded: false,
  },
  onLoad() {
    try {
      this.refresh();
    } catch (error) { this.fail(error); }
  },
  refresh() {
    const state = orders.load();
    const confirmed = state.orders.find(order => order.id === state.draft.id);
    this.setData({ draft: state.draft, confirmedOrder: confirmed ? displayOrder(confirmed) : null, previewOrder: null, error: '', loaded: true });
  },
  fail(error: unknown) {
    this.setData({ error: error instanceof Error ? error.message : '操作失败，请重试' });
  },
  persist(draft: Draft) {
    this.setData({ draft, previewOrder: null });
    try {
      const state = orders.save(draft);
      this.setData({ draft: state.draft, error: '' });
    } catch (error) { this.fail(error); }
  },
  editCustomer(event: WechatMiniprogram.Input) {
    this.persist({ ...this.data.draft, customer: event.detail.value });
  },
  editItem(event: WechatMiniprogram.Input) {
    const { index, field } = event.currentTarget.dataset;
    const fields: (keyof ItemInput)[] = ['product', 'brand', 'specification', 'unit', 'quantity', 'price'];
    if (!fields.includes(field)) return;
    const items = this.data.draft.items.map((item, position) => position === Number(index) ? { ...item, [field]: event.detail.value } : item);
    this.persist({ ...this.data.draft, items });
  },
  addItem() { this.persist({ ...this.data.draft, items: [...this.data.draft.items, emptyItem(newId())] }); },
  removeItem(event: WechatMiniprogram.TouchEvent) {
    if (this.data.draft.items.length === 1) return;
    this.persist({ ...this.data.draft, items: this.data.draft.items.filter((_, index) => index !== Number(event.currentTarget.dataset.index)) });
  },
  fillSample() {
    this.persist({ ...this.data.draft, customer: '客户 A', items: [{ ...emptyItem(newId()), product: '水饺', brand: '安井', specification: '500g', quantity: '2', price: '82' }] });
  },
  showPreview() {
    try {
      const state = orders.save(this.data.draft);
      this.setData({ draft: state.draft });
      this.setData({ previewOrder: displayOrder(preview(state.draft)), error: '' });
    } catch (error) { this.fail(error); }
  },
  backToEdit() { this.setData({ previewOrder: null }); },
  confirmOrder() {
    const current = this.data.previewOrder;
    if (!current) return;
    try { orders.confirm(current.id, current.revision); this.refresh(); } catch (error) { this.fail(error); }
  },
  nextOrder() {
    try { orders.startNext(); this.refresh(); } catch (error) { this.fail(error); }
  },
  resetDemo() {
    wx.showModal({ title: '重置本地演示数据', content: '将清除本机演示草稿和正式单据，是否继续？', success: result => {
      if (!result.confirm) return;
      try { orders.reset(); this.refresh(); } catch (error) { this.fail(error); }
    } });
  },
});
