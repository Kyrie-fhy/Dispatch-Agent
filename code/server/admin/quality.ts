import type { Pool, PoolClient } from 'pg';
import { normalizeMemoryText } from '../../miniprogram/core/memory';
import { isObject } from '../../miniprogram/core/orders';
import { readAccount, readWorkspace } from '../account-workspace';
import { setAccount, transaction } from '../database';
import { HttpError } from '../http-error';
import { readDirectory } from '../memory';
import { TripStore } from '../trips';
import { type Input, inputText, invalidInput, requireId } from './http';
import { readEvalCaseSnapshot, requireAccount, scopeDocument, turnTimeline } from './store';

export const mistakeCategories = ['货品认错', '漏行多行', '价格没配上', '客户认错', '语音听错', '其他'] as const;

const reviewWindow = `
WITH turns AS (
  SELECT * FROM dispatch.agent_turns
  WHERE account_id = $1 AND ($2::int IS NULL OR created_at >= now() - $2::int * interval '1 day')
), events AS (
  SELECT e.turn_id, e.seq, e.kind, e.payload FROM dispatch.agent_events e JOIN turns t ON t.id = e.turn_id
  WHERE e.account_id = $1
), priced_lines AS (
  SELECT DISTINCT ON (e.turn_id, line->>'draftCustomerId', line->>'lineId') e.turn_id, line
  FROM events e
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload#>'{result,catalog}') = 'array'
    THEN e.payload#>'{result,catalog}' ELSE '[]'::jsonb END) line
  WHERE e.kind = 'tool' AND line ? 'price' AND line ? 'lineId'
  ORDER BY e.turn_id, line->>'draftCustomerId', line->>'lineId', e.seq DESC
), flags AS (
  SELECT t.*,
    EXISTS (SELECT 1 FROM events e WHERE e.turn_id = t.id AND e.kind = 'questions') AS question,
    (EXISTS (SELECT 1 FROM priced_lines p WHERE p.turn_id = t.id AND p.line->'price' = 'null'::jsonb)
      OR EXISTS (SELECT 1 FROM events e WHERE e.turn_id = t.id AND (
        (e.kind = 'tool' AND coalesce(e.payload#>>'{result,pendingPrices}', '') ~ '^[1-9][0-9]*$')
        OR (e.kind = 'step' AND coalesce(e.payload->>'result', '') ~ '(^|[^0-9])[1-9][0-9]* 处待补价')
        OR (e.kind = 'delivery_proposal' AND jsonb_typeof(e.payload->'pendingPriceNames') = 'array'
          AND e.payload->'pendingPriceNames' <> '[]'::jsonb)
        OR (e.kind IN ('change', 'questions') AND e.payload::text ~ '待补价|待填价|未配价|缺价|缺少单价')
      ))) AS unpriced
  FROM turns t
)
`;

const attention = "(status IN ('failed', 'interrupted') OR undone OR unpriced)";

export function qualityTurns(pool: Pool, accountId: string, params: URLSearchParams) {
  const filter = params.get('filter') ?? 'attention';
  const filters = new Map([
    ['attention', attention], ['failed', "status IN ('failed', 'interrupted')"], ['unpriced', 'unpriced'],
    ['question', 'question'], ['undone', 'undone'], ['all', 'true'],
  ]);
  const predicate = filters.get(filter);
  if (!predicate) invalidInput('质检筛选项无效');
  const days = params.get('days') ?? '7';
  if (days !== 'all' && (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 365)) invalidInput('天数须在 1 到 365 天之间，或为 all');
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    const { rows } = await client.query<{
      id: string; scopeId: string; status: string; startRevision: number; endRevision: number; undone: boolean;
      createdAt: Date; unpriced: boolean; question: boolean; attention: boolean; mistakeStatus: 'open' | 'resolved' | null;
    }>(`${reviewWindow}
      SELECT id, draft_id AS "scopeId", status, start_revision AS "startRevision", end_revision AS "endRevision",
        undone, created_at AS "createdAt", unpriced, question, ${attention} AS attention,
        (SELECT m.status FROM dispatch.mistake_cases m WHERE m.account_id = $1 AND m.turn_id = flags.id) AS "mistakeStatus"
      FROM flags WHERE ${predicate} ORDER BY created_at DESC, id DESC LIMIT 100
    `, [accountId, days === 'all' ? null : Number(days)]);
    return { turns: await turnTimeline(client, accountId, rows) };
  });
}

