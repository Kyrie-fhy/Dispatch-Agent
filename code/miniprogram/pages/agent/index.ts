import type { AgentEvent, AgentStatus, AgentTurn, DeliveryCardState, DeliveryProgress, DeliveryProposal, DirectIntent, PlanStep, StepState } from '../../core/agent';
import { money } from '../../core/orders';
import { materialImagePattern, Material, MaterialSource } from '../../core/materials';
import { textOrderLimit, textOrderQuestions } from '../../core/text-order';
import type { TripDraft } from '../../core/trips';
import { agentSession } from '../../services/agent-session';
import { newId } from '../../services/ids';
import { chooseMaterial, forgetStaged, materialInfo, sameMaterial, stagedMaterials, stageMaterial,
  transferMaterial } from '../../services/materials';
import { readVoiceFile, startVoiceRecording, transcribeVoice, VoiceFileError } from '../../services/voice';
import { revokeSession, wechatCode, WorkspaceError, workspaceRequest } from '../../services/workspace';
import { errorMessage, productLabel, tripView } from '../order-view';

type Conversation = { draft: TripDraft; draftConfirmed: boolean; confirmedPreviewId?: string | null; turns: AgentTurn[]; delivery?: DeliveryProgress | null };
type PollResult = { status: AgentStatus; events: AgentEvent[] };
type Attachment = { id: string; name: string };
type VoiceFile = { draft: TripDraft; path: string };
const draftConflicts = ['draft_changed', 'draft_confirmed', 'draft_not_found', 'preview_not_found', 'material_draft_changed'];
const imageLimit = 4;

const stepIcon: Record<StepState, string> = { pending: '○', running: '', done: '✓', needs_input: '！', failed: '✗', skipped: '–' };
type StepView = PlanStep & { state: StepState; result?: string };

