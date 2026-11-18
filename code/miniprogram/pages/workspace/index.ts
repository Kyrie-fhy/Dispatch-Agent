import { emptyItem } from '../../core/orders';
import { CustomerDraft, emptyCustomer, isTripDraft, latest, PickingChange, PickingLine, pickingChanges, TripDraft } from '../../core/trips';
import { newId } from '../../services/ids';
import { FormalTrip, revokeSession, TripPreview, wechatCode, Workspace, WorkspaceError, workspaceRequest } from '../../services/workspace';
import { deliveryLabel, editLines, errorMessage, formLines, tripView } from '../order-view';

type Section = 'draft' | 'picking' | 'delivery';
type PreviewView = ReturnType<typeof tripView> & { previewId: string; identities: string[] };
type FormalView = ReturnType<typeof tripView> & {
  version: number;
  statuses: Record<string, string>;
  picking: PickingLine[];
  changes: PickingChange[];
};

function initialData() {
  return {
    signedIn: false, busy: false, error: '', revokeFailed: false, section: 'draft' as Section,
    draft: null as TripDraft | null, draftConfirmed: false, active: null as CustomerDraft | null,
    form: [] as ReturnType<typeof formLines>, parties: [] as { id: string; name: string; label: string }[],
    partyLabel: '', dirty: false, preview: null as PreviewView | null, formal: null as FormalView | null,
    conflict: null as Workspace | null,
  };
}