export type CostRates = { inputYuanPerMillion: number; outputYuanPerMillion: number; description: string };

export function configuredCostRates(env: NodeJS.ProcessEnv): CostRates {
  const readRate = (value: string | undefined, fallback: number) => {
    const result = Number(value);
    return value?.trim() && Number.isFinite(result) && result >= 0 ? result : fallback;
  };
  return {
    inputYuanPerMillion: readRate(env.DISPATCH_AI_INPUT_YUAN_PER_MILLION, 2),
    outputYuanPerMillion: readRate(env.DISPATCH_AI_OUTPUT_YUAN_PER_MILLION, 8),
    description: '按已记录模型事件的输入和输出 Token 估算。默认采用 DeepSeek Flash 高峰非缓存输入与输出价；可用 DISPATCH_AI_INPUT_YUAN_PER_MILLION 和 DISPATCH_AI_OUTPUT_YUAN_PER_MILLION 覆盖。估算不含缓存折扣和未记录用量。',
  };
}

export function dashboard(pool: Pool, accountId: string, rates: CostRates) {
  return readAccount(pool, accountId, async client => {
    const { rows: [account] } = await client.query<{ lastActiveAt: Date | null }>(
      'SELECT last_active_at AS "lastActiveAt" FROM dispatch.accounts WHERE id = $1', [accountId]);
    if (!account) throw new HttpError(404, 'account_not_found', '未找到配送员账号');
    const workspace = await readWorkspace(client, accountId);
    const doc = await scopeDocument(client, new TripStore(pool), accountId, workspace.id) as {
      type: string; customers: { customer: string; deliveryCompleted: boolean; lines: { blank?: boolean }[] }[];
      pendingPrices: number; dueCents: number;
    };
    if (!Number.isSafeInteger(doc.dueCents)) throw new HttpError(409, 'amount_out_of_range', '本趟金额超出可计算范围');
    const stores = doc.type === 'trip' ? doc.customers : doc.customers.filter(customer =>
      customer.customer.trim() || customer.lines.some(line => !line.blank));
    const deliveredCount = stores.filter(store => store.deliveryCompleted).length;
    const stage = doc.type === 'draft' ? 'draft' : deliveredCount === stores.length ? 'all_delivered' : 'delivering';
    const { rows: [totals] } = await client.query<{
      attentionTurnCount7d: number; missingUnitCount: number; openMistakeCount: number; turnCount: number;
      avgElapsedMs: number | null; inputTokens: number; outputTokens: number; matched: number; attempts: number;
    }>(`${reviewWindow}
      SELECT (SELECT count(*)::int FROM flags WHERE ${attention}) AS "attentionTurnCount7d",
        (SELECT count(*)::int FROM dispatch.catalog_variants v JOIN dispatch.catalog_products p
          ON p.account_id = v.account_id AND p.id = v.product_id
          WHERE v.account_id = $1 AND v.unit IS NULL AND NOT v.archived AND NOT p.archived) AS "missingUnitCount",
        (SELECT count(*)::int FROM dispatch.mistake_cases WHERE account_id = $1 AND status = 'open') AS "openMistakeCount",
        (SELECT count(*)::int FROM turns) AS "turnCount",
        (SELECT avg((payload->>'elapsedMs')::float8) FROM events
          WHERE kind = 'end' AND jsonb_typeof(payload->'elapsedMs') = 'number') AS "avgElapsedMs",
        (SELECT coalesce(sum((payload->>'inputTokens')::float8), 0) FROM events
          WHERE kind = 'model' AND jsonb_typeof(payload->'inputTokens') = 'number') AS "inputTokens",
        (SELECT coalesce(sum((payload->>'outputTokens')::float8), 0) FROM events
          WHERE kind = 'model' AND jsonb_typeof(payload->'outputTokens') = 'number') AS "outputTokens",
        (SELECT count(*)::int FROM priced_lines WHERE line->>'priceSource' IN ('catalog', 'customer_history')) AS matched,
        (SELECT count(*)::int FROM priced_lines
          WHERE line->>'priceSource' IS NULL OR line->>'priceSource' IN ('catalog', 'customer_history')) AS attempts
    `, [accountId, 7]);
    const { attentionTurnCount7d, missingUnitCount, openMistakeCount, turnCount, avgElapsedMs,
      inputTokens, outputTokens, matched, attempts } = totals;
    return {
      pulse: { stage, storeCount: stores.length, deliveredCount, pendingPriceCount: doc.pendingPrices,
        knownAmountCents: doc.dueCents, lastActiveAt: account.lastActiveAt },
      todos: { missingUnitCount, attentionTurnCount7d, openMistakeCount },
      ai7d: { turnCount, avgElapsedMs, inputTokens, outputTokens,
        autoPriceHitRate: { numerator: matched, denominator: attempts, rate: attempts ? matched / attempts : null,
          description: '按每回合每明细最后一次自动配价记录，分子为库内价或熟客价，分母包含这些命中与自动配价后仍留空的明细。' },
        estimatedCostYuan: (inputTokens * rates.inputYuanPerMillion + outputTokens * rates.outputYuanPerMillion) / 1_000_000,
        costRates: rates },
    };
  });
}

