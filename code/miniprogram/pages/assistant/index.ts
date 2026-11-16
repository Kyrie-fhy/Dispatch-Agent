import { applyInput, describeItem, forDraft, images, Intent, linePrice, Official, OfficialTarget,
  officialTargets, questions, recognize, replaceCustomer, resolveQuantity, voice } from '../../core/mock-assistant';
import { readMaterials } from '../../services/mock-materials';
import { confirmOfficial, OfficialCard, prepareOfficial } from './official';
import { emptyItem, yuanToCents } from '../../core/orders';
import { currentTrip, CustomerDraft, emptyCustomer, emptyTrip, latest, TripDraft } from '../../core/trips';
import { newId, trips } from '../../services/orders';
import { selectDeliverySheet, clearDeliverySheet } from '../../services/delivery-link';
import { editLines, errorMessage, formLines, partyOptions, tripView } from '../order-view';

type Addition = Extract<Intent, { kind: 'add' }>;
type Job = {
  id: string; draftId: string; text: string; images: string[]; label: string;
  status: 'queue' | 'working' | 'done' | 'failed' | 'skipped' | 'stale' | 'manual';
  detail: string; retry?: boolean; skipped?: Addition[]; force?: Addition[];
};

function sampleCustomer(customer: string, brand: string, quantity: string, price: string): CustomerDraft {
  const draft = emptyCustomer(newId);
  return { ...draft, customer, partyId: null, items: [{ ...draft.items[0], product: '水饺', brand, specification: '500g', quantity, price }] };
}

