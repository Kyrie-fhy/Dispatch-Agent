import { emptyItem, ItemInput, money } from '../../core/orders';
import { Amendment, currentTrip, latest, Trip } from '../../core/trips';
import { generateOrderImages, saveOrderImage } from '../../services/order-images';
import { newId, trips } from '../../services/orders';
import { deliveryLabel, editLines, errorMessage, formLines, lineView } from '../order-view';

function tripSummary(trip: Trip) {
  const version = latest(trip);
  const date = new Date(trip.versions[0].savedAt);
  const openedAt = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return { id: trip.id, version: version.version, openedAt, total: money(version.totalCents),
    customers: version.customers.map(customer => ({ id: customer.id, name: customer.customer, total: money(customer.totalCents) })) };
}

type AmendmentResult = ReturnType<typeof trips.previewAmendment>;

function amendmentPreview(result: AmendmentResult) {
  return { before: money(result.original.totalCents), after: money(result.customer.totalCents),
    changes: result.changes.map(change => ({ id: change.id,
      before: change.before ? lineView(change.before) : null, after: change.after ? lineView(change.after) : null,
      beforeStatus: change.beforeStatus ? deliveryLabel[change.beforeStatus] : '',
      afterStatus: change.afterStatus ? deliveryLabel[change.afterStatus] : '',
    })), picking: result.picking };
}

function customerDetail(trip: Trip, id: string, active: boolean) {
  const version = latest(trip);
  const customer = version.customers.find(entry => entry.id === id);
  if (!customer) throw new Error('未找到该客户单据，请重新打开');
  return { tripId: trip.id, version: version.version, active, customer: customer.customer, id,
    total: money(customer.totalCents),
    items: customer.items.map(line => {
      const status = trip.statuses[line.id];
      return { ...lineView(line), delivered: status === 'delivered', label: deliveryLabel[status] };
    }),
  };
}

