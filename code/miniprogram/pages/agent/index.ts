import type { AgentEvent, AgentStatus, AgentTurn } from '../../core/agent';
import { materialImagePattern, Material, MaterialSource } from '../../core/materials';
import { textOrderLimit } from '../../core/text-order';
import type { TripDraft } from '../../core/trips';
import { agentSession } from '../../services/agent-session';
import { newId } from '../../services/ids';
import { chooseMaterial, forgetStaged, materialInfo, sameMaterial, stagedMaterials, stageMaterial,
  transferMaterial } from '../../services/materials';
import { readVoiceFile, startVoiceRecording, transcribeVoice, VoiceFileError } from '../../services/voice';
import { FormalTrip, revokeSession, wechatCode, WorkspaceError, workspaceRequest } from '../../services/workspace';
import { errorMessage, tripView } from '../order-view';

type Conversation = { draft: TripDraft; draftConfirmed: boolean; turns: AgentTurn[] };
type PollResult = { status: AgentStatus; events: AgentEvent[] };
type Attachment = { id: string; name: string };
type VoiceFile = { draft: TripDraft; path: string };
const draftConflicts = ['draft_changed', 'draft_confirmed', 'draft_not_found', 'preview_not_found', 'material_draft_changed'];
const imageLimit = 4;

function view(turn: AgentTurn, revision: number, confirmed: boolean, last: boolean, dismissed: string) {
  const progress = new Map<number, { text: string; done: boolean; step: number }>();
  const changes: string[] = [];
  let undone = false;
  let end: Extract<AgentEvent, { kind: 'end' }>['payload'] | undefined;
  let preview: Extract<AgentEvent, { kind: 'preview' }>['payload']['preview'] | undefined;
  let questions: Extract<AgentEvent, { kind: 'questions' }>['payload']['questions'] = [];
  for (const event of turn.events) {
    if (event.kind === 'progress') progress.set(event.payload.step, event.payload);
    if (event.kind === 'preview') preview = event.payload.preview;
    if (event.kind === 'end') end = event.payload;
    if (event.kind === 'change') changes.push(...event.payload.lines);
    if (event.kind === 'undo') undone = true;
    if (event.kind === 'questions') questions = event.payload.questions;
  }
  const showPreview = turn.id !== dismissed;
  return { id: turn.id, text: turn.text, pictures: turn.materialIds.length, progress: [...progress.values()], questions, changes, undone,
    status: turn.status, reply: questions.length && end?.status === 'completed' ? '' : end?.text ?? '',
    canAnswer: last && !confirmed && !undone && turn.status === 'completed',
    canRetry: last && (turn.status === 'failed' || turn.status === 'interrupted'),
    canUndo: !confirmed && !undone && !!changes.length && end?.revision === revision && turn.status !== 'running',
    preview: preview && showPreview ? { ...tripView(preview), id: preview.previewId,
      active: last && !confirmed && preview.revision === revision && turn.status === 'completed' } : null,
  };
}

