import { takeDeliverySheet } from '../../services/delivery-link';
import { emptyItem, ItemInput, money } from '../../core/orders';
import { localDay, OpeningPreview, ReceiptPreview, settlementTotals, Sheet, tripBalance } from '../../core/settlement';
import { Amendment, currentTrip, DeliveryPreview, latest, pickingKey, Trip, TripState } from '../../core/trips';
import { generateOrderImages, saveOrderImage } from '../../services/order-images';
import { newId } from '../../services/ids';
import { trips } from '../../services/orders';
import { deliveryLabel, editLines, errorMessage, formLines, lineView } from '../order-view';
import { balanceView, settlementView } from './settlement-view';

function tripSummary(trip: Trip, state: TripState, totals: ReturnType<typeof settlementTotals>) {
  const version = latest(trip);
  const date = new Date(trip.versions[0].savedAt);
  const openedAt = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const balance = tripBalance(state, trip, totals);
  return { id: trip.id, version: version.version, openedAt, total: money(version.totalCents),
    ...balanceView(balance), historic: money(balance.historical), unchecked: money(balance.unchecked),
    reviewed: balance.reviewed, count: balance.count,
    customers: version.customers.map(customer => ({ id: customer.id, name: customer.customer, total: money(customer.totalCents) })) };
}

type AmendmentResult = ReturnType<typeof trips.previewAmendment>;

function amendmentPreview(result: AmendmentResult) {
  return { before: money(result.original.totalCents), after: money(result.customer.totalCents),
    changes: result.changes.map(change => ({ id: change.id,
      before: change.before ? lineView(change.before) : null, after: change.after ? lineView(change.after) : null,
      beforeStatus: change.beforeStatus ? deliveryLabel[change.beforeStatus] : '',
      afterStatus: change.afterStatus ? deliveryLabel[change.afterStatus] : '',
    })), picking: result.picking, beforeBalance: balanceView(result.before), afterBalance: balanceView(result.after),
    unchecked: result.unchecked.map(lineView) };
}

function customerDetail(trip: Trip, id: string, state: TripState) {
  const version = latest(trip);
  const customer = version.customers.find(entry => entry.id === id);
  if (!customer) throw new Error('未找到该客户单据，请重新打开');
  const items = customer.items.map(line => {
      const status = trip.statuses[line.id];
      return { ...lineView(line), delivered: status === 'delivered', unrecorded: status === 'unrecorded', label: deliveryLabel[status] };
  });
  return { tripId: trip.id, version: version.version, active: currentTrip(state)?.id === trip.id, customer: customer.customer, id,
    statusRevision: trip.statusRevision, total: money(customer.totalCents), items,
    unchecked: items.filter(item => !item.delivered), unrecorded: items.some(item => item.unrecorded),
    account: settlementView(state, trip, id) };
}

function entryPreview(plan: OpeningPreview | ReceiptPreview) {
  const allocations = 'allocations' in plan ? plan.allocations.map(entry => ({
    id: entry.debtId, label: entry.label, value: money(entry.cents), remaining: money(entry.remaining),
  })) : [];
  return { plan, allocations, amount: money(plan.cents) };
}

function sheet(detail: ReturnType<typeof customerDetail>): Sheet { return { tripId: detail.tripId, sheetId: detail.id }; }

function emptyEntry() {
  const today = localDay(new Date());
  return { entry: '' as '' | 'receipt' | 'opening', amount: '', day: today, today, source: '',
    entryPreview: null as ReturnType<typeof entryPreview> | null };
}

