import type { TripDraft } from '../../core/trips';
import { agentSession } from '../../services/agent-session';
import { revokeSession, wechatCode, Workspace, WorkspaceError, workspaceRequest } from '../../services/workspace';
import { errorMessage } from '../order-view';

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
      loaded: false, tripMode: '', tripDetail: '', partyCount: 0, canEditForm: false });
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
      loaded: false, tripMode: '', tripDetail: '', partyCount: 0, canEditForm: false });
    return this.run(async () => {
      const generation = this.generation;
      try { await revokeSession(this.retiredToken); }
      catch { throw new Error('本机已退出登录，但服务端会话撤销失败，请点击「重试退出」再试一次。'); }
      if (generation !== this.generation) return;
      this.retiredToken = '';
      this.setData({ revokeFailed: false });
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
