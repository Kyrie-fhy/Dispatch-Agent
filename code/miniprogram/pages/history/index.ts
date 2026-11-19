import { localDay } from '../../core/settlement';
import type { TripHistoryPage, TripHistoryRow } from '../../core/trips';
import { agentSession } from '../../services/agent-session';
import { FormalTrip, WorkspaceError, workspaceRequest } from '../../services/workspace';
import { amountLabel, errorMessage } from '../order-view';
import { formalTripView, FormalView } from '../workspace/trip-view';

function present(row: TripHistoryRow) {
  const date = new Date(row.issuedAt);
  return { ...row, time: localDay(date) + ' ' +
    [date.getHours(), date.getMinutes()].map(value => String(value).padStart(2, '0')).join(':'),
    total: amountLabel(row.totalCents, row.pendingPrices, '送货金额') };
}

Page({
  data: { signedIn: false, busy: false, error: '', trips: [] as ReturnType<typeof present>[], nextBefore: '',
    formal: null as FormalView | null, onTripTab: false },
  generation: 0,
  token: '',

  onShow(): Promise<void> | undefined {
    const token = agentSession.token;
    if (token !== this.token) {
      this.token = token;
      this.generation++;
      this.setData({ signedIn: !!token, trips: [], nextBefore: '', formal: null, error: '', busy: false });
    }
    if (!token) return;
    const id = this.data.formal?.id;
    return id ? this.loadTrip(id) : this.loadList();
  },

  goAssistant(): void { wx.switchTab({ url: '/pages/agent/index' }); },

  async run(action: (current: () => boolean, token: string) => Promise<void>) {
    const token = agentSession.token;
    if (!token || this.data.busy) return;
    const generation = this.generation;
    const current = () => token === agentSession.token && generation === this.generation;
    this.setData({ busy: true, error: '' });
    try { await action(current, token); }
    catch (error) {
      if (!current()) return;
      if (error instanceof WorkspaceError && error.status === 401) {
        agentSession.token = '';
        agentSession.unsaved = null;
        this.token = '';
        this.setData({ signedIn: false, trips: [], formal: null, nextBefore: '', busy: false, error: '登录已失效，请重新登录。' });
      } else this.setData({ error: errorMessage(error) });
    } finally { if (current()) this.setData({ busy: false }); }
  },

  loadList(before = ''): Promise<void> {
    return this.run(async (current, token) => {
      const page = await workspaceRequest<TripHistoryPage>('GET', '/trips?limit=20' + (before ? '&before=' + before : ''), token);
      if (!current()) return;
      this.setData({ trips: [...(before ? this.data.trips : []), ...page.trips.map(present)], nextBefore: page.nextBefore ?? '' });
    });
  },

  loadMore() { if (this.data.nextBefore) return this.loadList(this.data.nextBefore); },

  openTrip(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id ?? '');
    if (this.data.trips.some(trip => trip.id === id)) return this.loadTrip(id);
  },

  loadTrip(id: string): Promise<void> {
    return this.run(async (current, token) => {
      const result = await workspaceRequest<FormalTrip>('GET', '/trips/' + id, token);
      if (current()) this.setData({ formal: formalTripView(result) });
    });
  },

  backToList() {
    if (!this.data.busy) this.setData({ formal: null, error: '' });
  },
});