function view(turn: AgentTurn, revision: number, confirmed: boolean, last: boolean, latestPreview: boolean, confirmedPreviewId: string,
  delivery: DeliveryProgress | null) {
  let plan: PlanStep[] = [];
  const progress = new Map<string, StepView>();
  const changes: string[] = [];
  let undone = false;
  let end: Extract<AgentEvent, { kind: 'end' }>['payload'] | undefined;
  let preview: Extract<AgentEvent, { kind: 'preview' }>['payload']['preview'] | undefined;
  let questions: Extract<AgentEvent, { kind: 'questions' }>['payload']['questions'] = [];
  let proposal: DeliveryProposal | undefined;
  let deliveryState: DeliveryCardState | undefined;
  for (const event of turn.events) {
    if (event.kind === 'plan') plan = event.payload.steps;
    if (event.kind === 'step') {
      const previous = progress.get(event.payload.id);
      progress.set(event.payload.id, { text: previous?.text ?? '', ...event.payload });
    }
    if (event.kind === 'progress') {
      const { step, text, done } = event.payload;
      progress.set(String(step), { id: String(step), text, state: done ? 'done' : 'running' });
    }
    if (event.kind === 'preview') preview = event.payload.preview;
    if (event.kind === 'end') end = event.payload;
    if (event.kind === 'change') changes.push(...event.payload.lines);
    if (event.kind === 'undo') undone = true;
    if (event.kind === 'questions') questions = event.payload.questions;
    if (event.kind === 'delivery_proposal') proposal = event.payload;
    if (event.kind === 'delivery_applied') deliveryState = event.payload.status;
  }
  const issued = Boolean(latestPreview && confirmed && preview && preview.previewId === confirmedPreviewId);
  const skipped = Boolean(preview && !issued &&
    (progress.get('confirm')?.state === 'skipped' || preview.revision !== revision || confirmed));
  if (issued || skipped) {
    progress.set('confirm', { id: 'confirm', text: '', state: issued ? 'done' : 'skipped',
      result: issued ? '已确认' : '修改完成后请重新生成预览。' });
    progress.set('issued', { id: 'issued', text: '', state: issued ? 'done' : 'skipped' });
  }
  if (!plan.length) plan = progress.size ? [...progress.values()] : turn.status === 'running' ?
    [{ id: 'intent', text: '看懂你的意思' }] : [];
  const shop = delivery?.shops.find(item => item.sheetId === proposal?.sheetId);
  const stale = !!proposal && !deliveryState && (!shop || shop.locked || delivery?.tripId !== proposal.tripId ||
    delivery.version !== proposal.version || delivery.statusRevision !== proposal.statusRevision);
  const checklist = plan.map(item => {
    const stored = progress.get(item.id);
    const state = stale && ['delivery-confirm', 'delivery-updated'].includes(item.id) ? 'skipped' : stored?.state ?? (turn.status === 'running' ? (!progress.size && item.id === 'intent' && !turn.events.length ? 'running' : 'pending')
      : turn.status === 'completed' && !skipped ? 'pending' : 'skipped');
    return { ...item, state, icon: stepIcon[state], result: stored?.result ?? '' };
  });
  return { id: turn.id, text: turn.text, pictures: turn.materialIds.length, checklist, questions, changes, undone, issued,
    status: turn.status, reply: changes.length && end?.text === '草稿已更新。' ? '' : end?.text ?? '',
    elapsed: end?.elapsedMs === undefined ? '' : `用时 ${Math.max(1, Math.round(end.elapsedMs / 1000))} 秒`,
    canAnswer: last && (!confirmed || plan.some(step => step.id === 'delivery-check')) && !undone && turn.status === 'completed' && end?.revision === revision,
    canRetry: last && (turn.status === 'failed' || turn.status === 'interrupted'),
    canUndo: !confirmed && !undone && !!changes.length && end?.revision === revision && turn.status !== 'running',
    preview: preview ? { ...tripView(preview), id: preview.previewId,
      active: !skipped && latestPreview && !confirmed && turn.status === 'completed' } : null,
    delivery: proposal ? { ...proposal, totalLabel: `¥${money(proposal.totalCents)}`, pendingLabel: proposal.pendingPriceNames.join('、'),
      active: !stale && !deliveryState && turn.status === 'completed', stale, notice: deliveryState === 'saved' ? '已保存修改' :
        deliveryState === 'completed' ? '已确认送达，应收已锁定' : deliveryState === 'cancelled' ? '已取消' : '' } : null,
  };
}

function deliverySummaryView(progress: DeliveryProgress) {
  return { label: `本趟送货 · ${progress.shops.filter(shop => shop.locked).length}/${progress.shops.length} 家已送达`,
    shops: progress.shops.map(shop => ({ ...shop, description: `${shop.locked ? '已锁定应收' : '预计应收'} ¥${money(shop.totalCents)}` +
      (shop.pendingPrices ? ` · ${shop.pendingPrices} 项待补价` : '') })) };
}

function draftSummary(draft: TripDraft, pending: number) {
  const customers = draft.customers.map(customer => ({
    id: customer.id, name: customer.customer || '未命名客户',
    lines: customer.items.filter(line => line.product || line.quantity || line.price || line.brand || line.specification)
      .map(line => ({ id: line.id, product: productLabel(line) || '未命名货品', quantity: line.quantity, unit: line.unit,
        price: line.price ? '¥' + line.price : '待补价' })),
  })).filter(customer => customer.lines.length);
  const lines = customers.reduce((sum, customer) => sum + customer.lines.length, 0);
  const issues = pending || (lines ? textOrderQuestions(draft).reduce((sum, customer) => sum + customer.issues.length, 0) : 0);
  return { customers, label: `本趟草稿 · ${customers.length} 家 ${lines} 行${issues ? `，${issues} 处待确认` : ''}` };
}

