import { emptyItem } from '../../core/orders';
import { currentTrip, CustomerDraft, emptyCustomer, emptyTrip, latest, previewTrip, TripDraft } from '../../core/trips';
import { newId, trips } from '../../services/orders';
import { editLines, errorMessage, formLines, tripView } from '../order-view';

function sampleCustomer(customer: string, brand: string, quantity: string, price: string): CustomerDraft {
  const draft = emptyCustomer(newId);
  return { ...draft, customer, items: [{ ...draft.items[0], product: '水饺', brand, specification: '500g', quantity, price }] };
}

Page({
  data: {
    draft: emptyTrip(() => 'loading'), activeId: '', active: null as CustomerDraft | null,
    form: [] as ReturnType<typeof formLines>,
    previewTrip: null as (ReturnType<typeof tripView> & { id: string; revision: number }) | null,
    confirmed: null as (ReturnType<typeof tripView> & { version: number }) | null,
    error: '', loaded: false,
  },

  onLoad() { this.reload(); },
  onShow() { if (this.data.confirmed) this.reload(); },

  reload() {
    try {
      const state = trips.load();
      const current = currentTrip(state);
      const version = current?.id === state.draft.id ? latest(current) : null;
      this.showDraft(state.draft, state.draft.customers[0].id);
      this.setData({ confirmed: version ? { ...tripView(version), version: version.version } : null, previewTrip: null, loaded: true, error: '' });
    } catch (error) { this.fail(error); }
  },

  fail(error: unknown) { this.setData({ error: errorMessage(error) }); },

  showDraft(draft: TripDraft, activeId: string) {
    const active = draft.customers.find(customer => customer.id === activeId) ?? draft.customers[0];
    this.setData({ draft, activeId: active.id, active, form: formLines(active.items) });
  },

  persist(draft: TripDraft, activeId?: string) {
    activeId ??= this.data.activeId;
    this.showDraft(draft, activeId);
    this.setData({ previewTrip: null });
    try {
      this.showDraft(trips.saveDraft(draft), activeId);
      this.setData({ error: '' });
    } catch (error) { this.fail(error); }
  },

  selectCustomer(event: WechatMiniprogram.TouchEvent) {
    this.showDraft(this.data.draft, event.currentTarget.dataset.id);
  },

  addCustomer() {
    const customer = emptyCustomer(newId);
    const { draft } = this.data;
    this.persist({ ...draft, customers: [...draft.customers, customer] }, customer.id);
  },

  removeCustomer() {
    const { draft, activeId } = this.data;
    if (draft.customers.length === 1) return;
    this.persist({ ...draft, customers: draft.customers.filter(customer => customer.id !== activeId) });
  },

  editActive(active: CustomerDraft) {
    const { draft } = this.data;
    this.persist({ ...draft, customers: draft.customers.map(customer => customer.id === active.id ? active : customer) });
  },

  editCustomer(event: WechatMiniprogram.Input) {
    const { active } = this.data;
    if (active && active.id === event.currentTarget.dataset.id) this.editActive({ ...active, customer: event.detail.value });
  },

  editItem(event: WechatMiniprogram.Input) {
    const { active } = this.data;
    const { id, field } = event.currentTarget.dataset;
    if (active) this.editActive({ ...active, items: editLines(active.items, id, field, event.detail.value) });
  },

  addItem() {
    const { active } = this.data;
    if (active) this.editActive({ ...active, items: [...active.items, emptyItem(newId())] });
  },

  removeItem(event: WechatMiniprogram.TouchEvent) {
    const { active } = this.data;
    if (!active || active.items.length === 1) return;
    this.editActive({ ...active, items: active.items.filter(item => item.id !== event.currentTarget.dataset.id) });
  },

  fillSample() {
    const a = sampleCustomer('客户 A', '安井', '2', '82');
    const b = sampleCustomer('客户 B', '安井', '3', '80');
    b.items.push({ ...b.items[0], id: newId(), unit: '袋', price: '20' });
    const c = sampleCustomer('客户 C', '三全', '1', '75');
    this.persist({ ...this.data.draft, customers: [a, b, c] }, a.id);
  },

  showPreview() {
    try {
      const draft = trips.saveDraft(this.data.draft);
      this.showDraft(draft, this.data.activeId);
      const preview = tripView(previewTrip(draft));
      this.setData({ previewTrip: { ...preview, id: draft.id, revision: draft.revision }, error: '' });
    } catch (error) { this.fail(error); }
  },

  backToEdit() { this.setData({ previewTrip: null, error: '' }); },

  confirmTrip() {
    const preview = this.data.previewTrip;
    if (!preview) return;
    try {
      trips.confirm(preview.id, preview.revision);
      this.reload();
    } catch (error) { this.fail(error); }
  },

  nextTrip() {
    try {
      trips.startNext();
      this.reload();
    } catch (error) { this.fail(error); }
  },

  resetDemo() {
    wx.showModal({ title: '重置本地演示数据', content: '将清除本机草稿、正式单据和配送状态，是否继续？', success: result => {
      if (!result.confirm) return;
      try { trips.reset(); this.reload(); } catch (error) { this.fail(error); }
    } });
  },
});
