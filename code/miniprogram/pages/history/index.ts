import type { AgentTurn, DeliveryCardState, DeliveryProposal } from '../../core/agent';
import { money } from '../../core/orders';
import { localDay } from '../../core/settlement';
import type { TripHistoryPage, TripHistoryRow } from '../../core/trips';
import { agentSession } from '../../services/agent-session';
import { FormalTrip, WorkspaceError, workspaceRequest } from '../../services/workspace';
import { amountLabel, errorMessage, tripView } from '../order-view';
import { formalTripView, FormalView } from '../workspace/trip-view';

type HistoryTab = 'delivery' | 'picking' | 'turns';
type HistoryTurnView = {
  id: string;
  text: string;
  pictures: number;
  changes: string[];
  undone: boolean;
  questions: string[];
  previewLabel: string;
  deliverySummary: { customer: string; edits: DeliveryProposal['edits']; totalLabel: string; outcome: string } | null;
  reply: string;
};

function present(row: TripHistoryRow) {
  const date = new Date(row.issuedAt);
  return { ...row, time: localDay(date) + ' ' +
    [date.getHours(), date.getMinutes()].map(value => String(value).padStart(2, '0')).join(':'),
    total: amountLabel(row.totalCents, row.pendingPrices, '送货金额') };
}

function historyTurnView(turn: AgentTurn): HistoryTurnView {
  const changes: string[] = [];
  const questions: string[] = [];
  let undone = false;
  let previewLabel = '';
  let proposal: DeliveryProposal | null = null;
  let applied: DeliveryCardState | null = null;
  let reply = '';
  for (const event of turn.events) {
    if (event.kind === 'change') changes.push(...event.payload.lines);
    if (event.kind === 'undo') undone = true;
    if (event.kind === 'questions') questions.push(...event.payload.questions.map(question =>
      question.customer ? `${question.customer}：${question.text}` : question.text));
    if (event.kind === 'preview') previewLabel = '送货单预览 · ' + tripView(event.payload.preview).totalLabel;
    if (event.kind === 'delivery_proposal') proposal = event.payload;
    if (event.kind === 'delivery_applied') applied = event.payload.status;
    if (event.kind === 'end') reply = event.payload.text;
  }
  const outcome = applied === 'completed' ? '已确认送达' : applied === 'saved' ? '已保存修改'
    : applied === 'cancelled' ? '已取消' : '未执行';
  return {
    id: turn.id, text: turn.text, pictures: turn.materialIds.length, changes, undone, questions, previewLabel,
    deliverySummary: proposal ? { customer: proposal.customer, edits: proposal.edits,
      totalLabel: '¥' + money(proposal.totalCents), outcome } : null,
    reply: changes.length && reply === '草稿已更新。' ? '' : reply,
  };
}

Page({
  data: { signedIn: false, busy: false, error: '', trips: [] as ReturnType<typeof present>[], nextBefore: '',
    formal: null as FormalView | null, onTripTab: false, selectedTime: '', historyTab: 'delivery' as HistoryTab,
    selectedShopId: '', selectedShop: null as FormalView['deliveryRows'][number] | null,
    tripTurns: [] as HistoryTurnView[], turnsLoadedId: '', turnsLoading: false },
  generation: 0,
  token: '',

  onShow(): Promise<void> | undefined {
    const token = agentSession.token;
    if (token !== this.token) {
      this.token = token;
      this.generation++;
      this.setData({ signedIn: !!token, trips: [], nextBefore: '', formal: null, error: '', busy: false,
        selectedTime: '', historyTab: 'delivery', selectedShopId: '', selectedShop: null, tripTurns: [], turnsLoadedId: '' });
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
        this.setData({ signedIn: false, trips: [], formal: null, nextBefore: '', busy: false, error: '登录已失效，请重新登录。',
          selectedTime: '', historyTab: 'delivery', selectedShopId: '', selectedShop: null, tripTurns: [], turnsLoadedId: '' });
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
    const trip = this.data.trips.find(item => item.id === id);
    if (!trip) return;
    this.setData({ selectedTime: trip.time, formal: null, historyTab: 'delivery', selectedShopId: '',
      selectedShop: null, tripTurns: [], turnsLoadedId: '', error: '' });
    return this.loadTrip(id);
  },

  async loadTrip(id: string): Promise<void> {
    await this.run(async (current, token) => {
      const result = await workspaceRequest<FormalTrip>('GET', '/trips/' + id, token);
      if (!current()) return;
      const formal = formalTripView(result);
      const selectedShop = formal.deliveryRows.find(row => row.id === this.data.selectedShopId) ?? null;
      this.setData({ formal, selectedShopId: selectedShop?.id ?? '', selectedShop });
    });
    if (this.data.historyTab === 'turns' && this.data.formal?.id === id) await this.loadTurns(id);
  },

  switchHistoryTab(event: WechatMiniprogram.TouchEvent) {
    const tab = String(event.currentTarget.dataset.tab ?? '') as HistoryTab;
    if (tab !== 'delivery' && tab !== 'picking' && tab !== 'turns') return;
    this.setData({ historyTab: tab });
    const id = this.data.formal?.id;
    if (tab === 'turns' && id && this.data.turnsLoadedId !== id) return this.loadTurns(id);
  },

  async loadTurns(tripId: string): Promise<void> {
    this.setData({ turnsLoading: true });
    try {
      await this.run(async (current, token) => {
        const result = await workspaceRequest<{ tripId: string; turns: AgentTurn[] }>('GET', '/trips/' + tripId + '/turns', token);
        if (!current()) return;
        this.setData({ tripTurns: result.turns.map(historyTurnView), turnsLoadedId: tripId });
      });
    } finally { this.setData({ turnsLoading: false }); }
  },

  openHistoryShop(event: WechatMiniprogram.TouchEvent) {
    const sheetId = String(event.currentTarget.dataset.sheetId ?? '');
    const shop = this.data.formal?.deliveryRows.find(row => row.id === sheetId);
    if (shop) this.setData({ selectedShopId: sheetId, selectedShop: shop });
  },

  closeHistoryShop() { this.setData({ selectedShopId: '', selectedShop: null }); },

  backToList() {
    if (!this.data.busy) this.setData({ formal: null, selectedTime: '', historyTab: 'delivery', selectedShopId: '',
      selectedShop: null, tripTurns: [], turnsLoadedId: '', error: '' });
  },
});