Page({
  data: initialData(),
  generation: 0,
  token: '',
  retiredTokens: [] as string[],
  pending: null as { key: string; requestId: string } | null,

  async run(action: (generation: number) => Promise<void>) {
    if (this.data.busy) return;
    const generation = this.generation;
    this.setData({ busy: true, error: '' });
    try { await action(generation); }
    catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof WorkspaceError && error.status === 401 && this.token) {
        this.clearSession('登录已失效，请重新登录');
        return;
      }
      this.setData({ error: errorMessage(error) });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },

  clearSession(error = '') {
    const token = this.token;
    this.generation += 1;
    this.token = '';
    this.pending = null;
    this.setData({ ...initialData(), error, revokeFailed: this.retiredTokens.length > 0 });
    return token;
  },

  onUnload() {
    this.generation += 1;
    const tokens = [this.token, ...this.retiredTokens].filter(Boolean);
    this.token = '';
    this.retiredTokens = [];
    this.pending = null;
    for (const token of tokens) void revokeSession(token).catch(() => {});
  },

  login() {
    if (this.token) return;
    return this.run(async generation => {
      const code = await wechatCode();
      if (generation !== this.generation) return;
      const { token } = await workspaceRequest<{ token: string }>('POST', '/session/wechat', '', { code });
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('服务未返回有效的登录凭证，请重试');
      if (generation !== this.generation) { void revokeSession(token).catch(() => {}); return; }
      this.token = token;
      this.setData({ signedIn: true });
      await this.restore(generation, token);
    });
  },

  logout() {
    if (!this.data.dirty) return this.finishLogout();
    const generation = this.generation;
    wx.showModal({
      title: '退出工作区',
      content: '当前修改尚未保存。退出后将恢复上次保存的草稿。',
      confirmText: '退出',
      success: ({ confirm }) => {
        if (confirm && generation === this.generation) void this.finishLogout();
      },
    });
  },

  finishLogout() {
    const token = this.clearSession();
    if (token) this.retiredTokens = [...this.retiredTokens, token];
    return this.retryLogout();
  },

  retryLogout() {
    const tokens = this.retiredTokens;
    if (!tokens.length || this.token) return;
    return this.run(async generation => {
      const revoked = await Promise.all(tokens.map(token => revokeSession(token).then(() => true, () => false)));
      if (generation !== this.generation) return;
      this.retiredTokens = tokens.filter((_, index) => !revoked[index]);
      const revokeFailed = this.retiredTokens.length > 0;
      this.setData({ revokeFailed });
      if (revokeFailed) throw new Error('已退出工作区，服务端会话撤销失败，请重试');
    });
  },

  reload() {
    if (!this.token || this.data.dirty) return;
    return this.run(generation => this.restore(generation, this.token));
  },

  async readWorkspace(token: string) {
    const result = await workspaceRequest<Workspace>('GET', '/workspace', token);
    if (!result || !isTripDraft(result.draft) || !Array.isArray(result.parties)) {
      throw new Error('工作区数据读取失败，请重试');
    }
    return result;
  },

  async restore(generation: number, token: string, known?: Workspace) {
    const workspace = known ?? await this.readWorkspace(token);
    if (generation !== this.generation) return;
    const formal = workspace.currentTrip
      ? await workspaceRequest<FormalTrip>('GET', `/trips/${workspace.currentTrip.id}`, token)
      : null;
    if (generation !== this.generation) return;
    const current = this.data.draft?.id === workspace.draft.id ? this.data.active?.id : undefined;
    this.pending = null;
    this.setData({
      parties: workspace.parties.map((party, index) => ({ ...party, label: `${party.name} · 客户 ${index + 1}` })),
      draftConfirmed: workspace.draftConfirmed, formal: formal ? this.formalView(formal) : null,
      dirty: false, conflict: null, preview: null,
    });
    this.showDraft(workspace.draft, current);
  },

  formalView({ trip, picking }: FormalTrip): FormalView {
    const version = latest(trip);
    const previous = trip.versions[trip.versions.length - 2];
    const statuses = Object.fromEntries(Object.entries(trip.statuses).map(([id, status]) => [id, deliveryLabel[status]]));
    return { ...tripView(version), version: version.version, picking, statuses,
      changes: previous ? pickingChanges(previous.customers, version.customers) : [] };
  },

  selectSection(event: WechatMiniprogram.TouchEvent) {
    const section = event.currentTarget.dataset.section;
    if (this.data.draft && ['draft', 'picking', 'delivery'].includes(section)) this.setData({ section });
  },

  showDraft(draft: TripDraft, id?: string) {
    const active = draft.customers.find(customer => customer.id === id) ?? draft.customers[0];
    this.setData({ draft, active, form: formLines(active.items),
      partyLabel: this.data.parties.find(party => party.id === active.partyId)?.label ?? '' });
  },

  selectCustomer(event: WechatMiniprogram.TouchEvent) {
    if (this.data.draft) this.showDraft(this.data.draft, event.currentTarget.dataset.id);
  },

  editDraft(customers: CustomerDraft[], id?: string) {
    const { draft, busy, conflict, preview, draftConfirmed } = this.data;
    if (!draft || busy || conflict || preview || draftConfirmed) return;
    this.showDraft({ ...draft, customers }, id ?? this.data.active?.id);
    this.setData({ dirty: true, error: '' });
  },

  editActive(active: CustomerDraft) {
    const draft = this.data.draft;
    if (draft) this.editDraft(draft.customers.map(customer => customer.id === active.id ? active : customer));
  },

  editCustomer(event: WechatMiniprogram.Input) {
    const active = this.data.active;
    if (active?.id === event.currentTarget.dataset.id && active && !active.partyId) {
      this.editActive({ ...active, customer: event.detail.value, partyId: null });
    }
  },

  chooseExisting(event: WechatMiniprogram.PickerChange) {
    const { active, draft, parties } = this.data;
    const party = parties[Number(event.detail.value)];
    if (!active || !draft || !party) return;
    if (draft.customers.some(customer => customer.id !== active.id && customer.partyId === party.id)) {
      this.setData({ error: '本趟已选择该客户，请回到该客户单添加货品' });
      return;
    }
    this.editActive({ ...active, customer: party.name, partyId: party.id });
  },

  chooseNew() {
    const active = this.data.active;
    if (active) this.editActive({ ...active, partyId: null });
  },

  addCustomer() {
    const draft = this.data.draft;
    if (!draft) return;
    const customer = emptyCustomer(newId);
    this.editDraft([...draft.customers, customer], customer.id);
  },

  removeCustomer() {
    const { active, draft } = this.data;
    if (active && draft && draft.customers.length > 1) this.editDraft(draft.customers.filter(customer => customer.id !== active.id));
  },

  editItem(event: WechatMiniprogram.Input) {
    const active = this.data.active;
    const { id, field } = event.currentTarget.dataset;
    if (active && active.items.some(item => item.id === id)) {
      this.editActive({ ...active, items: editLines(active.items, id, field, event.detail.value) });
    }
  },

  addItem() {
    const active = this.data.active;
    if (active) this.editActive({ ...active, items: [...active.items, emptyItem(newId())] });
  },

  removeItem(event: WechatMiniprogram.TouchEvent) {
    const active = this.data.active;
    if (active && active.items.length > 1) {
      this.editActive({ ...active, items: active.items.filter(item => item.id !== event.currentTarget.dataset.id) });
    }
  },

  command<T>(method: 'POST' | 'PUT', path: string, token: string, input: object) {
    const key = JSON.stringify([method, path, input]);
    if (this.pending?.key !== key) this.pending = { key, requestId: newId() };
    return workspaceRequest<T>(method, path, token, { ...input, requestId: this.pending.requestId });
  },

  async persist(generation: number, token: string, draft: TripDraft) {
    if (!this.data.dirty) return draft;
    try {
      const { draft: saved } = await this.command<{ draft: TripDraft }>('PUT', `/drafts/${draft.id}`, token,
        { revision: draft.revision, customers: draft.customers });
      if (generation !== this.generation) return null;
      this.showDraft(saved, this.data.active?.id);
      this.setData({ dirty: false });
      return saved;
    } catch (error) {
      if (generation !== this.generation) return null;
      if (error instanceof WorkspaceError && ['draft_changed', 'draft_confirmed', 'draft_not_found'].includes(error.code)) {
        const conflict = await this.readWorkspace(token);
        if (generation === this.generation) this.setData({ conflict });
      }
      throw error;
    }
  },

  saveDraft() {
    const { draft, conflict } = this.data;
    if (!draft || conflict || !this.token) return;
    return this.run(async generation => { await this.persist(generation, this.token, draft); });
  },

  useSavedDraft() {
    const conflict = this.data.conflict;
    if (!conflict || !this.token) return;
    return this.run(generation => this.restore(generation, this.token, conflict));
  },

  keepLocalDraft() {
    const { conflict, draft } = this.data;
    if (!draft || !conflict || conflict.draftConfirmed || draft.id !== conflict.draft.id || !this.token) return;
    return this.run(async generation => {
      const token = this.token;
      const amended = { ...draft, revision: conflict.draft.revision };
      this.showDraft(amended, this.data.active?.id);
      this.setData({ conflict: null });
      await this.persist(generation, token, amended);
    });
  },

  showPreview() {
    const { draft, conflict, draftConfirmed } = this.data;
    if (!draft || conflict || draftConfirmed || !this.token) return;
    return this.run(async generation => {
      const token = this.token;
      const saved = await this.persist(generation, token, draft);
      if (!saved || generation !== this.generation) return;
      const { preview } = await this.command<{ preview: TripPreview }>('POST', '/trips/preview', token,
        { draftId: saved.id, revision: saved.revision });
      if (generation !== this.generation) return;
      this.setData({ preview: { ...tripView(preview), previewId: preview.previewId,
        identities: preview.choices.map((party, index) => party
          ? this.data.parties.find(entry => entry.id === party.id)?.label ?? party.name
          : `${preview.customers[index].customer} · 新建客户`) } });
    });
  },

  backToEdit() {
    if (!this.data.busy) this.setData({ preview: null, error: '' });
  },

  confirmTrip() {
    const preview = this.data.preview;
    if (!preview || !this.token) return;
    return this.run(async generation => {
      const result = await this.command<FormalTrip>('POST', '/trips/confirm', this.token, { previewId: preview.previewId });
      if (generation !== this.generation) return;
      this.setData({ formal: this.formalView(result), draftConfirmed: true, preview: null });
    });
  },

  nextTrip() {
    const draft = this.data.draft;
    if (!draft || !this.data.draftConfirmed || !this.token) return;
    return this.run(async generation => {
      const token = this.token;
      await this.command('POST', '/trips/next-draft', token, { draftId: draft.id });
      if (generation === this.generation) await this.restore(generation, token);
    });
  },
});
