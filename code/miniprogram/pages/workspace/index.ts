import { deliveryLines, deliverySummary } from '../../core/delivery-execution';
import { emptyItem, ItemInput, money, nullablePrice } from '../../core/orders';
import { Material, materialImagePattern, MaterialSource } from '../../core/materials';
import { deliveredBalance, localDay, OpeningPreview, ReceiptPreview, Sheet } from '../../core/settlement';
import { textOrderLimit, textOrderQuestions } from '../../core/text-order';
import { CustomerDraft, emptyCustomer, isTripDraft, latest, PickingChange, PickingLine, pickingChanges, pickingKey, TripDraft } from '../../core/trips';
import { newId } from '../../services/ids';
import { chooseMaterial, forgetStaged, materialInfo, readChunk, sameMaterial, stagedMaterials, stageMaterial, uploadChunk } from '../../services/materials';
import { readVoiceFile, startVoiceRecording, transcribeVoice, VoiceFileError, VoicePermissionError } from '../../services/voice';
import { FormalTrip, revokeSession, TripPreview, wechatCode, Workspace, WorkspaceError, workspaceRequest } from '../../services/workspace';
import { deliveryMvp } from '../../services/workspace-config';
import { amountLabel, deliveryLabel, editLines, errorMessage, formLines, lineView, productLabel, tripView } from '../order-view';
import { AmendmentPreview, balanceChange, DeliveryMark, DeliveryPreview, ServerLedger, ServerSheet, settlementPreview,
  SheetAction, sheetPath, sheetView } from './sheet-view';

type Section = 'draft' | 'picking' | 'delivery' | 'materials';
type VoiceFile = { id: string; revision: number; path: string };
type VoicePhase = '' | 'starting' | 'recording' | 'stopping' | 'transcribing';
const draftConflictCodes = ['draft_changed', 'draft_confirmed', 'draft_not_found'];
type PreviewView = ReturnType<typeof tripView> & { previewId: string; identities: string[] };
type FormalView = ReturnType<typeof tripView> & {
  id: string;
  version: number;
  statuses: Record<string, string>;
  picking: PickingLine[];
  changes: PickingChange[];
  deliveryRows: { totalLabel: string; lines: ReturnType<typeof lineView>[] }[];
};

function sheetEditor() {
  return {
    sheetAction: '' as SheetAction | '',
    changePreview: null as null | {
      id: string;
      title: string;
      rows: ReturnType<typeof balanceChange>;
      changes?: ReturnType<typeof amendmentChanges>;
      picking?: PickingChange[];
      unchecked?: ReturnType<typeof lineView>[];
    },
    paymentPreview: null as ReturnType<typeof settlementPreview> | null,
    payment: { amount: '', day: '', source: '' },
    fieldEdit: null as { id: string; receivedQuantity: string; price: string } | null,
    amendment: [] as ItemInput[],
    amendmentForm: [] as ReturnType<typeof formLines>,
    replacements: {} as Record<string, DeliveryMark>,
    replacementLines: [] as { id: string; label: string; status: DeliveryMark | '' }[],
  };
}

function amendmentChanges(result: AmendmentPreview) {
  return result.changes.map(change => ({
    id: change.id, before: change.before ? lineView(change.before) : null,
    after: change.after ? lineView(change.after) : null,
    beforeStatus: change.beforeStatus ? deliveryLabel[change.beforeStatus] : '',
    afterStatus: change.afterStatus ? deliveryLabel[change.afterStatus] : '',
  }));
}

function initialData() {
  return {
    signedIn: false, busy: false, error: '', revokeFailed: false, section: 'draft' as Section,
    deliveryMvp, textOrderLimit, orderText: '', organizingText: false, textSaved: false, textNotice: '',
    textQuestions: [] as ReturnType<typeof textOrderQuestions>,
    voicePhase: '' as VoicePhase, voiceRetry: false, voicePermission: false, selectedImage: '',
    draft: null as TripDraft | null, draftConfirmed: false, active: null as CustomerDraft | null,
    form: [] as ReturnType<typeof formLines>, parties: [] as { id: string; name: string; label: string }[],
    partyLabel: '', dirty: false, preview: null as PreviewView | null, formal: null as FormalView | null,
    conflict: null as Workspace | null,
    ...sheetEditor(), sheetTarget: null as Sheet | null, sheet: null as ReturnType<typeof sheetView> | null,
    sheetNeedsRefresh: false, sheetRetry: false,
    materialRows: [] as (MaterialSource & { id: string; label: string; draftCurrent: boolean;
      ready: boolean; local: boolean; progress: number; canOrganize: boolean })[],
    materialLoaded: false, uploading: '', organizingImage: '', materialNotice: '',
  };
}