type Snapshot = Awaited<ReturnType<typeof readEvalCaseSnapshot>>;

function embeddedJson(value: string): unknown {
  if (!/^[\[{]/.test(value.trim())) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
}

function customerFields(value: unknown, names: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) customerFields(item, names);
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /^(customer|customerName|canonicalName|spokenCustomer|partyName)$/.test(key) && item.trim()) {
        names.add(item.trim());
      } else if (typeof item === 'object') customerFields(item, names);
      else if (typeof item === 'string' && key === 'arguments') customerFields(embeddedJson(item), names);
    }
  }
}

function namePattern(term: string) {
  const rendered = Array.from(term, char => {
    if (char === ' ') return '\\s+';
    const literal = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /^[!-~]$/.test(char) ? '[' + literal + String.fromCharCode(char.charCodeAt(0) + 0xfee0) + ']' : literal;
  }).join('');
  const alphanumerics = '[a-z0-9ａ-ｚ０-９]';
  const before = /^[a-z0-9]/.test(term) ? '(?<!' + alphanumerics + ')' : '';
  const after = /[a-z0-9]$/.test(term) ? '(?!' + alphanumerics + ')' : '';
  return before + rendered + after;
}

async function caseRedactor(client: PoolClient, accountId: string, snapshot: Snapshot) {
  const { customers, aliases } = await readDirectory(client, accountId);
  const names = new Set(customers.map(customer => customer.name.trim()).filter(Boolean));
  customerFields(snapshot, names);
  const canonical = new Map([...names].map((name, index) => [name, `门店甲${index + 1}`]));
  const replacements = new Map(canonical);
  const aliasesByParty = new Map(customers.map(customer => [customer.id, canonical.get(customer.name.trim())]));
  const nameAliases = [...aliases.map(alias => ({ name: alias.alias, id: aliasesByParty.get(alias.customerId) })),
    ...snapshot.observed.customerLinks.map(link => ({
      name: typeof link.spoken === 'string' ? link.spoken : '',
      id: typeof link.canonicalName === 'string' ? canonical.get(link.canonicalName.trim()) : undefined,
    }))];
  const exportedAliases = snapshot.environment.aliases;
  const exportedParties = snapshot.environment.parties;
  if (Array.isArray(exportedAliases) && Array.isArray(exportedParties)) {
    const exportedNames = new Map(exportedParties.map(party => [party.key, canonical.get(party.name)]));
    for (const alias of exportedAliases) nameAliases.push({ name: alias.alias, id: exportedNames.get(alias.partyKey) });
  }
  for (const { name, id } of nameAliases) {
    if (name.trim() && !replacements.has(name.trim())) {
      replacements.set(name.trim(), `${id ?? '门店'}简称${replacements.size + 1}`);
    }
  }
  const normalizedNames = new Map<string, string>();
  for (const [name, replacement] of replacements) {
    const normalized = normalizeMemoryText(name);
    if (normalized && !normalizedNames.has(normalized)) normalizedNames.set(normalized, replacement);
  }
  const terms = [...normalizedNames.keys()].sort((a, b) => b.length - a.length);
  const pattern = terms.length ? new RegExp(terms.map(namePattern).join('|'), 'giu') : null;
  const phones = new Map<string, string>();
  const redact = (text: string) => {
    const withoutNames = pattern ? text.replace(pattern, value => normalizedNames.get(normalizeMemoryText(value)) ?? value) : text;
    return withoutNames.replace(/(?<![0-9０-９])(?:[+＋]?[8８][6６][\s-]?)?[1１][3-9３-９][0-9０-９](?:[\s-]?[0-9０-９]){8}(?![0-9０-９])/gu, value => {
      const digits = normalizeMemoryText(value).replace(/\D/g, '').slice(-11);
      if (!phones.has(digits)) phones.set(digits, `联系电话${phones.size + 1}`);
      return phones.get(digits)!;
    }).replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[邮箱已隐藏]');
  };
  const schemaValues = /^(id|key|partyKey|linkedPartyKey|partyId|lineId|sheetId|variantId|productId|status|mode|source|medium|role|promptVersion|priceSource|catalogStatus|issuedAt|exportedAt|catalogVariantKey|catalogProductKey)$/;
  const safeDecisionField = (key: string | undefined, value: string) =>
    (key === 'ruleId' && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(value))
    || (key === 'decision' && /^(modify|confirm|block)$/.test(value))
    || (key === 'layer' && /^(edit|customer_link|catalog|delivery|voice)$/.test(value));
  function sanitize(value: unknown, key?: string): unknown {
    if (Array.isArray(value)) return value.map(item => sanitize(item, key));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
    if (typeof value === 'number' && /^(phone|telephone|mobile)$/i.test(key ?? '')) return redact(String(value));
    if (typeof value !== 'string' || schemaValues.test(key ?? '') || safeDecisionField(key, value)) return value;
    const embedded = key === 'arguments' ? embeddedJson(value) : undefined;
    return embedded === undefined ? redact(value) : JSON.stringify(sanitize(embedded));
  }
  return (value: unknown) => sanitize(value);
}

