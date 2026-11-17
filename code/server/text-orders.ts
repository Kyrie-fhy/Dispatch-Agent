import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { emptyItem, isObject, ItemInput } from '../miniprogram/core/orders';
import { textFields, textOrderLimit, validTextField } from '../miniprogram/core/text-order';
import { CustomerDraft, TripDraft } from '../miniprogram/core/trips';
import { missingDraft, readAccount, readAccountResult, readParties, readWorkspace, Workspace, writeAccount } from './account-workspace';
import { HttpError } from './http-error';
import { readPreviewInput, validRevision } from './request-input';
import { TextModel } from './text-model';

type Input = ReturnType<typeof readTextOrder>;
type Fields = Omit<ItemInput, 'id'>;
const productFields = ['product', 'brand', 'specification', 'unit'] as const;
const contextLimit = 12_000;

function normalized(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function readable(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && !value.includes('\0') && Buffer.from(value).toString() === value;
}

export function readTextOrder(value: unknown) {
  const input = readPreviewInput(value);
  if (!validRevision(input.revision, true)) throw new HttpError(409, 'draft_revision_limit', '草稿已达到修订上限');
  const { text } = value as Record<string, unknown>;
  if (!readable(text, textOrderLimit) || !text.trim()) {
    throw new HttpError(400, 'invalid_order_text', `请输入 1 至 ${textOrderLimit} 字的录单文字`);
  }
  return { ...input, text: text.trim() };
}

function invalidModel(): never {
  throw new HttpError(502, 'invalid_text_result', '文字整理结果无法读取。原文仍在，可以重试或手动填写。');
}

function needsReview(message: string): never {
  throw new HttpError(422, 'text_needs_review', message);
}

function targetRows(draft: TripDraft) {
  return draft.customers.flatMap(customer => customer.items.map(item => ({ customer, item })));
}

function fieldsOf(item: ItemInput): Fields {
  const { id: _id, ...fields } = item;
  return fields;
}

function isPlaceholder(item: ItemInput) {
  return (!item.unit || item.unit === '箱') && textFields.every(field => field === 'unit' || !item[field].trim());
}

function safeFields(op: Record<string, unknown>) {
  const fields: Partial<Fields> = {};
  for (const key of textFields) {
    if (!(key in op)) continue;
    const value = op[key];
    if (!readable(value, 200)) invalidModel();
    const field = value.trim();
    if (field && !validTextField(key, field)) invalidModel();
    if (field) fields[key] = field;
  }
  return fields;
}

function mergeText(draft: TripDraft, output: unknown, partyNames: Set<string>, text: string): TripDraft {
  if (!isObject(output) || !Array.isArray(output.operations) || output.operations.length > 24
      || !readable(output.question ?? '', 250)) invalidModel();
  const question = typeof output.question === 'string' ? output.question.trim() : '';
  if (question) needsReview(question);
  if (!output.operations.length) needsReview('没有找到可录入的明细。请补充客户和货品，或直接手动填写。');

  const next = structuredClone(draft);
  const targets = targetRows(next);
  // Resolve short supplements against the original rows, before applying any changes in this response.
  const original = targetRows(draft);
  const compact = (value: string) => normalized(value).toLowerCase().replace(/\s/g, '');
  const source = compact(text);
  const referenceScore = ({ customer, item }: typeof original[number]) =>
    [...new Set([customer.customer, ...productFields.map(field => item[field])].map(compact))]
      .filter(term => term && source.includes(term)).length;
  for (const op of output.operations as unknown[]) {
    if (!isObject(op) || (op.action !== 'add' && op.action !== 'fill')
        || Object.keys(op).some(key => !['action', 'target', 'customer', ...textFields].includes(key))) invalidModel();
    if (!readable(op.customer ?? '', 200)) invalidModel();
    const customer = typeof op.customer === 'string' ? op.customer.trim() : '';
    const fields = safeFields(op);

    if (op.action === 'fill') {
      if (!Number.isSafeInteger(op.target) || Number(op.target) < 1 || Number(op.target) > targets.length) {
        needsReview('无法定位要补充的明细。请写明客户和货品，或直接编辑。');
      }
      const row = targets[Number(op.target) - 1];
      if (isPlaceholder(row.item)) needsReview('请写明客户和货品，先录入一条明细。');
      if (customer && row.customer.customer.trim() && normalized(row.customer.customer) !== normalized(customer)) {
        needsReview('客户名称与草稿冲突，请手动核对。');
      }
      const selected = original[Number(op.target) - 1];
      const alternatives = original.filter(candidate => candidate !== selected && !isPlaceholder(candidate.item));
      const score = referenceScore(selected);
      if (alternatives.some(candidate => referenceScore(candidate) > score ||
          (referenceScore(candidate) === score && ((customer && !candidate.customer.customer.trim()) ||
          textFields.some(field => fields[field] && !candidate.item[field].trim()))))) {
        needsReview('有多条可能需要补充的明细，请写明客户和货品，或直接编辑。');
      }
      if (customer && !row.customer.customer.trim()) {
        if (next.customers.some(entry => entry !== row.customer && normalized(entry.customer) === normalized(customer))) {
          needsReview('草稿已有同名客户，请手动核对明细归属。');
        }
        row.customer.customer = customer;
        row.customer.partyId = partyNames.has(normalized(customer)) ? undefined : null;
      }
      for (const field of textFields) {
        if (!fields[field]) continue;
        if (row.item[field].trim() && normalized(row.item[field]) !== normalized(fields[field])) {
          needsReview('这段文字与草稿已填内容冲突，请在对应明细中手动核对。');
        }
        if (!row.item[field].trim()) row.item[field] = fields[field];
      }
    } else {
      if (op.target !== undefined && op.target !== null) invalidModel();
      if (!fields.product) needsReview('请说明要添加的货品名称，或直接手动填写。');
      const matches = customer ? next.customers.filter(entry => normalized(entry.customer) === normalized(customer)) : [];
      if (matches.length > 1) needsReview('草稿有多个同名客户，请手动选择对应客户后添加明细。');
      let owner: CustomerDraft | undefined = matches[0];
      if (!owner) {
        owner = next.customers.find(entry => !entry.customer.trim() && !entry.partyId && entry.items.every(isPlaceholder));
        if (!owner) {
          owner = { id: randomUUID(), customer: '', items: [] };
          next.customers.push(owner);
        }
        owner.customer = customer;
        owner.partyId = !customer || partyNames.has(normalized(customer)) ? undefined : null;
      }
      if (owner.items.some(item => normalized(item.product) === normalized(fields.product!) &&
          productFields.every(field => !item[field].trim() || !fields[field] || normalized(item[field]) === normalized(fields[field])))) {
        needsReview('草稿里有同款或相似货品，请补充规格和单位，或直接修改现有明细。');
      }
      const blank = owner.items.findIndex(isPlaceholder);
      const item = { ...emptyItem(blank < 0 ? randomUUID() : owner.items[blank].id), unit: '', ...fields };
      if (blank < 0) owner.items.push(item);
      else owner.items[blank] = item;
    }
  }
  if (JSON.stringify(next.customers) === JSON.stringify(draft.customers)) needsReview('这段文字没有新增可填写的内容，请核对草稿。');
  return { ...next, revision: draft.revision + 1 };
}

function checkBasis(current: Workspace, input: Input) {
  if (current.id !== input.draftId) throw missingDraft();
  if (current.currentTripId === current.id) throw new HttpError(409, 'draft_confirmed', '本趟已确认，请开始下一趟');
  if (current.revision !== input.revision) throw new HttpError(409, 'draft_changed', '草稿已更新，请刷新后核对，原文仍在。');
}

async function checkDuplicate(client: PoolClient, account: string, draftId: string, digest: Buffer) {
  const result = await client.query('SELECT 1 FROM dispatch.text_order_inputs WHERE account_id=$1 AND draft_id=$2 AND text_digest=$3',
    [account, draftId, digest]);
  if (result.rowCount) throw new HttpError(409, 'duplicate_order_text', '这段文字已录入本趟草稿。请核对原明细，或发送新增内容。');
}

export class TextOrders {
  private readonly running = new Set<string>();

  constructor(private readonly pool: Pool, private readonly model?: TextModel) {}

  async apply(account: string, input: Input, checkSession: () => Promise<unknown>): Promise<{ draft: TripDraft }> {
    const command = { action: 'text-order', draftId: input.draftId, revision: input.revision, text: input.text };
    const digest = createHash('sha256').update(normalized(input.text)).digest();
    if (this.running.has(account) || this.running.size >= 4) {
      throw new HttpError(429, 'text_order_busy', '正在整理文字，请稍后重试。');
    }
    this.running.add(account);
    try {
      const snapshot = await readAccount(this.pool, account, async client => {
        const current = await readWorkspace(client, account);
        if (current.id !== input.draftId) throw missingDraft();
        const { previous } = await readAccountResult<{ draft: TripDraft }>(client, account, input.requestId, command);
        if (previous && current.currentTripId !== current.id && previous.result.draft.revision === current.revision) {
          return { replay: previous.result } as const;
        }
        const draft = { id: current.id, revision: current.revision, customers: current.customers };
        checkBasis(current, input);
        await checkDuplicate(client, account, input.draftId, digest);
        const partyNames = new Set((await readParties(client, account)).map(party => normalized(party.name)));
        return { draft, partyNames } as const;
      });
      if (snapshot.replay) return snapshot.replay;
      if (!this.model) throw new HttpError(503, 'text_model_unavailable', '文字整理暂未开启。可以保留原文，先手动填写草稿。');
      const current = targetRows(snapshot.draft).map(({ customer, item }, index) =>
        ({ target: index + 1, customer: customer.customer, ...fieldsOf(item), ...(isPlaceholder(item) ? { unit: '' } : {}) }));
      if (JSON.stringify(current).length > contextLimit) {
        throw new HttpError(422, 'text_context_too_large', '当前草稿明细较多，请手动补充，已保存的草稿仍可使用。');
      }
      const output = await this.model({ text: input.text, current });
      const draft = mergeText(snapshot.draft, output, snapshot.partyNames, input.text);
      await checkSession();
      return await writeAccount(this.pool, account, input.requestId, command, async (client, latest) => {
        checkBasis(latest, input);
        await checkDuplicate(client, account, input.draftId, digest);
        await client.query('UPDATE dispatch.workspaces SET draft_revision = $2, draft_customers = $3 WHERE account_id = $1',
          [account, draft.revision, JSON.stringify(draft.customers)]);
        await client.query('INSERT INTO dispatch.text_order_inputs (account_id, draft_id, text_digest) VALUES ($1,$2,$3)',
          [account, draft.id, digest]);
        return { draft };
      });
    } finally {
      this.running.delete(account);
    }
  }
}
