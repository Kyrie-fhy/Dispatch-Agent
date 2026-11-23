import type { TripDraft } from '../../core/trips';
import { agentSession } from '../../services/agent-session';
import { newId } from '../../services/ids';
import { revokeSession, wechatCode, Workspace, WorkspaceError, workspaceRequest } from '../../services/workspace';
import { errorMessage } from '../order-view';

type AliasView = { alias: string; canonicalName: string };
type CatalogSummary = { productCount: number; variantCount: number; activeVariantCount: number;
  discontinuedVariantCount: number; missingUnitVariantCount: number };

function draftCounts(draft: TripDraft) {
  let customers = 0;
  let lines = 0;
  for (const customer of draft.customers) {
    const valid = customer.items.filter(line =>
      Boolean(line.product || line.quantity || line.price || line.brand || line.specification)).length;
    if (valid) {
      customers += 1;
      lines += valid;
    }
  }
  return { customers, lines };
}

Page({
  data: {
    signedIn: false,
    busy: false,
    error: '',
    revokeFailed: false,
    loaded: false,
    tripMode: '',
    tripDetail: '',
    partyCount: 0,
    canEditForm: false,
    aliases: [] as AliasView[],
    aliasesLoaded: false,
    aliasError: '',
    catalogSummary: null as CatalogSummary | null,
    catalogError: '',
  },
  generation: 0,
  retiredToken: '',

  onShow(): Promise<void> | undefined {
    if (!agentSession.token) {
      this.clear();
      return;
    }
    this.setData({ signedIn: true });
    if (!this.data.busy) return this.run(() => this.reload());
  },

  clear(error = '') {
    this.generation += 1;
    this.setData({ signedIn: false, busy: false, error, revokeFailed: !!this.retiredToken,
      loaded: false, tripMode: '', tripDetail: '', partyCount: 0, canEditForm: false,
      aliases: [], aliasesLoaded: false, aliasError: '', catalogSummary: null, catalogError: '' });
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
      agentSession.token = '';
      agentSession.unsaved = null;
      agentSession.deliveryCustomer = null;
      agentSession.deliveryTarget = null;
      this.clear('登录已失效，请重新登录。');
      return;
    }
    this.setData({ error: errorMessage(error) });
  },

  async reload(): Promise<void> {
    const token = agentSession.token;
    if (!token) return;
    const generation = this.generation;
    const result = await workspaceRequest<Workspace>('GET', '/workspace', token);
    if (generation !== this.generation || token !== agentSession.token) return;
    const { customers, lines } = draftCounts(result.draft);
    this.setData({
      loaded: true,
      tripMode: result.draftConfirmed ? '送货进行中' : '晚间录单中',
      tripDetail: result.draftConfirmed
        ? (result.currentTrip ? `第 ${result.currentTrip.version} 版正式单已生成` : '本趟正式单已生成')
        : (customers ? `本趟草稿 ${customers} 家 ${lines} 行` : '本趟草稿暂无货品'),
      partyCount: result.parties.length,
      canEditForm: !result.draftConfirmed,
    });
    const [aliasResult, catalogResult] = await Promise.all([
      workspaceRequest<{ aliases: AliasView[] }>('GET', '/customer-aliases', token).then(
        ({ aliases }) => ({ aliases, error: '' }),
        () => ({ aliases: null, error: '叫法列表没加载出来，重进本页可重试。' })),
      workspaceRequest<CatalogSummary>('GET', '/catalog/summary', token).then(
        summary => ({ summary, error: '' }),
        () => ({ summary: null, error: '货品库信息没加载出来' })),
    ]);
    if (generation !== this.generation || token !== agentSession.token) return;
    if (aliasResult.aliases) this.setData({ aliases: aliasResult.aliases.map(({ alias, canonicalName }) =>
      ({ alias, canonicalName })), aliasesLoaded: true, aliasError: '' });
    else this.setData({ aliasError: aliasResult.error });
    if (catalogResult.summary) this.setData({ catalogSummary: catalogResult.summary, catalogError: '' });
    else this.setData({ catalogError: catalogResult.error });
  },

  login(): Promise<void> | undefined {
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

  logout(): Promise<void> | undefined {
    if (this.data.busy) return;
    this.retiredToken = agentSession.token || this.retiredToken;
    agentSession.token = '';
    agentSession.unsaved = null;
    agentSession.deliveryCustomer = null;
    agentSession.deliveryTarget = null;
    this.generation += 1;
    this.setData({ signedIn: false, busy: false, error: '', revokeFailed: !!this.retiredToken,
      loaded: false, tripMode: '', tripDetail: '', partyCount: 0, canEditForm: false,
      aliases: [], aliasesLoaded: false, aliasError: '', catalogSummary: null, catalogError: '' });
    return this.run(async () => {
      const generation = this.generation;
      try { await revokeSession(this.retiredToken); }
      catch { throw new Error('本机已退出登录，但服务端会话撤销失败，请点击「重试退出」再试一次。'); }
      if (generation !== this.generation) return;
      this.retiredToken = '';
      this.setData({ revokeFailed: false });
    });
  },

  unbindAlias(event: WechatMiniprogram.TouchEvent) {
    const alias = String(event.currentTarget.dataset.alias ?? '');
    const name = String(event.currentTarget.dataset.name ?? '');
    if (!alias || this.data.busy) return;
    if (typeof wx.showModal !== 'function') return this.unbind(alias);
    wx.showModal({
      title: '解绑叫法',
      content: name ? `解绑后再说「${alias}」不会自动认成${name}。` : `解绑后再说「${alias}」不会自动认成这家熟客。`,
      confirmText: '解绑',
      success: ({ confirm }) => { if (confirm) void this.unbind(alias); },
      fail: () => this.setData({ error: '确认框打开失败，请重试。' }),
    });
  },

  unbind(alias: string): Promise<void> | undefined {
    if (this.data.busy || !agentSession.token) return;
    return this.run(async () => {
      await workspaceRequest('POST', '/customer-aliases/unbind', agentSession.token, { requestId: newId(), alias });
      await this.reload();
    });
  },

  openWorkspace(): void {
    if (agentSession.token && !this.data.busy && this.data.canEditForm) {
      wx.navigateTo({ url: '/pages/workspace/index?from=agent' });
    }
  },

  goAssistant(): void {
    wx.switchTab({ url: '/pages/agent/index' });
  },
});