const mistakeColumns = `turn_id AS "turnId", category, expected_outcome AS "expectedOutcome", note, status,
  created_at AS "createdAt", updated_at AS "updatedAt", case_json AS "caseJson",
  left(case_json#>>'{task,text}', 160) AS "userTextPreview",
  coalesce(case_json#>'{task,hasImages}' = 'true'::jsonb, false) AS "hasImages"`;

type Mistake = { turnId: string; category: string; expectedOutcome: string; note: string; status: 'open' | 'resolved';
  createdAt: Date; updatedAt: Date; caseJson: Snapshot; userTextPreview: string; hasImages: boolean };

function categoryOf(value: unknown) {
  if (typeof value !== 'string' || !mistakeCategories.some(category => category === value)) invalidInput('请选择有效的错题分类');
  return value;
}

async function findMistake(client: PoolClient, accountId: string, turnId: string) {
  return (await client.query<Mistake>(`
    SELECT ${mistakeColumns} FROM dispatch.mistake_cases WHERE account_id = $1 AND turn_id = $2
  `, [accountId, turnId])).rows[0];
}

async function mistakeWrite<T>(pool: Pool, accountId: string, turnId: string, work: (client: PoolClient) => Promise<T>) {
  return transaction(pool, async client => {
    await setAccount(client, accountId);
    await requireAccount(client, accountId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`dispatch.mistake:${accountId}:${turnId}`]);
    return work(client);
  });
}