Page({
  data: {
    signedIn: false, busy: false, polling: false, confirmed: false, error: '', text: '', textOrderLimit,
    turns: [] as ReturnType<typeof view>[], attachments: [] as Attachment[], pendingMaterial: '', uploadLabel: '',
    draftsAvailable: false, scrollTo: '', voicePhase: '', voiceRetry: false,
    readyImages: [] as Attachment[], uploadRows: [] as (MaterialSource & { id?: string; local: boolean })[],
    picking: [] as FormalTrip['picking'], pickingCount: 0, showPicking: false, revokeFailed: false,
  },
  draft: null as TripDraft | null,
  turns: [] as AgentTurn[],
  generation: 0,
  visible: false,
  timer: null as ReturnType<typeof setTimeout> | null,
  dismissedPreview: '',
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
    this.draft = null;
    this.turns = [];
    this.pending.clear();
    this.voiceFile = null;
    this.dismissedPreview = '';
    this.setData({ signedIn: false, busy: false, polling: false, confirmed: false, draftsAvailable: false,
      error: '', text: '', turns: [], attachments: [], readyImages: [], uploadRows: [], pendingMaterial: '',
      scrollTo: '', picking: [], pickingCount: 0, showPicking: false, voiceRetry: false, revokeFailed: !!this.retiredToken });
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

  refresh() { return this.run(() => this.reload()); },

  async reload(): Promise<void> {
    const token = agentSession.token;
    if (!token) return;
    const generation = this.generation;
    const { draft, draftConfirmed, turns } = await workspaceRequest<Conversation>('GET', '/agent/conversation', token);
    if (generation !== this.generation) return;
    const sameTrip = !this.draft || this.draft.id === draft.id;
    this.draft = draft;
    this.turns = turns;
    const active = this.turns.find(turn => turn.status === 'running');
    this.setData({ confirmed: draftConfirmed, draftsAvailable: true, polling: !!active,
      ...(!sameTrip ? { attachments: [], readyImages: [], uploadRows: [], showPicking: false, pendingMaterial: '' } : {}),
      ...(!draftConfirmed ? { picking: [], pickingCount: 0 } : {}) });
    this.render();
    if (active) this.schedule();
    if (draftConfirmed) {
      const { picking } = await workspaceRequest<FormalTrip>('GET', `/trips/${draft.id}`, token);
      if (generation === this.generation) this.setData({ picking, pickingCount: picking.length });
    }
  },

  render() {
    const revision = this.draft?.revision ?? -1;
    const turns = this.turns.map((turn, index) => view(turn, revision, this.data.confirmed,
      index === this.turns.length - 1, this.dismissedPreview));
    this.setData({ turns, scrollTo: '' });
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
      if (generation !== this.generation || this.turns.find(item => item.id === turn.id) !== turn) return;
      turn.events.push(...result.events);
      turn.status = result.status;
      this.setData({ polling: result.status === 'running', error: '' });
      this.render();
      if (result.status === 'running') this.schedule();
      else await this.reload();
    } catch (error) {
      if (generation !== this.generation) return;
      this.showError(error);
      if (agentSession.token) this.setData({ error: `${errorMessage(error)}。消息仍在，可点刷新对话恢复进度。` });
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

  send() {
    const draft = this.draft;
    const text = this.data.text.trim();
    const materialIds = this.data.attachments.map(item => item.id);
    if (!draft || !agentSession.token || this.data.polling || (!text && !materialIds.length)) return;
    return this.run(async () => {
      const generation = this.generation;
      try {
        const { turnId } = await this.request<{ turnId: string }>('/agent/turns',
          { draftId: draft.id, revision: draft.revision, text, materialIds });
        if (generation !== this.generation) return;
        if (!this.turns.some(turn => turn.id === turnId)) this.turns.push({ id: turnId, text, materialIds,
          revision: draft.revision, events: [], status: 'running' });
        this.setData({ text: '', attachments: [], readyImages: [], polling: true });
        this.render();
        this.schedule();
      } catch (error) {
        if (generation === this.generation && error instanceof WorkspaceError && draftConflicts.includes(error.code)) await this.reload();
        throw error;
      }
    });
  },

  answer(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.polling) return;
    const text = String(event.currentTarget.dataset.option ?? '');
    if (this.data.text.trim() || this.data.attachments.length) {
      this.setData({ error: '输入框已有内容，请先发送或清空。' });
      return;
    }
    this.card('answer');
    this.setData({ text });
    return this.send();
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
        const { picking } = await this.request<FormalTrip>('/trips/confirm', { previewId });
        this.setData({ confirmed: true, picking, pickingCount: picking.length });
        this.render();
      } catch (error) {
        if (error instanceof WorkspaceError && draftConflicts.includes(error.code)) {
          this.dismissedPreview = turn.id;
          this.render();
          await this.reload();
          if (!this.data.confirmed) this.setData({ text: this.data.text || '生成送货单' });
        }
        throw error;
      }
    });
  },

  continueEditing(event: WechatMiniprogram.TouchEvent) {
    this.card('edit');
    this.dismissedPreview = String(event.currentTarget.dataset.turn ?? '');
    this.render();
  },

  openWorkspace() {
    if (this.data.busy || !agentSession.token) return;
    this.card('workspace');
    wx.navigateTo({ url: '/pages/workspace/index?from=agent' });
  },

  showPickingList() {
    this.card('picking');
    this.setData({ showPicking: true });
    this.render();
  },

  nextTrip() {
    if (!this.draft || !this.data.confirmed || this.data.polling) return;
    const draftId = this.draft.id;
    this.card('next');
    return this.run(async () => {
      await this.request('/trips/next-draft', { draftId });
      await this.reload();
    });
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
    if (!draft || this.data.confirmed || this.data.polling) return;
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
    if (!draft || this.data.confirmed || this.data.polling) return;
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
    if (!this.data.confirmed && !this.data.polling && this.voiceFile) return this.run(() => this.transcribe());
  },

  async transcribe() {
    const file = this.voiceFile;
    if (!file) return;
    this.setData({ voicePhase: '正在转写', voiceRetry: false });
    try {
      const bytes = await readVoiceFile(file.path);
      const result = await transcribeVoice(file.draft, bytes, agentSession.token);
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