Page({
  data: {
    current: null as ReturnType<typeof tripSummary> | null,
    history: [] as ReturnType<typeof tripSummary>[], historyId: '',
    detail: null as ReturnType<typeof customerDetail> | null,
    amendment: null as Amendment | null,
    form: [] as ReturnType<typeof formLines>,
    preview: null as ReturnType<typeof amendmentPreview> | null,
    replacements: [] as { id: string; label: string; status?: 'pending' | 'delivered' }[],
    deliveryPreview: null as { plan: DeliveryPreview; lines: string[]; status: string;
      before: ReturnType<typeof balanceView>; after: ReturnType<typeof balanceView> } | null,
    reconciling: false, book: false, ...emptyEntry(),
    images: null as { customer: string; version: number; files: string[]; saved: number } | null,
    busy: false, albumSettings: false, error: '', notice: '',
  },

  onShow() {
    this.refresh();
    const target = takeDeliverySheet();
    if (target) this.showCustomer(target.tripId, target.sheetId);
  },

  fail(error: unknown) { this.setData({ error: errorMessage(error), notice: '' }); },

  refresh() {
    try {
      const state = trips.load();
      const current = currentTrip(state);
      const totals = settlementTotals(state);
      const history = state.trips.filter(trip => trip.id !== current?.id).reverse().map(trip => tripSummary(trip, state, totals));
      const selected = this.data.detail;
      const trip = selected ? state.trips.find(entry => entry.id === selected.tripId) : null;
      this.setData({ current: current ? tripSummary(current, state, totals) : null, history,
        detail: trip && selected ? customerDetail(trip, selected.id, state) : null });
      if (selected && !trip) this.setData({ amendment: null, preview: null, form: [], images: null, deliveryPreview: null,
        reconciling: false, book: false, ...emptyEntry(), error: '', notice: '' });
    } catch (error) { this.fail(error); }
  },

  toggleHistory(event: WechatMiniprogram.TouchEvent) {
    const { id } = event.currentTarget.dataset;
    this.setData({ historyId: id === this.data.historyId ? '' : id });
  },

  openCustomer(event: WechatMiniprogram.TouchEvent) {
    const { tripId, customerId } = event.currentTarget.dataset;
    this.showCustomer(tripId, customerId);
  },

  showCustomer(tripId: string, customerId: string) {
    try {
      const state = trips.load();
      const trip = state.trips.find(entry => entry.id === tripId);
      if (!trip) throw new Error('未找到该配送趟，请重新打开');
      this.setData({ detail: customerDetail(trip, customerId, state), reconciling: false, book: false, error: '', notice: '',
        amendment: null, preview: null, form: [], replacements: [], images: null, deliveryPreview: null, ...emptyEntry() });
    } catch (error) { this.fail(error); }
  },

  backToList() { this.setData({ detail: null, reconciling: false, book: false, error: '', notice: '' }); },

  saveDelivery(lineId: string | null, delivered: boolean) {
    const detail = this.data.detail;
    if (!detail) return;
    try {
      const status = delivered ? 'delivered' : 'pending';
      if (detail.account.reviewed) {
        const plan = trips.previewDelivery({ ...sheet(detail), version: detail.version, lineId, status });
        const lines = detail.items.filter(item => !lineId || item.id === lineId).map(item => `${item.brand} ${item.product} ${item.specification}`);
        this.setData({ deliveryPreview: { plan, lines, status: deliveryLabel[plan.change.status],
          before: balanceView(plan.before), after: balanceView(plan.after) }, error: '', notice: '' });
        return;
      }
      trips.setDelivery(detail.tripId, detail.version, detail.id, lineId, status);
      this.setData({ error: '', notice: '' });
      this.refresh();
    } catch (error) { this.refresh(); this.fail(error); }
  },

  toggleLine(event: WechatMiniprogram.TouchEvent) {
    const line = this.data.detail?.items.find(item => item.id === event.currentTarget.dataset.id);
    if (line) this.saveDelivery(line.id, !line.delivered);
  },

  deliverCustomer() { this.saveDelivery(null, true); },

  markPending(event: WechatMiniprogram.TouchEvent) { this.saveDelivery(event.currentTarget.dataset.id, false); },

  cancelDelivery() { this.setData({ deliveryPreview: null, error: '' }); this.refresh(); },

  confirmDelivery() {
    const preview = this.data.deliveryPreview;
    if (!preview) return;
    try {
      trips.confirmDelivery(preview.plan);
      this.setData({ deliveryPreview: null, error: '', notice: '已更新配送状态和账目' });
      this.refresh();
    } catch (error) { this.fail(error); }
  },

  startReconcile() { this.setData({ reconciling: true, error: '', notice: '' }); },

  cancelReconcile() { this.setData({ reconciling: false, error: '' }); },

  chooseParty(event: WechatMiniprogram.PickerChange) {
    const party = this.data.detail?.account.parties[Number(event.detail.value)];
    if (party) this.linkParty(party.id);
  },

  createParty() { this.linkParty(null); },

  linkParty(partyId: string | null) {
    const detail = this.data.detail;
    if (!detail) return;
    try {
      trips.linkCustomer(sheet(detail), partyId);
      this.setData({ error: '', notice: '已确认客户归属' });
      this.refresh();
    } catch (error) { this.fail(error); }
  },

  confirmReconcile() {
    const detail = this.data.detail;
    if (!detail || !this.data.reconciling) return;
    try {
      trips.reviewSheet(sheet(detail), detail.version, detail.statusRevision);
      this.setData({ reconciling: false, error: '', notice: '已确认对账' });
      this.refresh();
    } catch (error) { this.refresh(); this.fail(error); }
  },

  toggleBook() { this.setData({ book: !this.data.book }); },

  startReceipt() { this.setData({ ...emptyEntry(), entry: 'receipt', error: '', notice: '' }); },

  startOpening() { this.setData({ ...emptyEntry(), entry: 'opening', error: '', notice: '' }); },

  editAmount(event: WechatMiniprogram.Input) { this.setData({ amount: event.detail.value, entryPreview: null, error: '' }); },

  editDay(event: WechatMiniprogram.PickerChange) { this.setData({ day: String(event.detail.value), entryPreview: null, error: '' }); },

  editSource(event: WechatMiniprogram.Input) { this.setData({ source: event.detail.value, entryPreview: null, error: '' }); },

  showEntryPreview() {
    const { detail, entry, amount, day, source } = this.data;
    if (!detail || !entry) return;
    try {
      const plan = entry === 'receipt' ? trips.previewReceipt(sheet(detail), amount) : trips.previewOpening(sheet(detail), day, amount, source);
      this.setData({ entryPreview: entryPreview(plan), error: '' });
    } catch (error) { this.fail(error); }
  },

  editEntry() { this.setData({ entryPreview: null, error: '' }); this.refresh(); },

  cancelEntry() { this.setData({ ...emptyEntry(), error: '' }); this.refresh(); },

  confirmEntry() {
    const { entryPreview: preview } = this.data;
    if (!preview) return;
    try {
      const receipt = 'allocations' in preview.plan;
      if ('allocations' in preview.plan) trips.confirmReceipt(preview.plan);
      else trips.confirmOpening(preview.plan);
      this.setData({ ...emptyEntry(), error: '', notice: receipt ? '已记录本次收款' : '已补录旧欠款' });
      this.refresh();
    } catch (error) { this.fail(error); }
  },

  startAmendment() {
    const detail = this.data.detail;
    if (!detail) return;
    try {
      const amendment = trips.startAmendment(detail.tripId, detail.id);
      this.setData({ amendment, form: formLines(amendment.customer.items), replacements: [], preview: null, error: '', notice: '' });
    } catch (error) { this.fail(error); }
  },

  updateAmendment(items: ItemInput[]) {
    const amendment = this.data.amendment;
    if (!amendment) return;
    const replacements = items.flatMap(item => {
      const initial = this.data.detail?.items.find(line => line.id === item.id);
      if (!initial?.delivered || pickingKey(initial) === pickingKey(item)) return [];
      const previous = amendment.customer.items.find(line => line.id === item.id);
      const status = previous && pickingKey(previous) === pickingKey(item) ? amendment.replacementStatuses?.[item.id] : undefined;
      return [{ id: item.id, label: `${item.brand} ${item.product} ${item.specification} · ${item.unit}`, status }];
    });
    const replacementStatuses = Object.fromEntries(replacements.filter(row => row.status).map(row => [row.id, row.status]));
    this.setData({ amendment: { ...amendment, replacementStatuses, customer: { ...amendment.customer, items } },
      replacements, form: formLines(items), preview: null, error: '' });
  },

  selectReplacement(event: WechatMiniprogram.TouchEvent) {
    const amendment = this.data.amendment;
    const { id, status } = event.currentTarget.dataset;
    if (!amendment || (status !== 'pending' && status !== 'delivered')) return;
    const replacementStatuses = { ...amendment.replacementStatuses, [id]: status };
    this.setData({ amendment: { ...amendment, replacementStatuses }, preview: null, error: '',
      replacements: this.data.replacements.map(row => row.id === id ? { ...row, status } : row) });
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
      const amendment = { ...draft, statusRevision: current.statusRevision, accountBasis: current.accountBasis };
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