export function listMistakes(pool: Pool, accountId: string, params: URLSearchParams) {
  const status = params.get('status') ?? 'open';
  if (status !== 'all' && status !== 'open' && status !== 'resolved') invalidInput('错题状态筛选项无效');
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    const { rows } = await client.query<Mistake>(`
      SELECT ${mistakeColumns} FROM dispatch.mistake_cases
      WHERE account_id = $1 AND ($2 = 'all' OR status = $2) ORDER BY created_at DESC, turn_id DESC
    `, [accountId, status]);
    return { mistakes: rows };
  });
}

export function createMistake(pool: Pool, accountId: string, body: Input) {
  const turnId = requireId(body.turnId, '回合编号');
  return mistakeWrite(pool, accountId, turnId, async client => {
    const previous = await findMistake(client, accountId, turnId);
    if (previous) return previous;
    const category = categoryOf(body.category);
    const expectedOutcome = inputText(body.expectedOutcome, '预期结果', 4000, true);
    const note = inputText(body.note ?? '', '备注', 4000);
    if (body.includeCatalog !== undefined && typeof body.includeCatalog !== 'boolean') invalidInput('includeCatalog 须为布尔值');
    // The draft, formal snapshots, customer aliases and catalog use this same lock during updates.
    await readWorkspace(client, accountId, true);
    const { rows: [turn] } = await client.query<{ status: string }>(
      'SELECT status FROM dispatch.agent_turns WHERE account_id = $1 AND id = $2', [accountId, turnId]);
    if (!turn) throw new HttpError(404, 'turn_not_found', '未找到这条消息');
    if (turn.status === 'running') throw new HttpError(409, 'turn_running', '这一轮仍在处理中，请结束后再记录错题');
    const snapshot = await readEvalCaseSnapshot(client, accountId, turnId, body.includeCatalog === true);
    const sanitize = await caseRedactor(client, accountId, snapshot);
    const { rows: [record] } = await client.query<Mistake>(`
      INSERT INTO dispatch.mistake_cases (account_id, turn_id, category, expected_outcome, note, case_json)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${mistakeColumns}
    `, [accountId, turnId, category, expectedOutcome, note, JSON.stringify(sanitize(snapshot))]);
    return record;
  });
}

export function patchMistake(pool: Pool, accountId: string, turnId: string, body: Input) {
  const fields = Object.keys(body);
  if (!fields.length || fields.some(key => !['category', 'expectedOutcome', 'note', 'status'].includes(key))) {
    invalidInput('仅可更新错题分类、预期结果、备注和处理状态');
  }
  const category = body.category === undefined ? null : categoryOf(body.category);
  const expectedOutcome = body.expectedOutcome === undefined ? null : inputText(body.expectedOutcome, '预期结果', 4000, true);
  const note = body.note === undefined ? null : inputText(body.note, '备注', 4000);
  const status = body.status === undefined ? null : body.status;
  if (body.status !== undefined && status !== 'open' && status !== 'resolved') invalidInput('错题状态须为 open 或 resolved');
  return mistakeWrite(pool, accountId, turnId, async client => {
    const { rows: [record] } = await client.query<Mistake>(`
      UPDATE dispatch.mistake_cases SET category = coalesce($3, category), expected_outcome = coalesce($4, expected_outcome),
        note = coalesce($5, note), status = coalesce($6, status), updated_at = clock_timestamp()
      WHERE account_id = $1 AND turn_id = $2 RETURNING ${mistakeColumns}
    `, [accountId, turnId, category, expectedOutcome, note, status]);
    if (!record) throw new HttpError(404, 'mistake_not_found', '未找到这条错题');
    return record;
  });
}

export function exportMistake(pool: Pool, accountId: string, turnId: string) {
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    const mistake = await findMistake(client, accountId, turnId);
    if (!mistake) throw new HttpError(404, 'mistake_not_found', '未找到这条错题');
    // Export uses the frozen fixture. Free-form annotations stay in the admin record.
    const { caseJson, category, status, createdAt, updatedAt } = mistake;
    return { ...caseJson, meta: { mistake: { category, status, createdAt, updatedAt } } };
  });
}