Page({
  data: {
    draft: emptyTrip(() => 'loading'), activeId: '', active: null as CustomerDraft | null,
    form: [] as ReturnType<typeof formLines>,
    previewTrip: null as (ReturnType<typeof tripView> & { id: string; revision: number; identities: string[] }) | null,
    confirmed: null as (ReturnType<typeof tripView> & { version: number }) | null,
    parties: [] as ReturnType<typeof partyOptions>, partyLabel: '', chosenNew: false, chosenExisting: false,
    error: '', loaded: false,
    images: images.map(image => ({ ...image, marked: false })), voice, selected: [] as string[], text: '', transcribed: false, help: false, manual: false,
    dirty: false, demoReady: false, jobs: [] as Job[], busy: false, epoch: 0,
    checking: false, questions: [] as ReturnType<typeof questions>,
    selection: null as { intent: Official; targets: OfficialTarget[] } | null,
    official: null as OfficialCard | null, completedTarget: null as OfficialTarget | null, notice: '',
  },

  onLoad() { this.reload(); },
  onShow() {
    if (this.data.confirmed) { this.reload(); return; }
    try {
      const state = trips.load();
      this.setData({ parties: partyOptions(state) });
      if (!this.data.dirty) this.showDraft(state.draft, this.data.activeId);
      this.refreshQuestions();
    } catch (error) { this.fail(error); }
  },

  reload() {
    try {
      const state = trips.load();
      const current = currentTrip(state);
      const version = current?.id === state.draft.id ? latest(current) : null;
      const same = state.draft.id === this.data.draft.id;
      this.setData({ parties: partyOptions(state), demoReady: Boolean(state.assistant?.demoPartyId), dirty: false });
      this.showDraft(state.draft, same ? this.data.activeId : state.draft.customers[0].id);
      if (!same) this.setData({ checking: false, questions: [], selection: null, official: null, completedTarget: null, notice: '', manual: false });
      this.setData({ confirmed: version ? { ...tripView(version), version: version.version } : null, previewTrip: null, loaded: true, error: '' });
    } catch (error) { this.fail(error); }
  },

  fail(error: unknown) { this.setData({ error: errorMessage(error) }); },

  showDraft(draft: TripDraft, activeId: string) {
    const active = draft.customers.find(customer => customer.id === activeId) ?? draft.customers[0];
    this.setData({ draft, activeId: active.id, active, form: formLines(active.items),
      chosenExisting: typeof active.partyId === 'string', chosenNew: active.partyId === null,
      partyLabel: this.data.parties.find(party => party.id === active.partyId)?.label ?? '' });
  },

  persist(draft: TripDraft, activeId?: string) {
    activeId ??= this.data.activeId;
    this.showDraft(draft, activeId);
    this.setData({ previewTrip: null, dirty: true });
    try {
      this.showDraft(trips.saveDraft(draft), activeId);
      this.setData({ error: '', dirty: false });
      this.refreshQuestions();
    } catch (error) { this.fail(error); }
  },

  selectCustomer(event: WechatMiniprogram.TouchEvent) {
    this.showDraft(this.data.draft, event.currentTarget.dataset.id);
  },

  addCustomer() {
    const customer = emptyCustomer(newId);
    const { draft } = this.data;
    this.persist({ ...draft, customers: [...draft.customers, customer] }, customer.id);
  },

  removeCustomer() {
    const { draft, activeId } = this.data;
    if (draft.customers.length === 1) return;
    this.persist({ ...draft, customers: draft.customers.filter(customer => customer.id !== activeId) });
  },

  editActive(active: CustomerDraft) {
    const { draft } = this.data;
    this.persist({ ...draft, customers: draft.customers.map(customer => customer.id === active.id ? active : customer) });
  },

  editCustomer(event: WechatMiniprogram.Input) {
    const { active } = this.data;
    if (active && active.id === event.currentTarget.dataset.id) this.editActive({ ...active, customer: event.detail.value });
  },

  chooseExisting(event: WechatMiniprogram.PickerChange) {
    const party = this.data.parties[Number(event.detail.value)];
    const { active, draft } = this.data;
    if (!party || !active) return;
    if (draft.customers.some(customer => customer.id !== active.id && customer.partyId === party.id)) {
      this.fail(new Error('本趟已选择该客户，请回到该客户单添加货品'));
      return;
    }
    this.editActive({ ...active, customer: party.name, partyId: party.id });
  },

  chooseNew() {
    const { active } = this.data;
    if (active) this.editActive({ ...active, partyId: null });
  },

  editItem(event: WechatMiniprogram.Input) {
    const { active } = this.data;
    const { id, field } = event.currentTarget.dataset;
    if (active) this.editActive({ ...active, items: editLines(active.items, id, field, event.detail.value) });
  },

  addItem() {
    const { active } = this.data;
    if (active) this.editActive({ ...active, items: [...active.items, emptyItem(newId())] });
  },

  removeItem(event: WechatMiniprogram.TouchEvent) {
    const { active } = this.data;
    if (!active || active.items.length === 1) return;
    this.editActive({ ...active, items: active.items.filter(item => item.id !== event.currentTarget.dataset.id) });
  },

  fillSample() {
    try {
      if (forDraft(trips.load()).draft.quantities.length) throw new Error('请先处理助手里的待确认数量');
    } catch (error) { this.fail(error); return; }
    const a = sampleCustomer('客户 A', '安井', '2', '82');
    const b = sampleCustomer('客户 B', '安井', '3', '80');
    b.items.push({ ...b.items[0], id: newId(), unit: '袋', price: '20' });
    const c = sampleCustomer('客户 C', '三全', '1', '75');
    this.persist({ ...this.data.draft, customers: [a, b, c] }, a.id);
  },

  showPreview() {
    try {
      const draft = trips.saveDraft(this.data.draft);
      this.showDraft(draft, this.data.activeId);
      this.setData({ dirty: false });
      this.openPreview(draft);
    } catch (error) { this.fail(error); }
  },

  openPreview(draft: TripDraft) {
      const checked = trips.previewDraft(draft);
      const preview = tripView(checked);
      const identities = checked.choices.map((choice, index) => choice
        ? this.data.parties.find(party => party.id === choice.id)?.label ?? choice.name
        : `${preview.customers[index].customer} · 新建客户`);
      this.setData({ previewTrip: { ...preview, id: draft.id, revision: draft.revision, identities }, error: '' });
  },

  backToEdit() { this.setData({ previewTrip: null, error: '', manual: true }); },

  confirmTrip() {
    if (this.data.busy) return;
    const preview = this.data.previewTrip;
    if (!preview) return;
    try {
      trips.confirm(preview.id, preview.revision);
      this.setData({ checking: false, questions: [] });
      this.reload();
    } catch (error) { this.fail(error); }
  },

  nextTrip() {
    try {
      trips.startNext();
      this.reload();
    } catch (error) { this.fail(error); }
  },

  toggleHelp() { this.setData({ help: !this.data.help }); },

  toggleManual() { this.setData({ manual: !this.data.manual, previewTrip: this.data.manual ? this.data.previewTrip : null }); },

  openManual(event: WechatMiniprogram.TouchEvent) {
    this.showDraft(this.data.draft, event.currentTarget.dataset.customer || this.data.activeId);
    this.setData({ manual: true, previewTrip: null });
    wx.pageScrollTo?.({ selector: '#manual-editor', duration: 150 });
  },

  prepareDemo() {
    try {
      trips.prepareAssistantDemo();
      this.setData({ demoReady: true, parties: partyOptions(trips.load()),
        completedTarget: null, notice: '已准备独立的客户 A 模拟档案。出单追问时选中该客户可查到 ¥78/箱。', error: '' });
      this.refreshQuestions();
    } catch (error) { this.fail(error); }
  },

  pickImage(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id);
    const selected = this.data.selected;
    this.showSelection(selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]);
  },

  showSelection(selected: string[]) {
    this.setData({ selected, images: images.map(image => ({ ...image, marked: selected.includes(image.id) })) });
  },

  pickVoice(event: WechatMiniprogram.TouchEvent) {
    const sample = voice[Number(event.currentTarget.dataset.index)];
    if (!sample) return;
    this.setData({ text: [this.data.text.trim(), sample.text].filter(Boolean).join('\n'), transcribed: true });
  },

  editMessage(event: WechatMiniprogram.Input) { this.setData({ text: event.detail.value }); },

  sendGenerate() {
    this.enqueue('生成送货单', []);
  },

  send() {
    const text = this.data.text.trim();
    const selected = this.data.selected;
    if (!text && !selected.length) return;
    if (this.enqueue(text, selected, this.data.transcribed)) {
      this.setData({ text: '', transcribed: false });
      this.showSelection([]);
    }
  },

  enqueue(text: string, attachments: string[], transcribed = false, retry = false, force?: Addition[]) {
    try {
      const draft = trips.load().draft;
      const label = [...attachments.map(id => images.find(image => image.id === id)?.label ?? ''),
        ...(text ? [`${transcribed ? '模拟转写 · ' : ''}${text}`] : [])].join('\n');
      const job: Job = { id: newId(), draftId: draft.id, text, images: attachments, label,
        status: 'queue', detail: '等待处理', retry, ...(force ? { force } : {}) };
      this.setData({ jobs: [job, ...this.data.jobs], error: '' });
      void this.drain();
      return true;
    } catch (error) { this.fail(error); return false; }
  },

  updateJob(id: string, update: Partial<Job>) {
    this.setData({ jobs: this.data.jobs.map(job => job.id === id ? { ...job, ...update } : job) });
  },

  retryMaterial(event: WechatMiniprogram.TouchEvent) {
    const job = this.data.jobs.find(entry => entry.id === event.currentTarget.dataset.id);
    if (!job || (job.status !== 'failed' && job.status !== 'stale')) return;
    if (job.draftId !== this.data.draft.id || this.data.confirmed && (job.images.length || job.force)) return;
    if (this.enqueue(job.text, job.images, false, true, job.force)) {
      this.updateJob(job.id, { status: 'done', detail: '已提交重试，结果见新消息' });
    }
  },

  restoreDuplicate(event: WechatMiniprogram.TouchEvent) {
    const job = this.data.jobs.find(entry => entry.id === event.currentTarget.dataset.id);
    if (!job?.skipped?.length || job.draftId !== this.data.draft.id || this.data.confirmed) return;
    const label = job.skipped.map(entry => `${entry.name} · ${describeItem(entry.line)}`).join('；');
    if (this.enqueue(`明确补录：${label}`, [], false, false, job.skipped)) {
      this.updateJob(job.id, { status: 'done', detail: '已提交补录，结果见新消息', skipped: [] });
    }
  },

  async drain() {
    if (this.data.busy) return;
    const epoch = this.data.epoch;
    this.setData({ busy: true });
    try {
      for (let job = [...this.data.jobs].reverse().find(entry => entry.status === 'queue'); job && epoch === this.data.epoch;
        job = [...this.data.jobs].reverse().find(entry => entry.status === 'queue')) {
        const key = job.id;
        try {
          const before = trips.load();
          if (before.draft.id !== job.draftId) {
            this.updateJob(key, { status: 'stale', detail: '原草稿已切换，材料未写入。可查看原文后手动补录。' });
            continue;
          }
          this.updateJob(key, { status: 'working', detail: job.images.length ? '正在识别模拟图片' : '正在整理输入' });
          const material = await readMaterials(job.images, job.text, Boolean(job.retry));
          if (epoch !== this.data.epoch) return;
          const state = trips.load();
          if (state.draft.id !== job.draftId || state.draft.revision !== before.draft.revision) {
            this.updateJob(key, { status: 'stale', detail: '处理期间草稿已更新，结果未写入。可重新核对后重试。' });
            continue;
          }
          const intents = job.force ?? material.map(recognize);
          if (intents.some(intent => !intent)) {
            this.updateJob(key, { status: 'manual', detail: '这条内容不在模拟范围内，未写入。可编辑原文后重发，或手动补充。' });
            continue;
          }
          const parsed = intents as Intent[];
          const first = parsed[0];
          const isInput = (intent: Intent): intent is Extract<Intent, { kind: 'add' | 'fill' | 'quantity' }> =>
            intent.kind === 'add' || intent.kind === 'fill' || intent.kind === 'quantity';
          const closed = state.trips.some(trip => trip.id === state.draft.id);
          if (parsed.every(isInput) && parsed.length) {
            if (closed) throw new Error('这趟已出单。录入新单前请开始下一趟；修改原单请使用「修改」');
            if (this.data.dirty) throw new Error('手动编辑尚未保存，请先在表单重试保存');
            const result = applyInput(state, parsed, newId, Boolean(job.force));
            if (result.changes.length) {
              const active = result.draft.customers.find(customer => customer.id === this.data.activeId);
              const saved = trips.saveDraft(result.draft, result.notes);
              this.showDraft(saved, active?.id ?? saved.customers[0].id);
              this.setData({ previewTrip: null, ...(this.data.checking
                ? { questions: questions({ ...state, draft: saved, assistant: result.notes }) } : {}) });
            }
            const skipped = result.skipped.map(entry => `${entry.name} · ${describeItem(entry.line)}`).join('；');
            const detail = [result.changes.length ? `已更新草稿：${result.changes.join('；')}` : '',
              skipped ? `跳过疑似重复：${skipped}` : ''].filter(Boolean).join('\n');
            this.updateJob(key, { status: skipped ? 'skipped' : 'done', detail, skipped: result.skipped });
          } else if (parsed.length === 1 && first.kind === 'generate') {
            if (closed) throw new Error('本趟已确认，请在正式单或取货页查看');
            if (this.data.dirty) throw new Error('手动编辑尚未保存，请先在表单重试保存');
            this.updateJob(key, { detail: '正在检查整趟待补充项' });
            const pending = questions(state);
            this.setData({ checking: true, questions: pending, previewTrip: null });
            if (!pending.length) this.openPreview(state.draft);
            this.updateJob(key, { status: 'done', detail: pending.length ? '请核对下方集中待补充项。补齐后再生成。' : '已生成整趟预览，等待确认' });
          } else if (parsed.length === 1 && first.kind === 'newPrice') {
            if (closed || !this.data.checking) throw new Error('请先生成送货单，确认正在补哪一条价格');
            const pending = questions(state).flatMap(customer => customer.lines.filter(line => line.priceMissing)
              .map(line => ({ customer, line })));
            if (pending.length !== 1 || pending[0].line.missing && pending[0].line.missing !== '单价'
              || pending[0].customer.identity || state.draft.customers.some(customer =>
                customer.items.some(item => {
                  const cents = yuanToCents(item.price);
                  return item.id !== pending[0].line.id && (!Number.isSafeInteger(cents) || cents <= 0);
                }))) {
              throw new Error('请明确客户和货品，例如「补充 客户 A 水饺 单价 82」');
            }
            this.saveLinePrice(state, pending[0].customer.id, pending[0].line.id, first.price);
            this.updateJob(key, { status: 'done', detail: `已更新本次单价 ¥${first.price}，请重新生成` });
          } else if (parsed.length === 1 && (first.kind === 'amend' || first.kind === 'deliver' || first.kind === 'receipt')) {
            if (this.data.official || this.data.selection) throw new Error('请先确认或取消上一条正式单操作，再重试');
            const targets = officialTargets(state, first);
            if (!targets.length) throw new Error('未找到匹配的正式单。请指定原单或到送货页选择对应客户单');
            if (targets.length === 1) this.setData({ official: prepareOfficial(first, targets[0]) });
            else this.setData({ selection: { intent: first, targets } });
            this.updateJob(key, { status: 'done', detail: targets.length === 1 ? '请核对下方操作预览' : '有多个候选，请在下方指定原单与明细' });
          } else {
            this.updateJob(key, { status: 'manual', detail: '录入和补充可合批；生成、改正式单、送达和收款请分别发送。未写入。' });
          }
        } catch (error) {
          if (epoch !== this.data.epoch) return;
          this.updateJob(key, { status: 'failed', detail: errorMessage(error) });
        }
      }
    } finally { if (epoch === this.data.epoch) this.setData({ busy: false }); }
  },

  reuseText(event: WechatMiniprogram.TouchEvent) {
    const job = this.data.jobs.find(entry => entry.id === event.currentTarget.dataset.id);
    if (job?.text) this.setData({ text: [this.data.text.trim(), job.text].filter(Boolean).join('\n'), transcribed: false });
  },

  refreshQuestions() {
    if (this.data.checking) this.setData({ questions: questions(trips.load()) });
  },

  saveFromAssistant(draft: TripDraft, activeId: string, notes?: ReturnType<typeof forDraft>) {
    if (this.data.dirty) throw new Error('手动编辑尚未保存，请先在表单重试保存');
    const saved = trips.saveDraft(draft, notes);
    this.showDraft(saved, activeId);
    this.setData({ previewTrip: null, error: '' });
    this.refreshQuestions();
  },

  chooseQuestionParty(event: WechatMiniprogram.PickerChange) {
    const party = this.data.parties[Number(event.detail.value)];
    if (party) this.resolveIdentity(String(event.currentTarget.dataset.id), party.id);
  },

  newQuestionParty(event: WechatMiniprogram.TouchEvent) {
    this.resolveIdentity(String(event.currentTarget.dataset.id), null);
  },

  resolveIdentity(id: string, partyId: string | null) {
    try {
      const state = trips.load();
      const customer = state.draft.customers.find(entry => entry.id === id);
      if (!customer?.customer.trim()) throw new Error('请先手动填写客户名称');
      const party = state.ledger.parties.find(entry => entry.id === partyId);
      if (partyId && !party) throw new Error('未找到所选客户，请重新选择');
      if (party && state.draft.customers.some(entry => entry.id !== id && entry.partyId === party.id)) {
        throw new Error('这趟已有该客户单。请在手动编辑中核对并合并明细');
      }
      const notes = forDraft(state);
      const name = customer.customer.trim();
      if (party && name !== party.name && !state.ledger.parties.some(entry => entry.name === name && entry.id !== party.id)) {
        notes.aliases = [...notes.aliases.filter(alias => alias.name !== name), { name, partyId: party.id }];
      }
      this.saveFromAssistant(replaceCustomer(state.draft, { ...customer, customer: party?.name ?? name, partyId }), id, notes);
    } catch (error) { this.fail(error); }
  },

  useHistory(event: WechatMiniprogram.TouchEvent) {
    try {
      const state = trips.load();
      const { customer: cid, item: lid, source, price } = event.currentTarget.dataset;
      const customer = state.draft.customers.find(entry => entry.id === cid);
      const line = customer?.items.find(item => item.id === lid);
      const current = customer && line && linePrice(state, customer, line);
      const existing = yuanToCents(line?.price ?? '');
      if (!current || current.source !== source || current.price !== String(price) || (Number.isSafeInteger(existing) && existing > 0)) {
        throw new Error('历史价或草稿已变化，请重新生成');
      }
      this.saveLinePrice(state, cid, lid, current.price);
    } catch (error) { this.fail(error); }
  },

  saveLinePrice(state: ReturnType<typeof trips.load>, cid: string, lid: string, price: string) {
    const customer = state.draft.customers.find(entry => entry.id === cid);
    if (!customer?.items.some(item => item.id === lid)) throw new Error('草稿明细已变化，请重新生成');
    if (!Number.isSafeInteger(yuanToCents(price)) || yuanToCents(price) <= 0) throw new Error('请输入有效的正数价格');
    const items = customer.items.map(item => item.id === lid ? { ...item, price } : item);
    this.saveFromAssistant(replaceCustomer(state.draft, { ...customer, items }), cid);
  },

  chooseQuantity(event: WechatMiniprogram.TouchEvent) {
    try {
      const state = trips.load();
      const notes = forDraft(state);
      const { id, choice } = event.currentTarget.dataset;
      const question = notes.draft.quantities.find(entry => entry.itemId === id);
      const customer = state.draft.customers.find(entry => entry.items.some(item => item.id === id));
      if (!question || !customer) throw new Error('数量问题已变化，请重新生成');
      const items = customer.items.map(item => item.id === id ? resolveQuantity(item, question, choice) : item);
      notes.draft.quantities = notes.draft.quantities.filter(entry => entry !== question);
      this.saveFromAssistant(replaceCustomer(state.draft, { ...customer, items }), customer.id, notes);
    } catch (error) { this.fail(error); }
  },

  chooseOfficial(event: WechatMiniprogram.TouchEvent) {
    const selection = this.data.selection;
    const target = selection?.targets.find(entry => entry.id === event.currentTarget.dataset.id);
    if (!selection || !target) return;
    try {
      this.setData({ official: prepareOfficial(selection.intent, target), selection: null, error: '' });
    } catch (error) { this.fail(error); }
  },

  cancelOfficial() { this.setData({ official: null, selection: null, error: '' }); },

  commitOfficial() {
    const card = this.data.official;
    if (!card) return;
    try {
      const notice = confirmOfficial(card);
      if (this.data.confirmed) this.reload();
      this.setData({ official: null, selection: null, notice, completedTarget: card.target });
    } catch (error) { this.fail(error); }
  },

  openDelivery(event: WechatMiniprogram.TouchEvent) {
    const { trip, sheet } = event.currentTarget.dataset;
    selectDeliverySheet({ tripId: String(trip), sheetId: String(sheet) });
    wx.switchTab({ url: '/pages/delivery/index', fail: () => {
      clearDeliverySheet();
      this.fail(new Error('未能打开送货页，请重试'));
    } });
  },

  resetDemo() {
    wx.showModal({ title: '重置本地演示数据', content: '将清除本机草稿、正式单据、配送状态、客户和对账收款记录，是否继续？', success: result => {
      if (!result.confirm) return;
      try {
        trips.reset();
        this.setData({ epoch: this.data.epoch + 1, busy: false, jobs: [], text: '', transcribed: false });
        this.showSelection([]);
        this.reload();
      } catch (error) { this.fail(error); }
    } });
  },
});