Page({
  data: {
    current: null as ReturnType<typeof tripSummary> | null,
    history: [] as ReturnType<typeof tripSummary>[], historyId: '',
    detail: null as ReturnType<typeof customerDetail> | null,
    amendment: null as Amendment | null,
    form: [] as ReturnType<typeof formLines>,
    preview: null as ReturnType<typeof amendmentPreview> | null,
    images: null as { customer: string; version: number; files: string[]; saved: number } | null,
    busy: false, albumSettings: false, error: '', notice: '',
  },

  onShow() { this.refresh(); },

  fail(error: unknown) { this.setData({ error: errorMessage(error), notice: '' }); },

  refresh() {
    try {
      const state = trips.load();
      const current = currentTrip(state);
      const history = state.trips.filter(trip => trip.id !== current?.id).reverse().map(tripSummary);
      const selected = this.data.detail;
      const trip = selected ? state.trips.find(entry => entry.id === selected.tripId) : null;
      this.setData({ current: current ? tripSummary(current) : null, history,
        detail: trip && selected ? customerDetail(trip, selected.id, trip.id === current?.id) : null });
      if (selected && !trip) this.setData({ amendment: null, preview: null, form: [], images: null, error: '', notice: '' });
    } catch (error) { this.fail(error); }
  },

  toggleHistory(event: WechatMiniprogram.TouchEvent) {
    const { id } = event.currentTarget.dataset;
    this.setData({ historyId: id === this.data.historyId ? '' : id });
  },

  openCustomer(event: WechatMiniprogram.TouchEvent) {
    const { tripId, customerId } = event.currentTarget.dataset;
    try {
      const state = trips.load();
      const trip = state.trips.find(entry => entry.id === tripId);
      if (!trip) throw new Error('未找到该配送趟，请重新打开');
      this.setData({ detail: customerDetail(trip, customerId, currentTrip(state)?.id === trip.id), error: '', notice: '' });
    } catch (error) { this.fail(error); }
  },

  backToList() { this.setData({ detail: null, error: '', notice: '' }); },

  saveDelivery(lineId: string | null, delivered: boolean) {
    const detail = this.data.detail;
    if (!detail?.active) return;
    try {
      trips.setDelivery(detail.tripId, detail.version, detail.id, lineId, delivered ? 'delivered' : 'pending');
      this.setData({ error: '', notice: '' });
      this.refresh();
    } catch (error) { this.fail(error); }
  },

  toggleLine(event: WechatMiniprogram.TouchEvent) {
    const line = this.data.detail?.items.find(item => item.id === event.currentTarget.dataset.id);
    if (line) this.saveDelivery(line.id, !line.delivered);
  },

  deliverCustomer() { this.saveDelivery(null, true); },

  startAmendment() {
    const detail = this.data.detail;
    if (!detail?.active) return;
    try {
      const amendment = trips.startAmendment(detail.tripId, detail.id);
      this.setData({ amendment, form: formLines(amendment.customer.items), preview: null, error: '', notice: '' });
    } catch (error) { this.fail(error); }
  },

  updateAmendment(items: ItemInput[]) {
    const amendment = this.data.amendment;
    if (!amendment) return;
    this.setData({ amendment: { ...amendment, customer: { ...amendment.customer, items } }, form: formLines(items), preview: null, error: '' });
  },

  editItem(event: WechatMiniprogram.Input) {
    const items = this.data.amendment?.customer.items;
    const { id, field } = event.currentTarget.dataset;
    if (items) this.updateAmendment(editLines(items, id, field, event.detail.value));
  },

  addItem() {
    const items = this.data.amendment?.customer.items;
    if (items) this.updateAmendment([...items, emptyItem(newId())]);
  },

  removeItem(event: WechatMiniprogram.TouchEvent) {
    const items = this.data.amendment?.customer.items;
    if (items && items.length > 1) this.updateAmendment(items.filter(item => item.id !== event.currentTarget.dataset.id));
  },

  showAmendmentPreview() {
    const draft = this.data.amendment;
    if (!draft) return;
    try {
      const current = trips.startAmendment(draft.tripId, draft.customer.id);
      if (current.version !== draft.version) throw new Error('正式版本已变化，请退出更正后重新打开单据');
      const amendment = { ...draft, statusRevision: current.statusRevision };
      const preview = amendmentPreview(trips.previewAmendment(amendment));
      this.setData({ amendment, preview, error: '' });
    } catch (error) { this.fail(error); }
  },

  editAgain() { this.setData({ preview: null, error: '' }); },

  cancelAmendment() {
    this.setData({ amendment: null, preview: null, form: [], error: '' });
    this.refresh();
  },

  confirmAmendment() {
    const { amendment, preview } = this.data;
    if (!amendment || !preview) return;
    try {
      const version = trips.confirmAmendment(amendment);
      this.setData({ amendment: null, preview: null, form: [], error: '', notice: `已保存第 ${version.version} 版` });
      this.refresh();
    } catch (error) { this.fail(error); }
  },

  async exportImages() {
    const { detail, busy } = this.data;
    if (!detail || busy) return;
    this.setData({ busy: true, error: '', notice: '' });
    try {
      const state = trips.load();
      const trip = state.trips.find(entry => entry.id === detail.tripId);
      const version = trip ? latest(trip) : null;
      const customer = version?.customers.find(entry => entry.id === detail.id);
      if (!version || !customer) throw new Error('未找到正式客户单据，请重新打开');
      const canvas = await new Promise<WechatMiniprogram.Canvas>((resolve, reject) => {
        wx.createSelectorQuery().select('#order-canvas').node(result => {
          if (result?.node) resolve(result.node as WechatMiniprogram.Canvas);
          else reject(new Error('无法打开图片画布，请重试'));
        }).exec();
      });
      const files = await generateOrderImages(canvas, customer, version.version);
      this.setData({ images: { customer: customer.customer, version: version.version, files, saved: 0 }, albumSettings: false });
    } catch (error) { this.fail(error); }
    finally { this.setData({ busy: false }); }
  },

  previewImage(event: WechatMiniprogram.TouchEvent) {
    const images = this.data.images;
    if (images) wx.previewImage({ current: event.currentTarget.dataset.file, urls: images.files });
  },

  async saveImages() {
    const { images, busy } = this.data;
    if (!images || busy || images.saved === images.files.length) return;
    this.setData({ busy: true, error: '', notice: '', albumSettings: false });
    let saved = images.saved;
    try {
      while (saved < images.files.length) {
        await saveOrderImage(images.files[saved]);
        saved += 1;
        this.setData({ images: { ...images, saved } });
      }
      this.setData({ notice: `已保存 ${saved} 张图片到相册` });
    } catch (error) {
      const reason = (error as { errMsg?: string })?.errMsg ?? '';
      const denied = /auth|deny|denied|permission/i.test(reason);
      this.setData({ albumSettings: denied, error: denied
        ? `相册权限未开启，已保存 ${saved}/${images.files.length} 张。开启权限后重试。`
        : `第 ${saved + 1} 张保存失败，已保存 ${saved}/${images.files.length} 张。请重试。` });
    } finally { this.setData({ busy: false }); }
  },

  openAlbumSettings() {
    wx.openSetting({
      success: result => {
        if (result.authSetting['scope.writePhotosAlbum']) this.setData({ albumSettings: false, error: '' });
      },
      fail: () => this.fail(new Error('无法打开设置，请在微信小程序设置中开启相册权限后重试')),
    });
  },

  closeImages() {
    if (this.data.busy) return;
    this.setData({ images: null, albumSettings: false, error: '', notice: '' });
    this.refresh();
  },
});