Page({
  data: {
    signedIn: false, busy: false, polling: false, confirmed: false, error: '', text: '', textOrderLimit,
    turns: [] as ReturnType<typeof view>[], attachments: [] as Attachment[], pendingMaterial: '', uploadLabel: '',
    draftsAvailable: false, scrollTo: '', voicePhase: '', voiceRetry: false,
    readyImages: [] as Attachment[], uploadRows: [] as (MaterialSource & { id?: string; local: boolean })[],
    draftStrip: null as ReturnType<typeof draftSummary> | null, draftExpanded: false, issuedCard: false, revokeFailed: false,
    deliveryStrip: null as ReturnType<typeof deliverySummaryView> | null, focusInput: false,
  },
  draft: null as TripDraft | null,
  turns: [] as AgentTurn[],
  generation: 0,
  visible: false,
  timer: null as ReturnType<typeof setTimeout> | null,
  confirmedPreviewId: '',
  delivery: null as DeliveryProgress | null,
  pending: new Map<string, string>(),
  voiceCapture: null as ReturnType<typeof startVoiceRecording> | null,
  voiceFile: null as VoiceFile | null,
  pauseUpload: false,
  retiredToken: '',

  onShow(): Promise<void> | undefined {
    this.visible = true;
    if (!agentSession.token) {
      if (this.data.signedIn) this.clear();
      return;
    }
    this.setData({ signedIn: true });
    if (!this.data.busy) return this.run(() => this.reload());
  },

  onHide() {
    this.visible = false;
    this.stopPolling();
    this.voiceCapture?.cancel();
    this.pauseUpload = true;
  },

  onUnload() {
    this.onHide();
    const token = agentSession.token;
    this.clear();
    for (const session of [token, this.retiredToken]) if (session) void revokeSession(session).catch(() => {});
  },

  clear() {
    this.generation++;
    this.stopPolling();
    agentSession.token = '';
    agentSession.unsaved = null;
    agentSession.deliveryCustomer = null;
    agentSession.deliveryTarget = null;
    this.draft = null;
    this.turns = [];
    this.pending.clear();
    this.voiceFile = null;
    this.confirmedPreviewId = '';
    this.delivery = null;
    this.setData({ signedIn: false, busy: false, polling: false, confirmed: false, draftsAvailable: false,
      error: '', text: '', turns: [], attachments: [], readyImages: [], uploadRows: [], pendingMaterial: '',
      scrollTo: '', draftStrip: null, deliveryStrip: null, focusInput: false, draftExpanded: false, issuedCard: false, voiceRetry: false, revokeFailed: !!this.retiredToken });
  },

  async run(action: () => Promise<void>) {
    if (this.data.busy) return;
    const generation = this.generation;
    this.setData({ busy: true, error: '' });
    try { await action(); }
    catch (error) { if (generation === this.generation) this.showError(error); }
    finally { if (generation === this.generation) this.setData({ busy: false }); }
  },

  showError(error: unknown) {
    if (error instanceof WorkspaceError && error.status === 401) {
      this.clear();
      this.setData({ error: '登录已失效，请重新登录。' });
    } else this.setData({ error: errorMessage(error) });
  },

  login() {
    if (agentSession.token || this.retiredToken) return;
    return this.run(async () => {
      const generation = this.generation;
      const code = await wechatCode();
      const { token } = await workspaceRequest<{ token: string }>('POST', '/session/wechat', '', { code });
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('服务未返回有效的登录凭证，请重试');
      if (generation !== this.generation) { void revokeSession(token).catch(() => {}); return; }
      agentSession.token = token;
      this.setData({ signedIn: true });
      await this.reload();
    });
  },

  logout() {
    if (this.data.busy) return;
    this.retiredToken = agentSession.token || this.retiredToken;
    this.clear();
    return this.run(async () => {
      await revokeSession(this.retiredToken);
      this.retiredToken = '';
      this.setData({ revokeFailed: false });
    });
  },

  async reload(): Promise<void> {
    const token = agentSession.token;
    if (!token) return;
    const generation = this.generation;
    const { draft, draftConfirmed, confirmedPreviewId, turns, delivery } = await workspaceRequest<Conversation>('GET', '/agent/conversation', token);
    if (generation !== this.generation || token !== agentSession.token) return;
    const sameTrip = !this.draft || this.draft.id === draft.id;
    const changedMode = this.data.confirmed !== draftConfirmed;
    this.draft = draft;
    this.turns = turns;
    this.confirmedPreviewId = confirmedPreviewId ?? '';
    this.delivery = delivery ?? null;
    const active = this.turns.find(turn => turn.status === 'running');
    const target = agentSession.deliveryCustomer;
    agentSession.deliveryCustomer = null;
    const prefill = draftConfirmed && target?.tripId === draft.id && !this.data.text.trim();
    if (changedMode || !sameTrip) this.voiceFile = null;
    this.setData({ confirmed: draftConfirmed, draftsAvailable: true, polling: !!active,
      ...(changedMode || !sameTrip ? { text: '', attachments: [], readyImages: [], uploadRows: [], draftExpanded: false, pendingMaterial: '', voiceRetry: false } : {}),
      ...(prefill ? { text: `${target.name}：`, focusInput: !active } : { focusInput: false }) });
    this.render();
    if (active) this.schedule();
  },

  render() {
    const revision = this.draft?.revision ?? -1;
    const preview = [...this.turns].reverse().find(turn => turn.events.some(event => event.kind === 'preview') &&
      !turn.events.some(event => event.kind === 'step' && event.payload.id === 'confirm' && event.payload.state === 'skipped'));
    const turns = this.turns.map((turn, index) => view(turn, revision, this.data.confirmed,
      index === this.turns.length - 1, preview?.id === turn.id, this.confirmedPreviewId, this.delivery));
    const recent = turns[turns.length - 1];
    this.setData({ turns, scrollTo: '', issuedCard: turns.some(turn => turn.issued),
      deliveryStrip: this.delivery && deliverySummaryView(this.delivery),
      draftStrip: !this.data.confirmed && this.draft ? draftSummary(this.draft, recent?.canAnswer ? recent.questions.length : 0) : null });
    this.setData({ scrollTo: 'latest' });
  },

  stopPolling() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  },

  schedule() {
    this.stopPolling();
    if (this.visible && this.data.polling) this.timer = setTimeout(() => { void this.poll(); }, 650);
  },

  async poll(): Promise<void> {
    const turn = this.turns.find(item => item.status === 'running');
    const token = agentSession.token;
    if (!turn || !token || !this.visible) return;
    const generation = this.generation;
    try {
      const after = turn.events[turn.events.length - 1]?.seq ?? 0;
      const result = await workspaceRequest<PollResult>('GET', `/agent/turns/${turn.id}/events?after=${after}`, token);
      if (generation !== this.generation || token !== agentSession.token || this.turns.find(item => item.id === turn.id) !== turn) return;
      turn.events.push(...result.events);
      if (this.data.confirmed && result.status !== 'running') {
        await this.reload();
        this.setData({ error: '' });
        return;
      }
      turn.status = result.status;
      this.setData({ polling: result.status === 'running', error: '' });
      this.render();
      if (result.status === 'running') this.schedule();
      else await this.reload();
    } catch (error) {
      if (generation !== this.generation) return;
      this.showError(error);
      if (agentSession.token) {
        this.setData({ error: `${errorMessage(error)}。正在尝试恢复进度。` });
        this.schedule();
      }
    }
  },

  editText(event: WechatMiniprogram.TextareaInput) { this.setData({ text: event.detail.value }); },

  request<T>(path: string, input: object) {
    const key = JSON.stringify([path, input]);
    let requestId = this.pending.get(key);
    if (!requestId) {
      requestId = newId();
      this.pending.set(key, requestId);
    }
    return workspaceRequest<T>('POST', path, agentSession.token, { ...input, requestId }).then(result => {
      this.pending.delete(key);
      return result;
    }, error => {
      if (error instanceof WorkspaceError && error.status < 500) this.pending.delete(key);
      throw error;
    });
  },

  card(action: string) {
    if (!this.draft || !agentSession.token) return;
    const { id: draftId, revision } = this.draft;
    void workspaceRequest('POST', '/agent/card-actions', agentSession.token, { action, requestId: newId(), draftId, revision }).catch(() => {});
  },

  send(): Promise<void> | undefined {
    const text = this.data.text.trim();
    if (this.data.confirmed && this.delivery?.shops.some(shop => text === `${shop.customer}：`)) return;
    return this.submit(text, this.data.confirmed ? [] : this.data.attachments.map(item => item.id));
  },

  openDelivery(event?: WechatMiniprogram.TouchEvent) {
    const card = this.data.turns.find(turn => turn.id === event?.currentTarget.dataset.turn)?.delivery;
    agentSession.deliveryTarget = card ? { tripId: card.tripId, sheetId: card.sheetId } : null;
    wx.switchTab({ url: '/pages/trip-delivery/index' });
  },

  applyDelivery(event: WechatMiniprogram.TouchEvent) {
    const { turn: turnId, mode } = event.currentTarget.dataset;
    const card = this.data.turns.find(turn => turn.id === turnId)?.delivery;
    if (!card?.active || this.data.polling || !this.draft) return;
    const complete = mode === 'complete';
    if (mode !== 'cancel' && (complete ? !card.canComplete : !card.edits.length)) return;
    return this.run(async () => {
      try {
        if (mode === 'cancel') await this.request('/agent/card-actions', { action: 'delivery-cancel', turnId,
          draftId: this.draft!.id, revision: this.draft!.revision });
        else await this.request(`/trips/${card.tripId}/sheets/${encodeURIComponent(card.sheetId)}/delivery/apply`, {
          turnId, version: card.version, statusRevision: card.statusRevision, complete,
          edits: card.edits.map(({ lineId, receivedQuantity, price }) => ({ lineId, receivedQuantity, price })),
        });
        await this.reload();
      } catch (error) {
        if (error instanceof WorkspaceError && ['delivery_changed', 'delivery_completed', 'draft_not_found'].includes(error.code)) {
          await this.reload();
          throw new Error('单据已更新，请以最新送货单为准。');
        }
        throw error;
      }
    });
  },

  previewShortcut(): Promise<void> | undefined {
    return this.submit('生成送货单', [], { intent: 'preview' });
  },

  toggleDraft(): void { this.setData({ draftExpanded: !this.data.draftExpanded }); },

  submit(text: string, materialIds: string[], direct?: DirectIntent): Promise<void> | undefined {
    const draft = this.draft;
    if (!draft || !agentSession.token || this.data.busy || this.data.polling || (!text && !materialIds.length)) return;
    const local: AgentTurn = { id: 'sending', text, materialIds, revision: draft.revision, events: [], status: 'running' };
    this.turns.push(local);
    this.render();
    return this.run(async () => {
      const generation = this.generation;
      const token = agentSession.token;
      try {
        const { turnId } = await this.request<{ turnId: string }>('/agent/turns',
          { draftId: draft.id, revision: draft.revision, text, materialIds, ...(direct ? { direct } : {}) });
        if (generation !== this.generation || token !== agentSession.token) return;
        this.turns = this.turns.filter(turn => turn !== local);
        if (!this.turns.some(turn => turn.id === turnId)) this.turns.push({ ...local, id: turnId });
        this.setData({ ...(!direct ? { text: '', attachments: [], readyImages: [] } : {}), polling: true });
        this.render();
        this.schedule();
      } catch (error) {
        if (generation === this.generation && token === agentSession.token) {
          this.turns = this.turns.filter(turn => turn !== local);
          this.render();
          if (error instanceof WorkspaceError && draftConflicts.includes(error.code)) await this.reload();
        }
        throw error;
      }
    });
  },

  answer(event: WechatMiniprogram.TouchEvent): Promise<void> | undefined {
    const { option, turn } = event.currentTarget.dataset;
    const parent = this.data.turns.find(item => item.id === turn && item.canAnswer);
    if (!parent || typeof option !== 'string' || !parent.questions.some(question => question.options.includes(option))) return;
    this.card('answer');
    return this.submit(option, [], { intent: 'draft', turnId: parent.id, answer: option });
  },

  retry(event: WechatMiniprogram.TouchEvent) {
    const turn = this.turns.find(item => item.id === event.currentTarget.dataset.id);
    if (!turn || this.data.busy || this.data.polling || this.data.text.trim() || this.data.attachments.length) return;
    this.card('retry');
    this.setData({ text: turn.text, attachments: turn.materialIds.map((id, index) => ({ id, name: `图片 ${index + 1}` })) });
  },

  undo(event: WechatMiniprogram.TouchEvent) {
    if (this.data.polling) return;
    const id = String(event.currentTarget.dataset.id ?? '');
    this.card('undo');
    return this.run(async () => {
      try { await this.request(`/agent/turns/${id}/undo`, {}); }
      finally { await this.reload(); }
    });
  },

  confirm(event: WechatMiniprogram.TouchEvent) {
    const previewId = String(event.currentTarget.dataset.id ?? '');
    const turn = this.data.turns.find(turn => turn.preview?.id === previewId && turn.preview.active);
    if (this.data.polling || !turn) return;
    this.card('confirm');
    return this.run(async () => {
      try {
        await this.request('/trips/confirm', { previewId });
        await this.reload();
      } catch (error) {
        if (error instanceof WorkspaceError && draftConflicts.includes(error.code)) {
          await this.reload();
          if (!this.data.confirmed) this.setData({ text: this.data.text || '生成送货单' });
        }
        throw error;
      }
    });
  },

  continueEditing(event: WechatMiniprogram.TouchEvent) {
    const draft = this.draft;
    if (!draft || this.data.polling || !this.data.turns.some(turn => turn.id === event.currentTarget.dataset.turn && turn.preview?.active)) return;
    return this.run(async () => {
      await this.request('/agent/card-actions', { action: 'edit', draftId: draft.id, revision: draft.revision,
        turnId: event.currentTarget.dataset.turn });
      await this.reload();
    });
  },

  openWorkspace() {
    if (this.data.busy || !agentSession.token) return;
    this.card('workspace');
    wx.navigateTo({ url: '/pages/workspace/index?from=agent' });
  },

  showPickingList() {
    this.card('picking');
    wx.switchTab({ url: '/pages/trip-picking/index' });
  },

  chooseImage(event: WechatMiniprogram.TouchEvent) {
    const draft = this.draft;
    const { album, key } = event.currentTarget.dataset;
    if (!draft || this.data.confirmed || this.data.polling || this.data.attachments.length >= imageLimit) return;
    return this.run(async () => {
      const linked = this.data.uploadRows.find(row => row.requestId === key);
      const file = await chooseMaterial(album === 'yes');
      if (!file) return;
      if (!materialImagePattern.test(file.name)) throw new Error('请选择 JPG、PNG、WebP 或 HEIC 图片。');
      const info = await materialInfo(file.path);
      if (linked && (info.digest !== linked.digest || info.size !== linked.size)) throw new Error('请选择同一张原图续传。');
      const source = linked ?? { ...info, requestId: newId(), draftId: draft.id, revision: draft.revision, name: file.name };
      await stageMaterial(source, file.path);
      await this.upload(source, linked?.id);
    });
  },

  async upload(source: MaterialSource, id?: string) {
    this.pauseUpload = false;
    this.setData({ pendingMaterial: source.name, uploadLabel: '正在上传' });
    try {
      const material = await transferMaterial(source, agentSession.token, progress => {
        this.setData({ uploadLabel: `上传 ${Math.floor(100 * progress.received / progress.size)}%` });
      }, () => !this.pauseUpload && !!agentSession.token, id);
      if (material) {
        forgetStaged([material]);
        this.setData({ uploadRows: this.data.uploadRows.filter(row => row.requestId !== material.requestId) });
        this.attach(material);
      }
    } finally { this.setData({ pendingMaterial: '', uploadLabel: '' }); }
  },

  images() {
    const draft = this.draft;
    if (!draft || this.data.polling) return;
    return this.run(async () => {
      const { materials } = await workspaceRequest<{ materials: Material[] }>('GET', '/materials', agentSession.token);
      const local = stagedMaterials().filter(item => item.draftId === draft.id);
      const current = materials.filter(item => item.draftId === draft.id);
      const remote = current.filter(item => item.status === 'uploading').map(item =>
        ({ ...item, local: local.some(source => sameMaterial(source, item)) }));
      this.setData({ readyImages: current.filter(item => item.status === 'ready' && !item.organized &&
        !this.data.attachments.some(attached => attached.id === item.id)),
        uploadRows: [...remote, ...local.filter(item => item.revision === draft.revision &&
          !current.some(material => material.requestId === item.requestId)).map(item => ({ ...item, local: true }))] });
    });
  },

  resumeImage(event: WechatMiniprogram.TouchEvent) {
    const source = this.data.uploadRows.find(row => row.requestId === event.currentTarget.dataset.key);
    if (this.data.confirmed || this.data.polling || !source?.local || this.data.attachments.length >= imageLimit) return;
    return this.run(() => this.upload(source, source.id));
  },

  attach(image: Attachment) {
    if (this.data.attachments.some(item => item.id === image.id) || this.data.attachments.length >= imageLimit) return;
    this.setData({ attachments: [...this.data.attachments, { id: image.id, name: image.name }],
      readyImages: this.data.readyImages.filter(item => item.id !== image.id) });
  },

  attachReady(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.polling || this.data.confirmed) return;
    const image = this.data.readyImages.find(item => item.id === event.currentTarget.dataset.id);
    if (image) this.attach(image);
  },

  removeImage(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy) return;
    this.setData({ attachments: this.data.attachments.filter(item => item.id !== event.currentTarget.dataset.id) });
  },

  record() {
    const draft = this.draft;
    if (!draft || this.data.polling) return;
    return this.run(async () => {
      this.setData({ voicePhase: '准备录音', voiceRetry: false });
      try {
        this.voiceCapture = startVoiceRecording(() => this.setData({ voicePhase: '录音中' }));
        const path = await this.voiceCapture.done;
        this.voiceFile = { draft, path };
        await this.transcribe();
      } finally { this.voiceCapture = null; this.setData({ voicePhase: '' }); }
    });
  },

  stopRecording() {
    if (this.data.voicePhase !== '录音中') return;
    this.setData({ voicePhase: '结束录音' });
    this.voiceCapture?.stop();
  },

  retryVoice() {
    if (!this.data.polling && this.voiceFile) return this.run(() => this.transcribe());
  },

  async transcribe() {
    const file = this.voiceFile;
    if (!file) return;
    this.setData({ voicePhase: '正在转写', voiceRetry: false });
    try {
      const bytes = await readVoiceFile(file.path);
      const result = await transcribeVoice(file.draft, bytes, agentSession.token, true);
      if (result.draftId !== this.draft?.id || result.revision !== this.draft.revision) throw new Error('草稿已变化，请重新录音。');
      const text = [this.data.text.trim(), result.text.trim()].filter(Boolean).join('\n');
      if (!result.text.trim()) throw new Error('语音转写没有返回文字，请重试。');
      if (text.length > textOrderLimit) throw new Error('转写后文字太长，请缩短输入框内容再重试。');
      this.voiceFile = null;
      this.setData({ text });
    } catch (error) {
      if (error instanceof VoiceFileError || (error instanceof WorkspaceError && error.status < 500)) this.voiceFile = null;
      this.setData({ voiceRetry: !!this.voiceFile });
      throw error;
    } finally { this.setData({ voicePhase: '' }); }
  },
});