Page({
  data: initialData(),
  generation: 0,
  token: '',
  retiredTokens: [] as string[],
  pending: null as { key: string; requestId: string } | null,
  unresolvedSheetWrite: null as { route: string; input: object } | null,
  materials: [] as Material[],
  materialTransfer: null as { paused: boolean } | null,
  voiceCapture: null as ReturnType<typeof startVoiceRecording> | null,
  voiceFile: null as VoiceFile | null,

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
    this.unresolvedSheetWrite = null;
    this.materialTransfer = null;
    this.materials = [];
    this.voiceCapture?.cancel();
    this.voiceCapture = null;
    this.voiceFile = null;
    this.setData({ ...initialData(), error, revokeFailed: this.retiredTokens.length > 0 });
    return token;
  },

  onUnload() {
    this.generation += 1;
    const tokens = [this.token, ...this.retiredTokens].filter(Boolean);
    this.token = '';
    this.retiredTokens = [];
    this.pending = null;
    this.unresolvedSheetWrite = null;
    this.materialTransfer = null;
    this.materials = [];
    this.voiceCapture?.cancel();
    this.voiceCapture = null;
    this.voiceFile = null;
    for (const token of tokens) void revokeSession(token).catch(() => {});
  },

  onHide() {
    this.pauseMaterial();
    this.voiceCapture?.cancel();
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
    if (!this.token || this.data.dirty || this.data.sheetTarget) return;
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
    const sameTrip = this.data.draft?.id === workspace.draft.id;
    this.pending = null;
    this.setData({
      parties: workspace.parties.map((party, index) => ({ ...party, label: `${party.name} · 客户 ${index + 1}` })),
      draftConfirmed: workspace.draftConfirmed, formal: formal ? this.formalView(formal) : null,
      dirty: false, conflict: null, preview: null,
      ...(sameTrip ? {} : { orderText: '', textSaved: false, textNotice: '', textQuestions: [], selectedImage: '' }),
    });
    this.showDraft(workspace.draft, current);
    if (this.data.section === 'materials') await this.loadMaterials(generation, token);
  },

  formalView({ trip, picking, deliveryEdits, sheets = [] }: FormalTrip): FormalView {
    const version = latest(trip);
    const previous = trip.versions[trip.versions.length - 2];
    const statuses = Object.fromEntries(Object.entries(trip.statuses).map(([id, status]) => [id, deliveryLabel[status]]));
    const deliveryRows = version.customers.map(customer => {
      const lines = deliveryLines(customer, deliveryEdits);
      const { totalCents, pendingPrices } = deliverySummary(lines);
      const reviewed = sheets.some(sheet => sheet.sheetId === customer.id && sheet.reviewed);
      const due = reviewed ? deliveredBalance({ ...customer, items: lines }, trip.statuses, 0).due : totalCents;
      return { lines: lines.map(line => lineView({ ...line, quantity: String(line.receivedQuantity) })),
        totalLabel: amountLabel(due, pendingPrices, reviewed ? '本次应收' : '预计应收') };
    });
    return { ...tripView(version), deliveryRows, id: trip.id, version: version.version, picking, statuses,
      changes: previous ? pickingChanges(previous.customers, version.customers) : [] };
  },

  selectSection(event: WechatMiniprogram.TouchEvent) {
    const section = event.currentTarget.dataset.section;
    if (!this.data.draft || this.data.busy || this.data.sheetTarget || !['draft', 'picking', 'delivery', 'materials'].includes(section)) return;
    this.setData({ section, error: '' });
    if (section === 'materials') return this.refreshMaterials();
  },

  showDraft(draft: TripDraft, id?: string) {
    if (this.voiceFile && (this.voiceFile.id !== draft.id || this.voiceFile.revision !== draft.revision)) {
      this.voiceFile = null;
      this.setData({ voiceRetry: false });
    }
    const active = draft.customers.find(customer => customer.id === id) ?? draft.customers[0];
    this.setData({ draft, active, form: formLines(active.items),
      ...(this.data.textSaved ? { textQuestions: textOrderQuestions(draft) } : {}),
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
    if (this.data.sheetAction === 'amendment') {
      this.updateAmendment(editLines(this.data.amendment, id, field, event.detail.value));
      return;
    }
    if (active && active.items.some(item => item.id === id)) {
      this.editActive({ ...active, items: editLines(active.items, id, field, event.detail.value) });
    }
  },

  addItem() {
    if (this.data.sheetAction === 'amendment') {
      this.updateAmendment([...this.data.amendment, emptyItem(newId())]);
      return;
    }
    const active = this.data.active;
    if (active) this.editActive({ ...active, items: [...active.items, emptyItem(newId())] });
  },

  removeItem(event: WechatMiniprogram.TouchEvent) {
    const active = this.data.active;
    if (this.data.sheetAction === 'amendment') {
      const { amendment } = this.data;
      if (amendment.length > 1) this.updateAmendment(amendment.filter(item => item.id !== event.currentTarget.dataset.id));
      return;
    }
    if (active && active.items.length > 1) {
      this.editActive({ ...active, items: active.items.filter(item => item.id !== event.currentTarget.dataset.id) });
    }
  },

  command<T>(method: 'POST' | 'PUT', path: string, token: string, input: object, timeout?: number) {
    const key = JSON.stringify([method, path, input]);
    if (this.pending?.key !== key) this.pending = { key, requestId: newId() };
    return workspaceRequest<T>(method, path, token, { ...input, requestId: this.pending.requestId }, undefined, timeout);
  },

  async persist(generation: number, token: string, draft: TripDraft) {
    if (!this.data.dirty) return draft;
    try {
      const customers = draft.customers.map(customer => ({ ...customer,
        items: customer.items.map(item => ({ ...item, price: nullablePrice(item.price) })),
      }));
      const { draft: saved } = await this.command<{ draft: TripDraft }>('PUT', `/drafts/${draft.id}`, token,
        { revision: draft.revision, customers });
      if (generation !== this.generation) return null;
      this.showDraft(saved, this.data.active?.id);
      this.setData({ dirty: false });
      return saved;
    } catch (error) {
      if (generation !== this.generation) return null;
      if (error instanceof WorkspaceError && draftConflictCodes.includes(error.code)) {
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

  editOrderText(event: WechatMiniprogram.TextareaInput) {
    if (!this.data.busy) this.setData({ orderText: event.detail.value, textNotice: '', error: '' });
  },

  voiceDraft() {
    const { draft, deliveryMvp, draftConfirmed, conflict, preview, section, sheetTarget } = this.data;
    if (deliveryMvp && this.token && draft && !draftConfirmed && !conflict && !preview && !sheetTarget &&
        (section === 'draft' || section === 'materials')) return draft;
  },

  recordOrderVoice() {
    const draft = this.voiceDraft();
    if (!draft) return;
    return this.run(async generation => {
      this.voiceFile = null;
      this.setData({ voicePhase: 'starting', voiceRetry: false, voicePermission: false });
      try {
        this.voiceCapture = startVoiceRecording(() => {
          if (generation === this.generation) this.setData({ voicePhase: 'recording' });
        });
        const path = await this.voiceCapture.done;
        if (generation !== this.generation) return;
        this.voiceCapture = null;
        const file = { id: draft.id, revision: draft.revision, path };
        this.voiceFile = file;
        await this.applyVoiceTranscript(generation, file);
      } catch (error) {
        if (error instanceof VoicePermissionError && generation === this.generation) this.setData({ voicePermission: true });
        throw error;
      } finally {
        if (generation === this.generation) {
          this.voiceCapture = null;
          this.setData({ voicePhase: '' });
        }
      }
    });
  },

  stopOrderVoice() {
    if (this.data.voicePhase !== 'recording') return;
    this.setData({ voicePhase: 'stopping' });
    this.voiceCapture?.stop();
  },

  openVoiceSettings() {
    if (!this.voiceDraft() || this.data.busy) return;
    const generation = this.generation;
    wx.openSetting({ success: ({ authSetting }) => {
      if (generation === this.generation && authSetting['scope.record']) this.setData({ error: '', voicePermission: false });
    } });
  },

  retryOrderVoice() {
    const draft = this.voiceDraft();
    const file = this.voiceFile;
    if (!draft || !file || file.id !== draft.id || file.revision !== draft.revision) return;
    return this.run(async generation => {
      try { await this.applyVoiceTranscript(generation, file); }
      finally {
        if (generation === this.generation) this.setData({ voicePhase: '' });
      }
    });
  },

  async applyVoiceTranscript(generation: number, file: VoiceFile) {
    const { orderText } = this.data;
    const token = this.token;
    this.setData({ voicePhase: 'transcribing', voiceRetry: false });
    try {
      const bytes = await readVoiceFile(file.path);
      if (generation !== this.generation) return;
      const result = await transcribeVoice(file, bytes, token);
      if (generation !== this.generation) return;
      const draft = this.voiceDraft();
      if (!draft || draft.id !== file.id || draft.revision !== file.revision ||
          result?.draftId !== file.id || result.revision !== file.revision || this.data.orderText !== orderText) {
        this.voiceFile = null;
        throw new Error('录单内容已变化，请核对后重新录音。');
      }
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      if (!text) throw new Error('语音转写暂未完成，可用原录音重试。');
      const combined = orderText.trim() ? `${orderText}\n${text}` : text;
      if (combined.length > textOrderLimit) {
        this.setData({ section: 'draft' });
        throw new Error('合并后的文字超出字数限制，请缩短文字框中的内容后再用原录音重试。');
      }
      this.voiceFile = null;
      this.setData({ section: 'draft', orderText: combined, textNotice: '转写已填入，请编辑核对后再整理到草稿。' });
    } catch (error) {
      if (generation === this.generation) {
        if (error instanceof VoiceFileError || (error instanceof WorkspaceError && error.status >= 400 && error.status < 500)) {
          this.voiceFile = null;
        }
        this.setData({ voiceRetry: this.voiceFile === file });
      }
      await this.recoverMaterialDraft(generation, token, error);
    }
  },

  async recoverMaterialDraft(generation: number, token: string, error: unknown): Promise<never> {
    if (generation !== this.generation || !(error instanceof WorkspaceError) || !draftConflictCodes.includes(error.code)) {
      throw error;
    }
    const latest = await this.readWorkspace(token);
    if (generation !== this.generation) throw error;
    if (this.data.dirty) {
      this.setData({ conflict: latest, section: 'draft' });
      throw new Error('草稿已变化，请先核对工作区的最新草稿。');
    }
    const sameTrip = latest.draft.id === this.data.draft?.id;
    await this.restore(generation, token, latest);
    throw new Error(!sameTrip ? '已切换到新一趟。请为当前趟重新录入材料。'
      : latest.draftConfirmed ? '本趟已确认，请开始下一趟。' : '已刷新草稿，请核对最新明细后重试。');
  },

  acceptOrganizedDraft(before: TripDraft, after: unknown, source: '文字' | '图片') {
    if (!isTripDraft(after) || after.id !== before.id || after.revision !== before.revision + 1 ||
        this.data.draft?.id !== before.id || this.data.draft.revision !== before.revision) {
      throw new Error(`草稿已变化，请刷新工作区后核对。${source === '文字' ? '原文仍在' : '图片已保留'}。`);
    }
    const questions = textOrderQuestions(after);
    this.pending = null;
    this.setData({ textSaved: true,
      textNotice: questions.length ? '已写入草稿，请补齐下列信息。' : '已写入草稿，请核对货品和单价。' });
    this.showDraft(after, questions[0]?.id ?? this.data.active?.id);
  },

  organizeText() {
    const { draft, draftConfirmed, conflict, preview, orderText } = this.data;
    const text = orderText.trim();
    if (!this.data.deliveryMvp || !this.token || !draft || draftConfirmed || conflict || preview || !text) return;
    return this.run(async generation => {
      const token = this.token;
      this.setData({ organizingText: true, textNotice: '' });
      try {
        const saved = await this.persist(generation, token, draft);
        if (!saved || generation !== this.generation) return;
        const result = await this.command<{ draft: TripDraft }>('POST', '/text-orders', token,
          { draftId: saved.id, revision: saved.revision, text }, 25_000)
          .catch(error => this.recoverMaterialDraft(generation, token, error));
        if (generation !== this.generation) return;
        this.acceptOrganizedDraft(saved, result?.draft, '文字');
        this.setData({ orderText: '' });
      } finally {
        if (generation === this.generation) this.setData({ organizingText: false });
      }
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

  openSheet(event: WechatMiniprogram.TouchEvent) {
    const { tripId, sheetId } = event.currentTarget.dataset;
    if (!this.token || this.data.busy || this.data.sheetRetry || !tripId || !sheetId) return;
    this.setData({ ...sheetEditor(), sheetTarget: { tripId, sheetId }, sheet: null, sheetNeedsRefresh: false });
    return this.refreshSheet();
  },

  closeSheet() {
    if (this.data.busy || this.data.sheetRetry) return;
    const close = () => {
      this.setData({ ...sheetEditor(), sheetTarget: null, sheet: null, sheetNeedsRefresh: false, error: '' });
    };
    const { sheetTarget, sheetNeedsRefresh, formal } = this.data;
    if (sheetNeedsRefresh && formal && sheetTarget?.tripId === formal.id) {
      return this.run(async generation => {
        const latest = await workspaceRequest<FormalTrip>('GET', `/trips/${formal.id}`, this.token);
        if (generation !== this.generation) return;
        this.setData({ formal: this.formalView(latest) });
        close();
      });
    }
    close();
  },

  async readSheet(generation: number, token: string, target: Sheet, refreshTrip: boolean) {
    const path = sheetPath(target);
    const [details, account, formal] = await Promise.all([
      workspaceRequest<{ sheet: ServerSheet }>('GET', path, token),
      this.data.deliveryMvp ? null : workspaceRequest<{ ledger: ServerLedger }>('GET', path + '/ledger', token),
      refreshTrip && target.tripId === this.data.formal?.id
        ? workspaceRequest<FormalTrip>('GET', `/trips/${target.tripId}`, token) : null,
    ]);
    if (generation !== this.generation) return;
    this.setData({ sheet: sheetView(details.sheet, account?.ledger), sheetNeedsRefresh: false,
      ...(formal ? { formal: this.formalView(formal) } : {}) });
  },

  sheetBalanceChange(before: DeliveryPreview['before'], after: DeliveryPreview['after']) {
    const rows = balanceChange(before, after);
    return this.data.deliveryMvp ? [{ ...rows[0], label: '本次应收' }] : rows;
  },

  refreshSheet() {
    const { sheetTarget, sheetNeedsRefresh } = this.data;
    if (!sheetTarget || !this.token || this.data.sheetRetry) return;
    return this.run(generation => this.readSheet(generation, this.token, sheetTarget, sheetNeedsRefresh));
  },

  sheetReady() {
    return this.token && this.data.sheet && !this.data.sheetRetry && !this.data.sheetNeedsRefresh && !this.data.busy;
  },

  async sheetCommand<T>(route: string, input: object, token: string, target: Sheet) {
    const generation = this.generation;
    try { return await this.command<T>('POST', sheetPath(target) + route, token, input); }
    catch (error) {
      if (generation === this.generation && error instanceof WorkspaceError &&
          ['delivery_changed', 'amendment_changed', 'ledger_changed', 'delivery_preview_required',
            'sheet_not_reviewed', 'line_not_found', 'preview_not_found', 'unrecorded_delivery'].includes(error.code)) {
        const staleAmendment = this.data.sheetAction === 'amendment';
        this.pending = null;
        this.setData({
          ...(staleAmendment ? sheetEditor() : { changePreview: null, paymentPreview: null, fieldEdit: null }),
          sheetNeedsRefresh: true,
        });
      }
      throw error;
    }
  },

  writeSheet(route: string, input: object) {
    const target = this.data.sheetTarget;
    if (!target || !this.token) return;
    return this.run(async generation => {
      const token = this.token;
      try { await this.sheetCommand(route, input, token, target); }
      catch (error) {
        if (generation === this.generation && !(error instanceof WorkspaceError && error.status >= 400 && error.status < 500)) {
          this.unresolvedSheetWrite = { route, input };
          this.setData({ sheetRetry: true });
          throw new Error('暂未收到保存结果，请重试这次提交');
        }
        if (generation === this.generation) {
          this.unresolvedSheetWrite = null;
          this.setData({ sheetRetry: false });
        }
        throw error;
      }
      if (generation !== this.generation) return;
      this.pending = null;
      this.unresolvedSheetWrite = null;
      this.setData({ ...sheetEditor(), sheetRetry: false, sheetNeedsRefresh: true });
      try { await this.readSheet(generation, token, target, true); }
      catch (error) {
        if (error instanceof WorkspaceError && error.status === 401) throw error;
        throw new Error('本次操作已保存，请重新读取单据');
      }
    });
  },

  retrySheetWrite() {
    const retry = this.unresolvedSheetWrite;
    if (retry) return this.writeSheet(retry.route, retry.input);
  },

  beginFieldEdit(event: WechatMiniprogram.TouchEvent) {
    const sheet = this.data.sheet;
    if (!this.data.deliveryMvp || !sheet || !this.sheetReady() || sheet.reviewed) return;
    const line = sheet.lines.find(line => line.id === event.currentTarget.dataset.id);
    if (!line) return;
    this.setData({ error: '', fieldEdit: { id: line.id, receivedQuantity: String(line.receivedQuantity), price: line.price ?? '' } });
  },

  editDeliveryField(event: WechatMiniprogram.Input) {
    const { field } = event.currentTarget.dataset;
    if (!this.data.fieldEdit || !this.sheetReady() || (field !== 'receivedQuantity' && field !== 'price')) return;
    this.setData({ fieldEdit: { ...this.data.fieldEdit, [field]: event.detail.value } });
  },

  saveFieldEdit() {
    const { sheet, fieldEdit } = this.data;
    if (!sheet || !fieldEdit || !this.sheetReady() || sheet.reviewed) return;
    return this.writeSheet('/delivery/line', { version: sheet.version, statusRevision: sheet.statusRevision,
      lineId: fieldEdit.id, receivedQuantity: fieldEdit.receivedQuantity.trim(), price: nullablePrice(fieldEdit.price) });
  },

  completeDelivery() {
    const { sheet, fieldEdit } = this.data;
    if (!this.data.deliveryMvp || !sheet || fieldEdit || !this.sheetReady() || sheet.reviewed) return;
    return this.writeSheet('/delivery/complete', { version: sheet.version, statusRevision: sheet.statusRevision });
  },

  markDelivery(event: WechatMiniprogram.TouchEvent) {
    const sheet = this.data.sheet;
    if (!sheet || !this.sheetReady() || this.data.sheetAction) return;
    const lineId = event.currentTarget.dataset.id ?? null;
    const status = event.currentTarget.dataset.status as DeliveryMark;
    const input = { version: sheet.version, statusRevision: sheet.statusRevision, lineId, status };
    if (!sheet.reviewed) return this.writeSheet('/delivery', input);
    return this.run(async generation => {
      const { preview } = await this.sheetCommand<{ preview: DeliveryPreview }>('/delivery/preview', input, this.token, sheet);
      if (generation !== this.generation) return;
      const line = sheet.lines.find(line => line.id === lineId);
      const label = line ? `${productLabel(line)} · ${line.unit}` : '本客户全部明细';
      this.setData({ sheetAction: 'delivery', changePreview: {
        id: preview.previewId, title: `${label} → ${deliveryLabel[status]}`, rows: this.sheetBalanceChange(preview.before, preview.after),
      } });
    });
  },

  beginSheetAction(event: WechatMiniprogram.TouchEvent) {
    const sheet = this.data.sheet;
    const action = event.currentTarget.dataset.action;
    if (!sheet || !this.sheetReady() || this.data.sheetAction) return;
    if (this.data.deliveryMvp && (action === 'opening' || action === 'receipt')) return;
    if (action === 'review' && !sheet.reviewed) this.setData({ sheetAction: 'review' });
    if (action === 'opening' || action === 'receipt') {
      if (!sheet.reviewed || (action === 'receipt' && !sheet.canReceive)) return;
      this.setData({ sheetAction: action, payment: { amount: '', day: localDay(new Date()), source: '' } });
    }
    if (action === 'amendment') {
      this.setData({ sheetAction: 'amendment' });
      this.updateAmendment(sheet.lines.map(({ id, product, brand, specification, unit, quantity, price }) =>
        ({ id, product, brand, specification, unit, quantity, price })));
    }
  },

  confirmReview() {
    const sheet = this.data.sheet;
    if (sheet && this.sheetReady() && this.data.sheetAction === 'review' && !sheet.hasUnrecorded) {
      return this.writeSheet('/review', { version: sheet.version, statusRevision: sheet.statusRevision });
    }
  },

  editPayment(event: WechatMiniprogram.Input | WechatMiniprogram.PickerChange) {
    const { field } = event.currentTarget.dataset;
    if (!this.sheetReady() || this.data.paymentPreview || !['amount', 'day', 'source'].includes(field)) return;
    this.setData({ payment: { ...this.data.payment, [field]: event.detail.value } });
  },

  previewPayment() {
    const { sheet, sheetAction, payment } = this.data;
    if (!sheet || !this.sheetReady() || (sheetAction !== 'opening' && sheetAction !== 'receipt')) return;
    return this.run(async generation => {
      const { preview } = await this.sheetCommand<{ preview: OpeningPreview | ReceiptPreview }>(
        `/${sheetAction}/preview`, sheetAction === 'opening' ? payment : { amount: payment.amount }, this.token, sheet);
      if (generation === this.generation) this.setData({ paymentPreview: settlementPreview(preview) });
    });
  },

  updateAmendment(items: ItemInput[], chosen?: Record<string, DeliveryMark>) {
    const sheet = this.data.sheet;
    if (!sheet || !this.sheetReady() || this.data.changePreview || this.data.sheetAction !== 'amendment') return;
    const originals = new Map(sheet.lines.map(line => [line.id, line]));
    const statuses = chosen ?? this.data.replacements;
    const replacementLines = items.flatMap(item => {
      const old = originals.get(item.id);
      return old?.status === 'delivered' && pickingKey(old) !== pickingKey(item)
        ? [{ id: item.id, status: statuses[item.id] ?? '', label: `${productLabel(item)} · ${item.unit}` }] : [];
    });
    const replacements = Object.fromEntries(replacementLines.filter(line => line.status).map(line => [line.id, line.status]));
    this.setData({ amendment: items, amendmentForm: formLines(items), replacements, replacementLines });
  },

  chooseReplacement(event: WechatMiniprogram.TouchEvent) {
    const { id, status } = event.currentTarget.dataset;
    this.updateAmendment(this.data.amendment, { ...this.data.replacements, [id]: status });
  },

  previewAmendment() {
    const { sheet, sheetAction, amendment, replacements } = this.data;
    if (!sheet || !this.sheetReady() || sheetAction !== 'amendment') return;
    return this.run(async generation => {
      const { preview } = await this.sheetCommand<{ preview: AmendmentPreview }>('/amendment/preview',
        { version: sheet.version, statusRevision: sheet.statusRevision, items: amendment, replacementStatuses: replacements },
        this.token, sheet);
      if (generation !== this.generation) return;
      this.setData({ changePreview: {
        id: preview.previewId, title: '正式单更正预览',
        rows: [{ label: '订单金额', before: money(preview.orderCents.before), after: money(preview.orderCents.after) },
          ...this.sheetBalanceChange(preview.before, preview.after)],
        changes: amendmentChanges(preview), picking: preview.picking, unchecked: preview.unchecked.map(lineView),
      } });
    });
  },

  confirmSheetPreview() {
    const { sheetAction, changePreview, paymentPreview } = this.data;
    const previewId = changePreview?.id ?? paymentPreview?.id;
    if (previewId && this.sheetReady() && sheetAction && sheetAction !== 'review') {
      return this.writeSheet(`/${sheetAction}/confirm`, { previewId });
    }
  },

  backFromSheetPreview() {
    if (!this.data.busy && !this.data.sheetRetry) {
      this.pending = null;
      this.setData({ changePreview: null, paymentPreview: null, error: '',
        ...(this.data.sheetAction === 'delivery' ? { sheetAction: '' } : {}) });
    }
  },

  cancelSheetAction() {
    if (!this.data.busy && !this.data.sheetRetry) {
      this.pending = null;
      this.setData({ ...sheetEditor(), error: '' });
    }
  },

  showMaterials() {
    const local = stagedMaterials();
    const { draft, draftConfirmed } = this.data;
    const rows = this.materials.map(material => ({
      ...material, label: this.data.deliveryMvp && material.organized ? '已整理' : material.status === 'ready' ? '已上传' : '待续传',
      ready: material.status === 'ready', local: local.some(source => sameMaterial(source, material)),
      canOrganize: material.status === 'ready' && !material.organized && material.draftId === draft?.id && !draftConfirmed,
      progress: Math.floor(material.received * 100 / material.size),
    }));
    const pending = local.filter(source => source.draftId === draft?.id &&
      !this.materials.some(material => sameMaterial(material, source))).map(source => ({
      ...source, id: '', label: '待登记', ready: false, local: true, progress: 0, canOrganize: false,
      draftCurrent: !draftConfirmed && source.revision === draft?.revision,
    }));
    this.setData({ materialRows: [...pending, ...rows] });
  },

  async loadMaterials(generation: number, token: string) {
    const { materials } = await workspaceRequest<{ materials: Material[] }>('GET', '/materials', token);
    if (generation !== this.generation) return;
    this.materials = materials;
    forgetStaged(materials.filter(material => material.status === 'ready'));
    this.showMaterials();
    this.setData({ materialLoaded: true });
  },

  refreshMaterials() {
    if (!this.token) return;
    return this.run(generation => this.loadMaterials(generation, this.token));
  },

  organizeImage(event: WechatMiniprogram.TouchEvent) {
    const { draft, draftConfirmed, dirty, conflict, preview, deliveryMvp } = this.data;
    const row = this.data.materialRows.find(item => item.id === event.currentTarget.dataset.id);
    if (!deliveryMvp || !draft || draftConfirmed || dirty || conflict || preview || !this.token || !row?.canOrganize) return;
    return this.run(async generation => {
      const token = this.token;
      this.setData({ organizingImage: row.name, materialNotice: '' });
      try {
        const result = await this.command<{ draft: TripDraft }>('POST', '/image-orders', token,
          { draftId: draft.id, revision: draft.revision, materialId: row.id }, 25_000)
          .catch(error => this.recoverMaterialDraft(generation, token, error));
        if (generation !== this.generation) return;
        this.acceptOrganizedDraft(draft, result?.draft, '图片');
        this.setData({ section: 'draft' });
      } finally {
        if (generation === this.generation) this.setData({ organizingImage: '' });
      }
    });
  },

  selectMaterial(event: WechatMiniprogram.TouchEvent) {
    const { draft, dirty, draftConfirmed } = this.data;
    const { album, key } = event.currentTarget.dataset;
    const original = key ? this.materials.find(material => material.requestId === key && material.status === 'uploading') : undefined;
    if (!this.token || (key && !original) || (!original && (!draft || dirty || draftConfirmed))) return;
    return this.run(async generation => {
      const token = this.token;
      const selected = await chooseMaterial(album === 'yes');
      if (!selected || generation !== this.generation) return;
      if (!original && !materialImagePattern.test(selected.name.trim())) {
        throw new Error('请选择 JPG、PNG、WebP 或 HEIC 图片');
      }
      const { size, digest } = await materialInfo(selected.path);
      if (generation !== this.generation) return;
      if (original && (original.size !== size || original.digest !== digest)) {
        throw new Error('选择的文件与原材料不匹配，请重新选择原文件');
      }
      const source: MaterialSource = original ?? {
        requestId: newId(), draftId: draft!.id, revision: draft!.revision, name: selected.name, size, digest,
      };
      await stageMaterial(source, selected.path);
      if (generation !== this.generation) return;
      if (this.data.deliveryMvp && source.draftId === draft?.id) this.setData({ selectedImage: selected.path });
      this.showMaterials();
      await this.transferMaterial(generation, token, source, original?.id);
    });
  },

  resumeMaterial(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.materialRows.find(item => item.requestId === event.currentTarget.dataset.key);
    if (!this.token || !row || row.ready || !row.local || (!row.id && !row.draftCurrent)) return;
    return this.run(generation => this.transferMaterial(generation, this.token, row, row.id));
  },

  discardLocalMaterial(event: WechatMiniprogram.TouchEvent) {
    const row = this.data.materialRows.find(item => item.requestId === event.currentTarget.dataset.key);
    if (!this.token || !row || row.id || this.data.busy) return;
    return this.run(async () => {
      forgetStaged([row]);
      this.showMaterials();
    });
  },

  pauseMaterial() {
    if (this.materialTransfer) {
      this.materialTransfer.paused = true;
      this.setData({ materialNotice: '正在暂停，已收到的分块会保留。' });
    }
  },

  async transferMaterial(generation: number, token: string, source: MaterialSource, id?: string) {
    const transfer = { paused: false };
    this.materialTransfer = transfer;
    this.setData({ uploading: source.name, materialNotice: '' });
    try {
      const { requestId, draftId, revision, name, size, digest } = source;
      let { material } = id
        ? await workspaceRequest<{ material: Material }>('GET', `/materials/${id}`, token)
        : await workspaceRequest<{ material: Material }>('POST', '/materials', token, { requestId, draftId, revision, name, size, digest });
      while (generation === this.generation) {
        const saved = this.materials.some(item => item.id === material.id);
        this.materials = saved ? this.materials.map(item => item.id === material.id ? material : item) : [material, ...this.materials];
        if (material.status === 'ready') {
          forgetStaged([material]);
          this.showMaterials();
          this.setData({ materialNotice: '材料已上传。' });
          return;
        }
        this.showMaterials();
        if (transfer.paused) break;
        const content = await readChunk(material);
        if (generation !== this.generation || transfer.paused) break;
        const next = (await uploadChunk(material, content, token)).material;
        if (next.received <= material.received) throw new Error('上传进度未更新，请重试续传');
        material = next;
      }
      if (generation === this.generation) this.setData({ materialNotice: '已暂停，可从已上传位置继续。' });
    } finally {
      if (generation === this.generation) {
        this.materialTransfer = null;
        this.setData({ uploading: '' });
      }
    }
  },
});
