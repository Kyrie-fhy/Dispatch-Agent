import type { AgentEvent, AgentStatus, AgentTurn, DeliveryCardState, DeliveryProgress, DeliveryProposal, DirectIntent, PlanStep, Question, StepState } from '../../core/agent';
import type { CustomerMention, DraftPriceSuggestion } from '../../core/memory';
import { lineAmount, money, nullablePrice, validTextPrice, yuanToCents } from '../../core/orders';
import type { ItemInput } from '../../core/orders';
import { materialImagePattern, Material, MaterialSource } from '../../core/materials';
import { textOrderLimit, textOrderQuestions } from '../../core/text-order';
import type { TripDraft, TripPreview } from '../../core/trips';
import { agentSession } from '../../services/agent-session';
import { newId } from '../../services/ids';
import { chooseMaterial, forgetStaged, materialInfo, sameMaterial, stagedMaterials, stageMaterial,
  transferMaterial } from '../../services/materials';
import { readVoiceFile, startVoiceRecording, transcribeVoice, VoiceFileError } from '../../services/voice';
import { revokeSession, wechatCode, WorkspaceError, workspaceRequest } from '../../services/workspace';
import { errorMessage, catalogHintText, catalogReferencePrices, lineMetaLabel, lineNameOnly, priceSourceLabel, productLabel, tripView } from '../order-view';

type Conversation = { draft: TripDraft; draftConfirmed: boolean; confirmedPreviewId?: string | null; turns: AgentTurn[]; delivery?: DeliveryProgress | null };
type PollResult = { status: AgentStatus; events: AgentEvent[] };
type Attachment = { id: string; name: string };
type VoiceFile = { draft: TripDraft; path: string };
type AgentMemory = { draftId: string; revision: number; confirmed: boolean; customers: { id: string; name: string }[];
  mentions: { draftCustomerId: string; resolution: CustomerMention }[]; prices: DraftPriceSuggestion[];
  catalogChoices?: CatalogChoice[] };
type ChoiceView = { draftCustomerId: string; spoken: string; remember: boolean;
  candidates: { id: string; name: string }[]; hint: string };
type CatalogCandidate = { productId: string; variantId: string; product: string; brand: string; specification: string;
  unit: string | null; priceCents: number; status: 'active' | 'discontinued' };
type CatalogChoice = { draftCustomerId: string; lineId: string; status: 'ambiguous'; priceHint: string | null;
  candidates: CatalogCandidate[] };
type CatalogCandidateView = { variantId: string; label: string; name: string; priceLabel: string; warn: boolean };
type CatalogChoiceView = { draftCustomerId: string; lineId: string; customerName: string; lineLabel: string; hint: string;
  candidates: CatalogCandidateView[] };
type PriceUpdate = { draftCustomerId: string; lineId: string; product: string; beforePrice: string | null;
  beforeSource: string | null; price: string | null; priceSource: string | null; text: string };
type CatalogChoiceResult = { revision: number; item: ItemInput; priceUpdates: PriceUpdate[] };
type CustomerMerge = 'append' | 'keep_existing';
type ChoiceResult = { revision: number; remembered: boolean | null; rememberIssue?: string; priceUpdates?: PriceUpdate[] };
type ChoicePayload = { draftCustomerId: string; choice: 'existing'; customerId: string; remember: boolean; merge?: CustomerMerge }
  | { draftCustomerId: string; choice: 'new' }
  | { draftCustomerId: string; choice: 'unlink'; spoken: string };
type PriceOption = { cents: number; text: string; brand?: string; spec?: string };
type PriceHint = { draftCustomerId: string; lineId: string; text: string; options: PriceOption[]; adoptable: boolean };
type PriceAdoptLine = { draftCustomerId: string; lineId: string; unitPriceCents: number;
  variant?: { brand: string; spec: string } };
type QuestionView = Question & { missingCustomer: boolean };
type PriceDrawerRow = { lineId: string; draftCustomerId: string; customerName: string; showCustomer: boolean;
  productName: string; quantity: string; unit: string; price: string; metaLabel: string; discontinued: boolean;
  refButtons: { value: string; label: string }[]; showSpec: boolean;
  inputUnit: string; inputSpecification: string; originalUnit: string; originalSpecification: string };
type SheetPreviewCustomer = ReturnType<typeof tripView>['customers'][number] & {
  pendingPrices: number; allPending: boolean; displayTotal: string };
type SheetPreview = Omit<ReturnType<typeof tripView>, 'customers'> & {
  id: string; pendingPrices: number; allPending: boolean; displayTotal: string;
  customers: SheetPreviewCustomer[] };
type CustomerSheet = { id: string; label: string; value: string };
const draftConflicts = ['draft_changed', 'draft_confirmed', 'draft_not_found', 'preview_not_found', 'material_draft_changed'];
const choiceConflicts = ['draft_changed', 'draft_confirmed', 'draft_not_found', 'agent_busy', 'customer_already_linked',
  'customer_not_linked', 'draft_customer_not_found'];
const priceConflicts = ['draft_changed', 'draft_confirmed', 'draft_not_found', 'agent_busy',
  'price_suggestion_changed', 'price_not_suggested'];
const catalogConflicts = ['draft_changed', 'draft_confirmed', 'draft_not_found', 'agent_busy',
  'catalog_choice_changed', 'draft_line_not_found'];
const imageLimit = 4;

// 只用于展示判断，规则与 core/memory 的 normalizeMemoryText 保持一致。
function sameName(left: string, right: string): boolean {
  const clean = (value: string) => value.replace(/[！-～]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .trim().replace(/\s+/g, ' ').toLowerCase();
  return clean(left) === clean(right);
}

function shortDate(issuedAt: string): string {
  const date = new Date(issuedAt);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function catalogCandidateView(candidate: CatalogCandidate): CatalogCandidateView {
  const name = [candidate.brand, candidate.product, candidate.specification].filter(Boolean).join(' ');
  const price = money(candidate.priceCents);
  const priced = candidate.unit ? `· ${candidate.unit} ¥${price}` : `· 库内 ¥${price}（未标单位）`;
  return { variantId: candidate.variantId, warn: candidate.status === 'discontinued',
    name: name || '未命名货品',
    priceLabel: candidate.unit ? `¥${price}/${candidate.unit}` : `库内 ¥${price}`,
    label: `${name} ${priced}${candidate.status === 'discontinued' ? ' · 已下架' : ''}` };
}

function priceHintView(suggestion: DraftPriceSuggestion): PriceHint | null {
  const base = { draftCustomerId: suggestion.draftCustomerId, lineId: suggestion.lineId };
  if (suggestion.status === 'exact_match' || suggestion.status === 'unique_variant_match') {
    const variant = suggestion.status === 'unique_variant_match'
      ? [suggestion.brand, suggestion.spec].filter(Boolean).join(' ') : '';
    const options: PriceOption[] = [{ cents: suggestion.unitPriceCents, text: '沿用' }];
    let text = `上次${variant ? ` ${variant}` : ''} ¥${money(suggestion.unitPriceCents)}（${shortDate(suggestion.issuedAt)}）`;
    if (suggestion.previousDistinctPrice) {
      const earlier = suggestion.previousDistinctPrice;
      text += ` · 更早 ¥${money(earlier.unitPriceCents)}（${shortDate(earlier.issuedAt)}）`;
      options.push({ cents: earlier.unitPriceCents, text: `用 ¥${money(earlier.unitPriceCents)}` });
    }
    return { ...base, text, options, adoptable: true };
  }
  if (suggestion.status === 'ambiguous_variants') {
    return { ...base, text: '上次买过几种，选一种', adoptable: false,
      options: suggestion.candidates.map(candidate => ({
        cents: candidate.unitPriceCents,
        text: `${[candidate.brand, candidate.spec].filter(Boolean).join(' ') || '未写规格'} ¥${money(candidate.unitPriceCents)}`,
        brand: candidate.brand, spec: candidate.spec,
      })) };
  }
  return null;
}

const stepIcon: Record<StepState, string> = { pending: '○', running: '', done: '✓', needs_input: '！', failed: '✗', skipped: '–' };
type StepView = PlanStep & { state: StepState; result?: string };

function view(turn: AgentTurn, revision: number, confirmed: boolean, last: boolean, latestPreview: boolean, confirmedPreviewId: string,
  delivery: DeliveryProgress | null, draft: TripDraft | null) {
  let plan: PlanStep[] = [];
  const progress = new Map<string, StepView>();
  const changes: string[] = [];
  let undone = false;
  let end: Extract<AgentEvent, { kind: 'end' }>['payload'] | undefined;
  let preview: Extract<AgentEvent, { kind: 'preview' }>['payload']['preview'] | undefined;
  let questions: Question[] = [];
  let proposal: DeliveryProposal | undefined;
  let deliveryState: DeliveryCardState | undefined;
  let links: { draftCustomerId: string; spoken: string; label: string }[] = [];
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
    if (event.kind === 'customer_links') for (const link of event.payload.links) {
      if (link.merged) continue;
      const customer = draft?.customers.find(entry => entry.id === link.draftCustomerId);
      if (!customer || customer.partyId !== link.customerId) continue;
      links.push({ draftCustomerId: link.draftCustomerId, spoken: link.spoken,
        label: sameName(link.spoken, link.canonicalName) ? `${link.canonicalName}：认出熟客`
          : `${link.spoken} → ${link.canonicalName}` });
    }
  }
  if (!(last && !confirmed && !undone && turn.status === 'completed')) links = [];
  questions = questions.filter(question => !draft || !question.text.includes('是哪家熟客？')
    || draft.customers.some(customer => customer.partyId === undefined && customer.customer.trim() === (question.customer || '').trim()));
  // 补好店名后旧追问立即消失，仍在缺口时再给出就地填写入口。
  questions = questions.filter(question => !draft || !question.text.includes('客户名称')
    || draft.customers.some(customer => !customer.customer.trim()));
  const questionViews: QuestionView[] = questions.map(question =>
    ({ ...question, missingCustomer: question.text.includes('客户名称') }));
  const showChoices = Boolean(last && !confirmed && turn.status === 'completed');
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
  const deliveryActive = Boolean(proposal && !stale && !deliveryState && turn.status === 'completed');
  const canAnswer = Boolean(last && (!confirmed || plan.some(step => step.id === 'delivery-check')) && !undone &&
    turn.status === 'completed' && end?.revision === revision);
  const canUndo = Boolean(!confirmed && !undone && !!changes.length && end?.revision === revision && turn.status !== 'running');
  const showNameCard = Boolean(canAnswer && !confirmed && questionViews.some(question => question.missingCustomer));
  const allDelivered = Boolean(delivery && delivery.shops.length > 0 && delivery.shops.every(shop => shop.locked));
  const showDeliveryFooter = Boolean(last && confirmed && turn.status === 'completed' && !deliveryActive);
  const runningStepText = turn.status === 'running'
    ? checklist.find(item => item.state === 'running')?.text
      || checklist.find(item => item.state !== 'done' && item.state !== 'skipped')?.text
      || '正在整理…'
    : '';
  const endText = (end?.text ?? '').trim();
  let summaryText = '';
  const addedCount = changes.reduce((sum, line) => {
    const match = /^新增 (\d+) 行$/.exec(line);
    return match ? sum + Number(match[1]) : sum;
  }, 0);
  if (turn.status !== 'running') {
    if (undone) summaryText = '这一步已撤回';
    else if (endText && !(endText === '草稿已更新。' && changes.length)) summaryText = endText;
    else if (changes.length) summaryText = addedCount > 0 ? `已记上 ${addedCount} 样货` : '已更新本单明细';
    else if (preview) summaryText = '送货单预览已准备好，核对后点确认出单';
    else if (proposal) summaryText = '已整理门店送货核对卡';
    else if (turn.status === 'failed' || turn.status === 'interrupted') summaryText = '这一步没跑完，可以把原消息放回输入框重试';
  }
  const showChangeList = Boolean(changes.length) && turn.status !== 'running';
  return { id: turn.id, text: turn.text, pictures: turn.materialIds.length, checklist, questions: questionViews, changes, undone, issued, links, showChoices,
    status: turn.status, runningStepText, summaryText, showChangeList,
    reply: changes.length && end?.text === '草稿已更新。' ? '' : end?.text ?? '',
    elapsed: end?.elapsedMs === undefined ? '' : `用时 ${Math.max(1, Math.round(end.elapsedMs / 1000))} 秒`,
    canAnswer, showNameCard, showDeliveryFooter, allDelivered,
    canRetry: last && (turn.status === 'failed' || turn.status === 'interrupted'),
    canUndo,
    preview: preview ? { ...tripView(preview), id: preview.previewId,
      active: !skipped && latestPreview && !confirmed && turn.status === 'completed' } : null,
    delivery: proposal ? { ...proposal, totalLabel: `¥${money(proposal.totalCents)}`, pendingLabel: proposal.pendingPriceNames.join('、'),
      active: deliveryActive, stale, notice: deliveryState === 'saved' ? '已保存修改' :
        deliveryState === 'completed' ? '已确认送达，应收已锁定' : deliveryState === 'cancelled' ? '已取消' : '' } : null,
  };
}

function deliverySummaryView(progress: DeliveryProgress) {
  const unfinished = progress.shops.filter(shop => !shop.locked).map(shop => shop.customer);
  const totalCount = progress.shops.length;
  const deliveredCount = totalCount - unfinished.length;
  const allDelivered = totalCount > 0 && unfinished.length === 0;
  const knownTotalCents = progress.shops.reduce((sum, shop) => sum + shop.totalCents, 0);
  const pendingPricesTotal = progress.shops.reduce((sum, shop) => sum + shop.pendingPrices, 0);
  return { label: `本趟送货 · ${deliveredCount}/${totalCount} 家已送达`,
    unfinished, allDelivered, deliveredCount, totalCount, knownTotalCents, pendingPricesTotal,
    pillTitle: allDelivered ? '本趟已全部送达' : `送货中 · ${deliveredCount}/${totalCount} 家已送`,
    pillSub: knownTotalCents === 0 && pendingPricesTotal > 0 ? `待补价（${pendingPricesTotal} 项）`
      : `预计应收 ¥${money(knownTotalCents)}${pendingPricesTotal ? ` · ${pendingPricesTotal} 项待补价` : ''}`,
    shops: progress.shops.map(shop => ({ ...shop, description: `${shop.locked ? '已锁定应收' : '预计应收'} ¥${money(shop.totalCents)}` +
      (shop.pendingPrices ? ` · ${shop.pendingPrices} 项待补价` : '') })) };
}

function draftSummary(draft: TripDraft, pending: number, choiceCount = 0, catalogChoiceCount = 0) {
  type SummaryLine = { id: string; product: string; nameOnly: string; metaLabel: string; quantity: string; unit: string;
    price: string; pending: boolean; priceSource: string; priceSourceLabel: string; discontinued: boolean;
    priceHint: string; catalogHint: string; secondaryText: string };
  type SummaryCustomer = { id: string; name: string; unnamed: boolean; lines: SummaryLine[] };
  const customers: SummaryCustomer[] = draft.customers.map(customer => ({
    id: customer.id, name: customer.customer || '未命名客户', unnamed: !customer.customer.trim(),
    lines: customer.items.filter(line => line.product || line.quantity || line.price || line.brand || line.specification)
      .map(line => {
        const metaLabel = lineMetaLabel(line);
        const discontinued = line.catalogStatus === 'discontinued';
        const catalogHint = catalogHintText(line.priceHint, discontinued);
        const price = nullablePrice(line.price);
        return { id: line.id, product: productLabel(line) || '未命名货品', nameOnly: lineNameOnly(line),
          metaLabel, quantity: line.quantity, unit: line.unit,
          price: price ? '¥' + price : '待填价', pending: price === null,
          priceSource: line.priceSource ?? '', priceSourceLabel: priceSourceLabel(line.priceSource),
          discontinued, priceHint: line.priceHint ?? '', catalogHint,
          secondaryText: [metaLabel, catalogHint].filter(Boolean).join(' · ') };
      }),
  })).filter(customer => customer.lines.length);
  const lines = customers.reduce((sum, customer) => sum + customer.lines.length, 0);
  const issues = pending || (lines ? textOrderQuestions(draft).reduce((sum, customer) => sum + customer.issues.length, 0) : 0);
  const pendingCount = customers.reduce((sum, customer) => sum + customer.lines.filter(line => line.pending).length, 0);
  const discontinuedCount = customers.reduce((sum, customer) => sum + customer.lines.filter(line => line.discontinued).length, 0);
  let knownTotalCents = 0;
  for (const customer of draft.customers) for (const line of customer.items) {
    if (!(line.product || line.quantity || line.price || line.brand || line.specification)) continue;
    const price = nullablePrice(line.price);
    const quantity = line.quantity.trim();
    if (price === null || !validTextPrice(price) || !/^[1-9]\d*$/.test(quantity)) continue;
    knownTotalCents += lineAmount(Number(quantity), yuanToCents(price)) ?? 0;
  }
  const hasKnownAmount = knownTotalCents > 0;
  const knownTotalLabel = hasKnownAmount ? '¥' + money(knownTotalCents)
    : (pendingCount > 0 ? '待填价' : '¥0.00');
  const alertText = [pendingCount ? `${pendingCount} 样待填价` : '',
    discontinuedCount ? `${discontinuedCount} 样已下架，请查库存` : ''].filter(Boolean).join(' · ');
  const unnamedCustomers = draft.customers.flatMap((customer, index) => customer.customer.trim()
    ? [] : [{ id: customer.id, label: `第 ${index + 1} 位客户` }]);
  const unnamedLineCounts: Record<string, number> = {};
  for (const customer of draft.customers) {
    unnamedLineCounts[customer.id] = customer.items.filter(line =>
      line.product || line.quantity || line.price || line.brand || line.specification).length;
  }
  const unnamedCount = customers.filter(customer => customer.unnamed).length;
  const todoParts = [unnamedCount ? `${unnamedCount} 家待填店名` : '',
    choiceCount ? `${choiceCount} 家待确认客户` : '',
    catalogChoiceCount ? `${catalogChoiceCount} 样待选款` : '',
    pendingCount ? `${pendingCount} 样待填价` : '',
    discontinuedCount ? `${discontinuedCount} 样已下架` : ''].filter(Boolean);
  const hasTodo = todoParts.length > 0;
  return { customers, hasLines: lines > 0, customerCount: customers.length, lineCount: lines,
    unnamedCount, pendingCount, discontinuedCount, knownTotalCents, knownTotalLabel, hasKnownAmount,
    todoParts, hasTodo, todoText: hasTodo ? todoParts.join(' · ') : '单价齐全，可直接出单',
    alertText, unnamedCustomers, unnamedLineCounts,
    label: `当前整单 · ${customers.length} 家 ${lines} 样${issues ? `，${issues} 处待确认` : ''}` };
}

function applyNavTitle(title: string) {
  if (typeof wx.setNavigationBarTitle === 'function') wx.setNavigationBarTitle({ title });
}

Page({
  data: {
    signedIn: false, busy: false, polling: false, confirmed: false, error: '', text: '', textOrderLimit,
    turns: [] as ReturnType<typeof view>[], attachments: [] as Attachment[], pendingMaterial: '', uploadLabel: '',
    draftsAvailable: false, scrollTo: '', voicePhase: '', voiceRetry: false, inputMode: 'text' as 'text' | 'voice',
    readyImages: [] as Attachment[], uploadRows: [] as (MaterialSource & { id?: string; local: boolean })[],
    draftSummary: null as ReturnType<typeof draftSummary> | null, issuedCard: false, revokeFailed: false,
    deliverySummary: null as ReturnType<typeof deliverySummaryView> | null, navTitle: '录单助手', focusInput: false, imageLimit,
    voiceCorrectionHint: '',
    choices: [] as ChoiceView[], memoryNames: [] as string[], rememberOff: {} as Record<string, boolean>,
    memoryFailed: false, notice: '', priceHints: {} as Record<string, PriceHint>, adoptableCount: 0,
    catalogChoices: [] as CatalogChoiceView[],
    memoryCustomers: [] as { id: string; name: string }[], quickCustomers: [] as { id: string; name: string }[],
    priceDrawerOpen: false, priceDrawerRows: [] as PriceDrawerRow[], priceDrawerError: '', priceDrawerFocusId: '',
    orderSheetOpen: false, orderSheetTab: 'all' as 'all' | 'pending', orderSheetStep: 'list' as 'list' | 'preview',
    orderSheetScrollTop: 0,
    sheetPreview: null as SheetPreview | null,
    priceDrawerDirty: false,
    customerSheet: null as CustomerSheet | null, inlineCustomerDrafts: {} as Record<string, string>,
  },
  draft: null as TripDraft | null,
  turns: [] as AgentTurn[],
  generation: 0,
  visible: false,
  timer: null as ReturnType<typeof setTimeout> | null,
  confirmedPreviewId: '',
  delivery: null as DeliveryProgress | null,
  memory: null as AgentMemory | null,
  pending: new Map<string, string>(),
  voiceCapture: null as ReturnType<typeof startVoiceRecording> | null,
  voiceFile: null as VoiceFile | null,
  voiceMeta: null as { rawText: string; corrections: { from: string; to: string }[] } | null,
  discardVoice: false,
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
    this.voiceMeta = null;
    this.confirmedPreviewId = '';
    this.delivery = null;
    this.memory = null;
    this.setData({ signedIn: false, busy: false, polling: false, confirmed: false, draftsAvailable: false,
      error: '', text: '', turns: [], attachments: [], readyImages: [], uploadRows: [], pendingMaterial: '',
      scrollTo: '', draftSummary: null, deliverySummary: null, navTitle: '录单助手', focusInput: false,
      issuedCard: false, voiceRetry: false, inputMode: 'text', revokeFailed: !!this.retiredToken,
      voiceCorrectionHint: '', choices: [], memoryNames: [], rememberOff: {}, memoryFailed: false, notice: '', priceHints: {}, adoptableCount: 0,
      catalogChoices: [], memoryCustomers: [], quickCustomers: [], priceDrawerOpen: false, priceDrawerRows: [],
      priceDrawerError: '', priceDrawerFocusId: '', orderSheetOpen: false, orderSheetTab: 'all', orderSheetStep: 'list',
      orderSheetScrollTop: 0,
      sheetPreview: null, priceDrawerDirty: false, customerSheet: null, inlineCustomerDrafts: {} });
    applyNavTitle('录单助手');
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

  async reload(scrollToLatest?: boolean): Promise<void> {
    const token = agentSession.token;
    if (!token) return;
    const generation = this.generation;
    const { draft, draftConfirmed, confirmedPreviewId, turns, delivery } = await workspaceRequest<Conversation>('GET', '/agent/conversation', token);
    if (generation !== this.generation || token !== agentSession.token) return;
    const hadDraft = Boolean(this.draft);
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
    if (changedMode || !sameTrip) {
      this.voiceFile = null;
      this.voiceMeta = null;
    }
    this.setData({ confirmed: draftConfirmed, draftsAvailable: true, polling: !!active,
      ...(changedMode || !sameTrip ? { text: '', attachments: [], readyImages: [], uploadRows: [],
        pendingMaterial: '', voiceRetry: false, inputMode: 'text', voiceCorrectionHint: '',
        orderSheetOpen: false, orderSheetTab: 'all', orderSheetStep: 'list', sheetPreview: null,
        orderSheetScrollTop: 0,
        priceDrawerOpen: false, priceDrawerRows: [], priceDrawerDirty: false, priceDrawerError: '', priceDrawerFocusId: '' } : {}),
      ...(prefill ? { text: `${target.name}：`, focusInput: !active, inputMode: 'text' } : { focusInput: false }) });
    await this.loadMemory(draft, draftConfirmed, generation, token);
    if (generation !== this.generation || token !== agentSession.token) return;
    this.render(scrollToLatest ?? (!hadDraft || !sameTrip || changedMode));
    if (active) this.schedule();
    if (!draftConfirmed) void this.syncMaterials(draft, generation);
  },

  async loadMemory(draft: TripDraft, confirmed: boolean, generation: number, token: string) {
    if (confirmed) {
      this.memory = null;
      this.setData({ memoryFailed: false });
      return;
    }
    try {
      const memory = await workspaceRequest<AgentMemory>('GET', `/agent/memory?draftId=${draft.id}`, token);
      if (generation !== this.generation || token !== agentSession.token || this.draft?.id !== draft.id) return;
      this.memory = memory;
      this.setData({ memoryFailed: false });
    } catch {
      if (generation !== this.generation || token !== agentSession.token) return;
      this.setData({ memoryFailed: true });
    }
  },

  render(scrollToLatest = false) {
    const revision = this.draft?.revision ?? -1;
    const preview = [...this.turns].reverse().find(turn => turn.events.some(event => event.kind === 'preview') &&
      !turn.events.some(event => event.kind === 'step' && event.payload.id === 'confirm' && event.payload.state === 'skipped'));
    const choices: ChoiceView[] = [];
    const memory = this.draft && this.memory && this.memory.draftId === this.draft.id &&
      this.memory.revision === this.draft.revision && !this.data.confirmed ? this.memory : null;
    if (memory && this.draft) for (const item of memory.mentions) {
      const customer = this.draft.customers.find(entry => entry.id === item.draftCustomerId);
      if (!customer || customer.partyId !== undefined || !customer.customer.trim()) continue;
      const resolution = item.resolution;
      choices.push({ draftCustomerId: item.draftCustomerId, spoken: customer.customer,
        remember: !this.data.rememberOff[item.draftCustomerId],
        candidates: resolution.status === 'resolved'
          ? [{ id: resolution.customerId, name: resolution.canonicalName }]
          : resolution.status === 'ambiguous' || resolution.status === 'candidate_only'
            ? resolution.candidates.map(candidate => ({ id: candidate.customerId, name: candidate.canonicalName })) : [],
        hint: resolution.status === 'resolved' ? '是不是这家？'
          : resolution.status === 'ambiguous' ? '有几家同名，请选一家'
            : resolution.status === 'candidate_only' ? '像下面这几家' : '熟客里没有这个叫法' });
    }
    const memoryNames = memory ? memory.customers.map(customer => customer.name) : [];
    const memoryCustomers = memory ? memory.customers.map(customer => ({ id: customer.id, name: customer.name })) : [];
    const quickCustomers = memoryCustomers.slice(0, 8);
    const catalogChoices: CatalogChoiceView[] = [];
    if (memory && this.draft) for (const choice of memory.catalogChoices ?? []) {
      const customer = this.draft.customers.find(entry => entry.id === choice.draftCustomerId);
      const line = customer?.items.find(entry => entry.id === choice.lineId);
      if (!customer || !line) continue;
      catalogChoices.push({ draftCustomerId: choice.draftCustomerId, lineId: choice.lineId,
        customerName: customer.customer || '未命名客户',
        lineLabel: [line.product || '未命名货品', line.quantity, line.unit].filter(Boolean).join(' '),
        hint: choice.priceHint || '库内有多款货品或规格，请选定后核对单价',
        candidates: choice.candidates.map(catalogCandidateView) });
    }
    const priceHints: Record<string, PriceHint> = {};
    let adoptableCount = 0;
    if (memory) for (const suggestion of memory.prices) {
      const hint = priceHintView(suggestion);
      if (!hint) continue;
      priceHints[hint.lineId] = hint;
      if (hint.adoptable) adoptableCount += 1;
    }
    const turns = this.turns.map((turn, index) => view(turn, revision, this.data.confirmed,
      index === this.turns.length - 1, preview?.id === turn.id, this.confirmedPreviewId, this.delivery, this.draft));
    const recent = turns[turns.length - 1];
    const deliverySummary = this.delivery ? deliverySummaryView(this.delivery) : null;
    const draftInfo = !this.data.confirmed && this.draft
      ? draftSummary(this.draft, recent?.canAnswer ? recent.questions.length : 0, choices.length, catalogChoices.length) : null;
    const navTitle = !this.data.signedIn || !this.data.confirmed ? '录单助手'
      : (this.delivery && this.delivery.shops.length
        ? `送货助手（${this.delivery.shops.filter(shop => shop.locked).length}/${this.delivery.shops.length} 已送达）`
        : '送货助手');
    this.setData({ turns, scrollTo: '', issuedCard: turns.some(turn => turn.issued),
      deliverySummary, draftSummary: draftInfo, navTitle, choices, memoryNames, priceHints, adoptableCount,
      catalogChoices, memoryCustomers, quickCustomers });
    if (scrollToLatest) this.setData({ scrollTo: 'latest' });
    applyNavTitle(navTitle);
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

  editText(event: WechatMiniprogram.TextareaInput) {
    const text = event.detail.value;
    if (!text.trim()) {
      this.voiceMeta = null;
      this.setData({ text, voiceCorrectionHint: '' });
    } else this.setData({ text });
  },

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

  putRequest<T>(path: string, input: object) {
    const key = JSON.stringify(['PUT', path, input]);
    let requestId = this.pending.get(key);
    if (!requestId) {
      requestId = newId();
      this.pending.set(key, requestId);
    }
    return workspaceRequest<T>('PUT', path, agentSession.token, { ...input, requestId }).then(result => {
      this.pending.delete(key);
      return result;
    }, error => {
      if (error instanceof WorkspaceError && error.status < 500) this.pending.delete(key);
      throw error;
    });
  },

  notify(text: string) {
    if (typeof wx.showToast === 'function') wx.showToast({ title: text, icon: 'none' });
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

  copyTurnText(event: WechatMiniprogram.TouchEvent): void {
    const id = String(event.currentTarget.dataset.turn ?? '');
    const text = (this.data.turns.find(turn => turn.id === id)?.text ?? '').trim();
    if (!text || this.data.busy) return;
    const apply = () => {
      this.voiceMeta = null;
      this.setData({ text, inputMode: 'text', focusInput: true, voiceCorrectionHint: '' });
      if (typeof wx.setClipboardData === 'function') wx.setClipboardData({ data: text, fail: () => {} });
      if (typeof wx.showToast === 'function') wx.showToast({ title: '已放回输入框，改完即可发', icon: 'none' });
    };
    const current = this.data.text.trim();
    if (current && current !== text && typeof wx.showModal === 'function') {
      wx.showModal({
        title: '替换输入框内容',
        content: '输入框里已有字，要换成这条原话重新编辑吗？',
        confirmText: '替换原话',
        success: ({ confirm }) => { if (confirm) apply(); },
        fail: () => {},
      });
      return;
    }
    apply();
  },

  submit(text: string, materialIds: string[], direct?: DirectIntent): Promise<void> | undefined {
    const draft = this.draft;
    if (!draft || !agentSession.token || this.data.busy || this.data.polling || (!text && !materialIds.length)) return;
    const local: AgentTurn = { id: 'sending', text, materialIds, revision: draft.revision, events: [], status: 'running' };
    this.turns.push(local);
    this.render(true);
    return this.run(async () => {
      const generation = this.generation;
      const token = agentSession.token;
      try {
        const { turnId } = await this.request<{ turnId: string }>('/agent/turns',
          { draftId: draft.id, revision: draft.revision, text, materialIds,
            ...(direct ? { direct } : {}), ...(!direct && this.voiceMeta ? { voiceMeta: this.voiceMeta } : {}) });
        if (generation !== this.generation || token !== agentSession.token) return;
        this.turns = this.turns.filter(turn => turn !== local);
        if (!this.turns.some(turn => turn.id === turnId)) this.turns.push({ ...local, id: turnId });
        if (!direct) this.voiceMeta = null;
        this.setData({ ...(!direct ? { text: '', attachments: [], readyImages: [], voiceCorrectionHint: '' } : {}), polling: true });
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

  chooseCustomer(event: WechatMiniprogram.TouchEvent): Promise<void> | undefined {
    const draftCustomerId = String(event.currentTarget.dataset.customer ?? '');
    const customerId = String(event.currentTarget.dataset.party ?? '');
    const choice = this.data.choices.find(item => item.draftCustomerId === draftCustomerId);
    if (!choice || !customerId) return;
    return this.choose({ draftCustomerId, choice: 'existing', customerId, remember: choice.remember });
  },

  pickCustomer(event: WechatMiniprogram.PickerChange): Promise<void> | undefined {
    const draftCustomerId = String(event.currentTarget.dataset.customer ?? '');
    const choice = this.data.choices.find(item => item.draftCustomerId === draftCustomerId);
    const customer = this.memory?.customers[Number(event.detail.value)];
    if (!choice || !customer) return;
    return this.choose({ draftCustomerId, choice: 'existing', customerId: customer.id, remember: choice.remember });
  },

  newCustomer(event: WechatMiniprogram.TouchEvent): Promise<void> | undefined {
    const draftCustomerId = String(event.currentTarget.dataset.customer ?? '');
    if (!this.data.choices.some(item => item.draftCustomerId === draftCustomerId)) return;
    return this.choose({ draftCustomerId, choice: 'new' });
  },

  notHim(event: WechatMiniprogram.TouchEvent): Promise<void> | undefined {
    const { turn: turnId, customer } = event.currentTarget.dataset;
    const link = this.data.turns.find(turn => turn.id === turnId)?.links.find(item => item.draftCustomerId === customer);
    if (!link) return;
    return this.choose({ draftCustomerId: link.draftCustomerId, choice: 'unlink', spoken: link.spoken });
  },

  toggleRemember(event: WechatMiniprogram.TouchEvent) {
    const draftCustomerId = String(event.currentTarget.dataset.customer ?? '');
    if (!draftCustomerId) return;
    this.setData({ rememberOff: { ...this.data.rememberOff, [draftCustomerId]: !this.data.rememberOff[draftCustomerId] } });
    this.render();
  },

  reloadMemory(): Promise<void> | undefined {
    return this.run(() => this.reload());
  },

  async reloadAfterConflict(error: unknown, codes: string[]) {
    if (!(error instanceof WorkspaceError) || !codes.includes(error.code)) return;
    try {
      await this.reload();
    } catch (refreshError) {
      if (refreshError instanceof WorkspaceError && refreshError.status === 401) throw refreshError;
    }
  },

  async saveCustomerChoice(draft: TripDraft, payload: ChoicePayload): Promise<ChoiceResult | undefined> {
    const generation = this.generation;
    const send = (choice: ChoicePayload) => this.request<ChoiceResult>(
      '/agent/customer-choice', { draftId: draft.id, revision: draft.revision, ...choice });
    try {
      return await send(payload);
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'customer_merge_review' ||
        payload.choice !== 'existing' || payload.merge || typeof wx.showActionSheet !== 'function') throw error;
      const merge = await new Promise<CustomerMerge | undefined>((resolve, reject) => wx.showActionSheet({
        alertText: error.message,
        itemList: ['追加新增明细', '同款保留原明细'],
        success: ({ tapIndex }) => resolve(tapIndex === 0 ? 'append' : tapIndex === 1 ? 'keep_existing' : undefined),
        fail: ({ errMsg }) => {
          if (errMsg.includes('cancel')) resolve(undefined);
          else reject(error);
        },
      }));
      if (merge && generation === this.generation) return send({ ...payload, merge });
      return undefined;
    }
  },

  choose(payload: ChoicePayload): Promise<void> | undefined {
    const draft = this.draft;
    if (!draft || this.data.busy || this.data.polling) return;
    const spoken = this.data.choices.find(item => item.draftCustomerId === payload.draftCustomerId)?.spoken ?? '';
    this.setData({ notice: '' });
    return this.run(async () => {
      try {
        const result = await this.saveCustomerChoice(draft, payload);
        if (!result) return;
        await this.reload();
        if (this.data.orderSheetOpen) {
          this.setData({ priceDrawerError: '',
            ...(!this.data.priceDrawerDirty ? { priceDrawerRows: this.buildPriceRows() } : {}) });
        }
        if (result.remembered === true) {
          if (typeof wx.showToast === 'function') wx.showToast({ title: '已记住叫法', icon: 'success' });
        }
        const notices: string[] = [];
        if (result.remembered === false && result.rememberIssue === 'name_conflict') {
          notices.push(`已选好店。${spoken ? `「${spoken}」` : '这个叫法'}和另一家的正式店名一样，没有记住这个叫法。`);
        }
        const updates = (result.priceUpdates ?? []).map(update => update.text).filter(Boolean);
        if (updates.length) notices.push(`按熟客价更新：${updates.join('；')}`);
        if (notices.length) this.setData({ notice: notices.join(' ') });
      } catch (error) {
        await this.reloadAfterConflict(error, choiceConflicts);
        throw error;
      }
    });
  },

  openCustomerSheet(event: WechatMiniprogram.TouchEvent): void {
    if (this.data.confirmed || this.data.busy || this.data.polling) return;
    const id = String(event.currentTarget.dataset.customer ?? '');
    const customer = this.draft?.customers.find(entry => entry.id === id);
    if (!customer) return;
    this.setData({ error: '', customerSheet: { id, label: customer.customer.trim() || '未命名客户',
      value: this.data.inlineCustomerDrafts[id] ?? customer.customer } });
  },

  closeCustomerSheet(): void {
    this.setData({ customerSheet: null });
  },

  editInlineCustomerName(event: WechatMiniprogram.Input) {
    const id = String(event.currentTarget.dataset.customer ?? '');
    if (!id) return;
    this.setData({ inlineCustomerDrafts: { ...this.data.inlineCustomerDrafts, [id]: event.detail.value } });
  },

  editSheetCustomerName(event: WechatMiniprogram.Input) {
    if (!this.data.customerSheet) return;
    this.setData({ customerSheet: { ...this.data.customerSheet, value: event.detail.value } });
  },

  saveInlineCustomerName(event: WechatMiniprogram.TouchEvent): Promise<void> | undefined {
    const id = String(event.currentTarget.dataset.customer ?? '');
    if (!id) return;
    return this.saveCustomerName(id, this.data.inlineCustomerDrafts[id] ?? '', () => {
      const rest = { ...this.data.inlineCustomerDrafts };
      delete rest[id];
      this.setData({ inlineCustomerDrafts: rest });
    });
  },

  saveCustomerSheet(): Promise<void> | undefined {
    const sheet = this.data.customerSheet;
    if (!sheet) return;
    return this.saveCustomerName(sheet.id, sheet.value, () => this.setData({ customerSheet: null }));
  },

  pickQuickCustomer(event: WechatMiniprogram.TouchEvent): Promise<void> | undefined {
    const draftCustomerId = String(event.currentTarget.dataset.customer ?? '');
    const customerId = String(event.currentTarget.dataset.party ?? '');
    if (!draftCustomerId || !customerId) return;
    return this.associateCustomer(draftCustomerId, customerId);
  },

  pickCustomerForUnnamed(event: WechatMiniprogram.PickerChange): Promise<void> | undefined {
    const draftCustomerId = String(event.currentTarget.dataset.customer ?? '');
    const customer = this.memory?.customers[Number(event.detail.value)];
    if (!draftCustomerId || !customer) return;
    return this.associateCustomer(draftCustomerId, customer.id);
  },

  async associateCustomer(draftCustomerId: string, customerId: string): Promise<void> {
    await this.choose({ draftCustomerId, choice: 'existing', customerId, remember: false });
    if (this.data.error) return;
    const rest = { ...this.data.inlineCustomerDrafts };
    delete rest[draftCustomerId];
    this.setData({ customerSheet: null, inlineCustomerDrafts: rest });
  },

  async saveCustomerName(draftCustomerId: string, raw: string, onSaved: () => void): Promise<void> {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) {
      this.setData({ notice: '请先输入客户名称' });
      this.notify('请先输入客户名称');
      return;
    }
    const draft = this.draft;
    if (!draft || !agentSession.token || this.data.busy) return;
    const matched = (this.memory?.customers ?? []).find(customer => sameName(customer.name, trimmed));
    if (matched) {
      await this.choose({ draftCustomerId, choice: 'existing', customerId: matched.id, remember: false });
      if (this.data.error) return;
      onSaved();
      if (typeof wx.showToast === 'function') wx.showToast({ title: '已保存店名', icon: 'success' });
      return;
    }
    await this.run(async () => {
      try {
        const zeroCustomers = Boolean(this.memory && this.memory.customers.length === 0);
        const customers = draft.customers.map(customer => customer.id === draftCustomerId
          ? { ...customer, customer: trimmed, ...(zeroCustomers ? { partyId: null } : {}) } : customer);
        await this.putRequest(`/drafts/${draft.id}`, { revision: draft.revision, customers });
        onSaved();
        await this.reload();
        if (this.data.orderSheetOpen) {
          this.setData({ priceDrawerError: '',
            ...(!this.data.priceDrawerDirty ? { priceDrawerRows: this.buildPriceRows() } : {}) });
        }
        if (this.data.choices.length > 0) this.scrollOrderSheetTop();
        if (typeof wx.showToast === 'function') wx.showToast({ title: '已保存店名', icon: 'success' });
      } catch (error) {
        await this.reloadAfterConflict(error, draftConflicts);
        throw error;
      }
    });
  },

  buildPriceRows(): PriceDrawerRow[] {
    const draft = this.draft;
    if (!draft) return [];
    const rows: PriceDrawerRow[] = draft.customers.flatMap(customer => customer.items
      .filter(line => Boolean(line.product.trim()) && nullablePrice(line.price) === null).map(line => {
        const discontinued = line.catalogStatus === 'discontinued';
        return { lineId: line.id, draftCustomerId: customer.id,
          customerName: customer.customer.trim() || '未命名客户', showCustomer: false,
          productName: lineNameOnly(line), quantity: line.quantity, unit: line.unit, price: '',
          metaLabel: [lineMetaLabel(line), catalogHintText(line.priceHint, discontinued)].filter(Boolean).join(' · '),
          discontinued, refButtons: catalogReferencePrices(line.priceHint),
          showSpec: false, inputUnit: line.unit, inputSpecification: line.specification,
          originalUnit: line.unit, originalSpecification: line.specification };
      }));
    const customerCount = new Set(rows.map(row => row.draftCustomerId)).size;
    return rows.map(row => ({ ...row, showCustomer: customerCount > 1 }));
  },

  scrollOrderSheetTop(): void {
    this.setData({ orderSheetScrollTop: this.data.orderSheetScrollTop === 0 ? 1 : 0 });
  },

  openOrderSheet(event?: WechatMiniprogram.TouchEvent): void {
    if (!this.draft || this.data.confirmed || this.data.busy || this.data.polling) return;
    const tab = event?.currentTarget?.dataset?.tab === 'pending' ? 'pending' : 'all';
    const lineId = String(event?.currentTarget?.dataset?.line ?? '');
    const keepDirty = Boolean(this.data.orderSheetOpen && this.data.priceDrawerDirty);
    const rows = keepDirty ? this.data.priceDrawerRows : this.buildPriceRows();
    this.setData({ error: '', orderSheetOpen: true, orderSheetTab: tab, orderSheetStep: 'list', sheetPreview: null,
      priceDrawerOpen: tab === 'pending', priceDrawerRows: rows, priceDrawerDirty: keepDirty, priceDrawerError: '',
      priceDrawerFocusId: tab === 'pending' && lineId && rows.some(row => row.lineId === lineId) ? `pf-${lineId}` : '' });
  },

  openPriceDrawer(event?: WechatMiniprogram.TouchEvent): void {
    if (!this.draft || this.data.confirmed || this.data.busy || this.data.polling) return;
    const rows = this.buildPriceRows();
    if (!rows.length) {
      this.setData({ priceDrawerOpen: false, orderSheetOpen: false, priceDrawerRows: [], priceDrawerFocusId: '',
        priceDrawerDirty: false, priceDrawerError: '' });
      this.notify('当前没有待填价货品');
      return;
    }
    const lineId = String(event?.currentTarget.dataset.line ?? '');
    this.setData({ error: '', orderSheetOpen: true, orderSheetTab: 'pending', orderSheetStep: 'list', sheetPreview: null,
      priceDrawerOpen: true, priceDrawerRows: rows, priceDrawerDirty: false, priceDrawerError: '',
      priceDrawerFocusId: lineId && rows.some(row => row.lineId === lineId) ? `pf-${lineId}` : '' });
  },

  switchOrderSheetTab(event: WechatMiniprogram.TouchEvent): void {
    const tab = event.currentTarget.dataset.tab === 'pending' ? 'pending' : 'all';
    if (tab === this.data.orderSheetTab && this.data.orderSheetStep === 'list') return;
    const priceDrawerRows = tab === 'pending'
      ? (this.data.priceDrawerDirty ? this.data.priceDrawerRows : this.buildPriceRows())
      : this.data.priceDrawerRows;
    this.setData({ orderSheetTab: tab, orderSheetStep: 'list', sheetPreview: null, priceDrawerOpen: tab === 'pending',
      priceDrawerRows, priceDrawerError: '', priceDrawerFocusId: '' });
  },

  closeOrderSheet(): void {
    this.setData({ orderSheetOpen: false, orderSheetTab: 'all', orderSheetStep: 'list', sheetPreview: null,
      priceDrawerOpen: false, priceDrawerRows: [], priceDrawerDirty: false, priceDrawerError: '', priceDrawerFocusId: '' });
  },

  closePriceDrawer(): void {
    this.closeOrderSheet();
  },

  editPriceDrawerPrice(event: WechatMiniprogram.Input) {
    const lineId = String(event.currentTarget.dataset.line ?? '');
    const priceDrawerRows = this.data.priceDrawerRows.map(row =>
      row.lineId === lineId ? { ...row, price: event.detail.value } : row);
    this.setData({ priceDrawerFocusId: '', priceDrawerRows, priceDrawerDirty: Boolean(this.priceDrawerCustomers(priceDrawerRows)) });
  },

  applyRefPrice(event: WechatMiniprogram.TouchEvent) {
    const lineId = String(event.currentTarget.dataset.line ?? '');
    const value = String(event.currentTarget.dataset.value ?? '');
    if (!value) return;
    const priceDrawerRows = this.data.priceDrawerRows.map(row =>
      row.lineId === lineId ? { ...row, price: value } : row);
    this.setData({ priceDrawerFocusId: '', priceDrawerRows, priceDrawerDirty: Boolean(this.priceDrawerCustomers(priceDrawerRows)) });
  },

  toggleDrawerSpec(event: WechatMiniprogram.TouchEvent) {
    const lineId = String(event.currentTarget.dataset.line ?? '');
    const priceDrawerRows = this.data.priceDrawerRows.map(row =>
      row.lineId === lineId ? { ...row, showSpec: !row.showSpec } : row);
    this.setData({ priceDrawerFocusId: '', priceDrawerRows, priceDrawerDirty: Boolean(this.priceDrawerCustomers(priceDrawerRows)) });
  },

  editPriceDrawerField(event: WechatMiniprogram.Input) {
    const lineId = String(event.currentTarget.dataset.line ?? '');
    const field = String(event.currentTarget.dataset.field ?? '');
    if (field !== 'unit' && field !== 'specification') return;
    const priceDrawerRows = this.data.priceDrawerRows.map(row => row.lineId !== lineId
      ? row : { ...row, [field === 'unit' ? 'inputUnit' : 'inputSpecification']: event.detail.value });
    this.setData({ priceDrawerFocusId: '', priceDrawerRows, priceDrawerDirty: Boolean(this.priceDrawerCustomers(priceDrawerRows)) });
  },

  validatePriceDrawer(rows: PriceDrawerRow[]): string {
    for (const row of rows) {
      const price = row.price.trim();
      if (price && !validTextPrice(price)) return `${row.productName}：单价需大于 0，最多两位小数`;
      if (row.inputUnit.trim() !== row.originalUnit.trim() && !row.inputUnit.trim()) {
        return `${row.productName}：单位不能为空`;
      }
    }
    return '';
  },

  priceDrawerCustomers(rows?: PriceDrawerRow[]): TripDraft['customers'] | null {
    const draft = this.draft;
    if (!draft) return null;
    const byLine = new Map((rows ?? this.data.priceDrawerRows).map(row => [row.lineId, row]));
    let changed = false;
    const customers = draft.customers.map(customer => ({ ...customer, items: customer.items.map(item => {
      const row = byLine.get(item.id);
      if (!row) return item;
      const price = row.price.trim() || null;
      const unit = row.inputUnit.trim();
      const specification = row.inputSpecification.trim();
      if (price !== nullablePrice(item.price) || unit !== item.unit || specification !== item.specification) {
        changed = true;
      }
      return { ...item, price, unit, specification };
    }) }));
    return changed ? customers : null;
  },

  savePriceDrawer(): Promise<void> | undefined {
    const draft = this.draft;
    if (!draft || this.data.busy) return;
    const invalid = this.validatePriceDrawer(this.data.priceDrawerRows);
    if (invalid) {
      this.setData({ priceDrawerError: invalid });
      return;
    }
    const customers = this.priceDrawerCustomers();
    if (!customers) {
      this.setData({ priceDrawerDirty: false, priceDrawerError: '' });
      this.notify('还没有改动');
      return;
    }
    this.setData({ priceDrawerError: '' });
    return this.run(async () => {
      try {
        await this.putRequest(`/drafts/${draft.id}`, { revision: draft.revision, customers });
        await this.reload();
        const nextRows = this.buildPriceRows();
        this.setData({ priceDrawerRows: nextRows, priceDrawerDirty: false, priceDrawerError: '', priceDrawerFocusId: '' });
        if (typeof wx.showToast === 'function') wx.showToast({ title: '已保存修改', icon: 'success' });
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'draft_confirmed') {
          this.closeOrderSheet();
          await this.reloadAfterConflict(error, draftConflicts);
          return;
        }
        if (error instanceof WorkspaceError && error.code === 'draft_changed') {
          await this.reloadAfterConflict(error, draftConflicts);
          this.setData({ priceDrawerError: '草稿已更新，请核对后再保存' });
          return;
        }
        this.setData({ priceDrawerError: errorMessage(error) });
      }
    });
  },

  previewInSheet(): Promise<void> | undefined {
    const draft = this.draft;
    if (!draft || this.data.confirmed || this.data.busy || this.data.polling) return;
    if (this.priceDrawerCustomers()) {
      const invalid = this.validatePriceDrawer(this.data.priceDrawerRows);
      this.setData({ priceDrawerError: invalid ? `${invalid}；请先点「保存价格」后再预览` : '请先点「保存价格」后再预览' });
      return;
    }
    const unnamed = this.data.draftSummary?.unnamedCustomers ?? [];
    if (unnamed.length > 0) {
      const first = unnamed[0];
      const customer = draft.customers.find(entry => entry.id === first.id);
      this.setData({ priceDrawerError: '', error: '',
        customerSheet: { id: first.id, label: '未命名客户',
          value: this.data.inlineCustomerDrafts[first.id] ?? customer?.customer ?? '' } });
      this.notify('先填上店名就能出单');
      return;
    }
    if (this.data.choices.length > 0) {
      this.scrollOrderSheetTop();
      this.setData({ priceDrawerError:
        `请先在上方确认「${this.data.choices[0].spoken}」是已有熟客还是新建客户` });
      return;
    }
    return this.run(async () => {
      try {
        const { preview } = await this.request<{ preview: TripPreview }>('/trips/preview',
          { draftId: draft.id, revision: draft.revision });
        const view = tripView(preview);
        const customers = view.customers.map(customer => {
          const customerPending = customer.items.filter(line => line.amountCents === null).length;
          const allPending = customer.totalCents === 0 && customerPending > 0;
          return { ...customer, pendingPrices: customerPending, allPending,
            displayTotal: allPending ? '待补价' : '¥' + money(customer.totalCents) };
        });
        const pendingPrices = customers.reduce((sum, customer) => sum + customer.pendingPrices, 0);
        const allPending = preview.totalCents === 0 && pendingPrices > 0;
        this.setData({ orderSheetStep: 'preview', priceDrawerError: '',
          sheetPreview: { ...view, customers, id: preview.previewId, pendingPrices, allPending,
            displayTotal: allPending ? '待补价' : '¥' + money(preview.totalCents) } });
      } catch (error) {
        if (error instanceof WorkspaceError && error.status === 401) throw error;
        if (error instanceof WorkspaceError && draftConflicts.includes(error.code)) {
          await this.reloadAfterConflict(error, draftConflicts);
          if (this.data.confirmed) {
            this.closeOrderSheet();
            return;
          }
          this.setData({ orderSheetStep: 'list', sheetPreview: null, priceDrawerError: errorMessage(error) });
          return;
        }
        this.setData({ orderSheetStep: 'list', sheetPreview: null, priceDrawerError: errorMessage(error) });
      }
    });
  },

  backToSheetList(): void {
    this.setData({ orderSheetStep: 'list', sheetPreview: null, priceDrawerError: '' });
  },

  async adoptAllAndPreviewInSheet(): Promise<void> {
    const done = await this.adopt(this.adoptableLines());
    if (done) await this.previewInSheet();
  },

  confirmSheetPreview(): Promise<void> | undefined {
    const preview = this.data.sheetPreview;
    if (!preview || this.data.busy || this.data.polling) return;
    this.card('confirm');
    return this.run(async () => {
      try {
        await this.request('/trips/confirm', { previewId: preview.id });
        this.closeOrderSheet();
        await this.reload();
        this.notify('已出单，取货单与送货单已生成');
      } catch (error) {
        if (error instanceof WorkspaceError && error.status === 401) throw error;
        if (error instanceof WorkspaceError && draftConflicts.includes(error.code)) {
          await this.reloadAfterConflict(error, draftConflicts);
          if (this.data.confirmed) {
            this.closeOrderSheet();
            return;
          }
          this.setData({ orderSheetStep: 'list', sheetPreview: null, priceDrawerError: errorMessage(error) });
          return;
        }
        this.setData({ priceDrawerError: errorMessage(error) });
      }
    });
  },

  openWorkspaceFromSheet(): void {
    this.closeOrderSheet();
    this.openWorkspace();
  },

  chooseCatalogVariant(event: WechatMiniprogram.TouchEvent): Promise<void> | undefined {
    const lineId = String(event.currentTarget.dataset.line ?? '');
    const variantId = String(event.currentTarget.dataset.variant ?? '');
    if (!variantId) return;
    return this.catalogChoice(lineId, { choice: 'variant', variantId });
  },

  keepExternalCatalog(event: WechatMiniprogram.TouchEvent): Promise<void> | undefined {
    return this.catalogChoice(String(event.currentTarget.dataset.line ?? ''), { choice: 'external' });
  },

  catalogChoice(lineId: string, selection: { choice: 'variant'; variantId: string } | { choice: 'external' }):
  Promise<void> | undefined {
    const draft = this.draft;
    const choice = this.data.catalogChoices.find(item => item.lineId === lineId);
    if (!draft || !choice || this.data.busy || this.data.polling) return;
    this.setData({ notice: '' });
    return this.run(async () => {
      try {
        const result = await this.request<CatalogChoiceResult>('/agent/catalog-choice',
          { draftId: draft.id, revision: draft.revision, draftCustomerId: choice.draftCustomerId, lineId, ...selection });
        await this.reload();
        if (this.data.orderSheetOpen) {
          this.setData({ priceDrawerError: '',
            ...(!this.data.priceDrawerDirty ? { priceDrawerRows: this.buildPriceRows() } : {}) });
        }
        const updates = (result.priceUpdates ?? []).map(update => update.text).filter(Boolean);
        if (updates.length) this.setData({ notice: `已选定规格：${updates.join('；')}` });
        else if (typeof wx.showToast === 'function') wx.showToast({
          title: selection.choice === 'external' ? '已按库外新货保留' : '已选定规格', icon: 'success' });
      } catch (error) {
        await this.reloadAfterConflict(error, catalogConflicts);
        throw error;
      }
    });
  },

  adoptPrice(event: WechatMiniprogram.TouchEvent): Promise<boolean> | undefined {
    const { line, customer, cents, brand, spec } = event.currentTarget.dataset;
    const hint = this.data.priceHints[String(line ?? '')];
    const amount = Number(cents);
    if (!hint || hint.draftCustomerId !== customer) return;
    const option = hint.options.find(item => item.cents === amount);
    if (!option) return;
    const variant = option.brand === undefined && option.spec === undefined ? undefined
      : { brand: String(brand ?? ''), spec: String(spec ?? '') };
    return this.adopt([{ draftCustomerId: hint.draftCustomerId, lineId: hint.lineId, unitPriceCents: amount,
      ...(variant ? { variant } : {}) }]);
  },

  adoptableLines(): PriceAdoptLine[] {
    return Object.values(this.data.priceHints).filter(hint => hint.adoptable && hint.options.length)
      .map(hint => ({ draftCustomerId: hint.draftCustomerId, lineId: hint.lineId,
        unitPriceCents: hint.options[0].cents }));
  },

  adoptAll(): Promise<boolean> | undefined {
    return this.adopt(this.adoptableLines());
  },

  async adoptAllAndPreview() {
    const done = await this.adopt(this.adoptableLines());
    if (done) await this.previewShortcut();
  },

  async adopt(lines: PriceAdoptLine[]): Promise<boolean> {
    const draft = this.draft;
    if (!draft || this.data.busy || this.data.polling || !lines.length) return false;
    let done = false;
    await this.run(async () => {
      try {
        await this.request('/agent/price-adopt', { draftId: draft.id, revision: draft.revision, lines });
        await this.reload();
        if (this.data.orderSheetOpen && this.data.orderSheetTab === 'pending' && !this.data.priceDrawerDirty) {
          this.setData({ priceDrawerRows: this.buildPriceRows() });
        }
        if (typeof wx.showToast === 'function') wx.showToast({ title: '已填入单价', icon: 'success' });
        done = true;
      } catch (error) {
        await this.reloadAfterConflict(error, priceConflicts);
        throw error;
      }
    });
    return done;
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

  nextTrip(): Promise<void> | undefined {
    const draft = this.draft;
    if (!draft || !this.data.confirmed || !agentSession.token || this.data.busy || this.data.polling) return;
    const unfinished = this.data.deliverySummary?.unfinished ?? [];
    if (unfinished.length && typeof wx.showModal === 'function') {
      const token = agentSession.token;
      const draftId = draft.id;
      wx.showModal({
        title: '开始下一趟',
        content: `还有 ${unfinished.length} 家没确认送达：${unfinished.join('、')}。原单仍可在「历史」查看，确定开始下一趟吗？`,
        confirmText: '开始新趟',
        success: ({ confirm }) => {
          if (confirm && token === agentSession.token && this.draft?.id === draftId) void this.startNextTrip(draftId);
        },
        fail: () => this.setData({ error: '确认框打开失败，请重试。' }),
      });
      return;
    }
    return this.startNextTrip(draft.id);
  },

  startNextTrip(draftId: string): Promise<void> | undefined {
    this.card('next');
    return this.run(async () => {
      try {
        await this.request('/trips/next-draft', { draftId });
        await this.reload();
      } catch (error) {
        if (error instanceof WorkspaceError && ['draft_open', 'draft_changed', 'draft_not_found'].includes(error.code)) {
          await this.reload();
        }
        throw error;
      }
    });
  },

  openImageMenu(): void {
    const draft = this.draft;
    if (!draft || this.data.confirmed || this.data.busy || this.data.polling || !this.data.draftsAvailable ||
      this.data.attachments.length >= imageLimit) return;
    wx.showActionSheet({
      itemList: ['从微信聊天选图', '从手机相册选图'],
      success: ({ tapIndex }) => {
        if (tapIndex === 0) void this.pickAndUpload(false);
        else if (tapIndex === 1) void this.pickAndUpload(true);
      },
      fail: () => {},
    });
  },

  chooseImage(event: WechatMiniprogram.TouchEvent) {
    const { album, key } = event.currentTarget.dataset;
    return this.pickAndUpload(album === 'yes', key);
  },

  pickAndUpload(album: boolean, key?: string): Promise<void> | undefined {
    const draft = this.draft;
    if (!draft || this.data.confirmed || this.data.busy || this.data.polling || !this.data.draftsAvailable ||
      this.data.attachments.length >= imageLimit) return;
    return this.run(async () => {
      const linked = this.data.uploadRows.find(row => row.requestId === key);
      const file = await chooseMaterial(album);
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
    const generation = this.generation;
    return this.run(() => this.syncMaterials(draft, generation));
  },

  async syncMaterials(draft: TripDraft, generation: number) {
    let local: MaterialSource[] = [];
    try {
      if (typeof wx.getStorageSync === 'function') local = stagedMaterials().filter(item => item.draftId === draft.id);
    } catch { local = []; }
    let materials: Material[];
    try {
      const result = await workspaceRequest<{ materials: Material[] }>('GET', '/materials', agentSession.token);
      materials = result.materials;
    } catch { return; }
    const currentDraft = this.draft;
    if (generation !== this.generation || !agentSession.token || !currentDraft || currentDraft.id !== draft.id) return;
    const current = materials.filter(item => item.draftId === currentDraft.id);
    const remote = current.filter(item => item.status === 'uploading').map(item =>
      ({ ...item, local: local.some(source => sameMaterial(source, item)) }));
    this.setData({ readyImages: current.filter(item => item.status === 'ready' && !item.organized &&
      !this.data.attachments.some(attached => attached.id === item.id)),
      uploadRows: [...remote, ...local.filter(item => item.revision === currentDraft.revision &&
        !current.some(material => material.requestId === item.requestId)).map(item => ({ ...item, local: true }))] });
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

  toggleInputMode() {
    if (this.data.voicePhase === '录音中') {
      this.discardVoice = true;
      this.voiceCapture?.cancel();
    }
    const inputMode = this.data.inputMode === 'text' ? 'voice' : 'text';
    this.voiceMeta = null;
    this.setData({ inputMode, voiceCorrectionHint: '',
      ...(inputMode === 'text' ? { focusInput: !this.data.busy } : { focusInput: false }) });
  },

  voiceTap() {
    if (this.data.voicePhase === '录音中') this.stopRecording();
    else this.record();
  },

  record() {
    const draft = this.draft;
    if (!draft || this.data.polling) return;
    return this.run(async () => {
      this.setData({ voicePhase: '准备录音', voiceRetry: false });
      try {
        this.voiceCapture = startVoiceRecording(() => this.setData({ voicePhase: '录音中' }));
        const path = await this.voiceCapture.done.catch(error => {
          if (!this.discardVoice) throw error;
          return '';
        });
        if (!path) return;
        this.voiceFile = { draft, path };
        await this.transcribe();
      } finally { this.voiceCapture = null; this.discardVoice = false; this.setData({ voicePhase: '' }); }
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
    this.voiceMeta = null;
    this.setData({ voicePhase: '正在转写', voiceRetry: false, voiceCorrectionHint: '' });
    try {
      const bytes = await readVoiceFile(file.path);
      const result = await transcribeVoice(file.draft, bytes, agentSession.token, true);
      if (result.draftId !== this.draft?.id || result.revision !== this.draft.revision) throw new Error('草稿已变化，请重新录音。');
      const text = [this.data.text.trim(), result.text.trim()].filter(Boolean).join('\n');
      if (!result.text.trim()) throw new Error('语音转写没有返回文字，请重试。');
      if (text.length > textOrderLimit) throw new Error('转写后文字太长，请缩短输入框内容再重试。');
      const corrections = Array.isArray(result.corrections)
        ? result.corrections.filter(item => item && item.from && item.to) : [];
      if (corrections.length) {
        this.voiceMeta = { rawText: result.rawText || result.text, corrections };
        this.setData({ text, inputMode: 'text',
          voiceCorrectionHint: `已自动纠正：${corrections.map(item => `${item.from}→${item.to}`).join('、')}` });
      } else {
        this.voiceMeta = null;
        this.setData({ text, inputMode: 'text', voiceCorrectionHint: '' });
      }
      this.voiceFile = null;
    } catch (error) {
      if (error instanceof VoiceFileError || (error instanceof WorkspaceError && error.status < 500)) this.voiceFile = null;
      this.setData({ voiceRetry: !!this.voiceFile });
      throw error;
    } finally { this.setData({ voicePhase: '' }); }
  },
});
