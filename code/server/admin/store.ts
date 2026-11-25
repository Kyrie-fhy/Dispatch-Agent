import { Pool, PoolClient } from 'pg';
import { hasQuotedLinePrice } from '../../miniprogram/core/catalog';
import { DeliveryEdits, deliveryLines, deliverySummary } from '../../miniprogram/core/delivery-execution';
import { catalogStatuses, isObject, itemPriceSources, money, nullablePrice, validTextPrice, yuanToCents, type ItemInput } from '../../miniprogram/core/orders';
import { hasSpokenNumber, spokenNumbers } from '../../miniprogram/core/spoken-numbers';
import { latest, TripVersion } from '../../miniprogram/core/trips';
import { readAccount, readParties, readWorkspace, workspaceDraft } from '../account-workspace';
import { loadCatalog, summarizeCatalog } from '../catalog';
import { transaction } from '../database';
import { HttpError } from '../http-error';
import { imageMime } from '../materials';
import { TripStore } from '../trips';
import { imagePrompt, imagePromptVersion, textPrompt, textPromptVersion } from '../text-model';
import { agentPrompt, agentPromptVersion, agentTools, otherPrompt } from '../agent/model';
import { combinedIntentPrompt, intentPrompt, intentPromptVersion } from '../agent/intent';
import { deliveryCandidatePrompt, deliveryIntentPrompt, deliveryPromptVersion, deliveryTools } from '../agent/delivery-model';


type AccountRow = { id: string; provider: string; subject: string; remarkName: string;
  activated: boolean; disabled: boolean; disabledAt: Date | null; lastActiveAt: Date | null; catalogRevision: number };
type StoredTurnRow = { id: string; status: string; startRevision: number; endRevision: number; undone: boolean; createdAt: Date };
type MessageRow = { turnId: string; role: 'user' | 'assistant'; content: string; materialIds: string[] };
type MaterialRow = { id: string; name: string; size: number; received: number; organized: boolean };
type EventRow = { seq: number; turnId: string; kind: string; payload: unknown };
type ScopeStats = {
  turns: number; completed: number; failed: number; interrupted: number; undone: number; modelCalls: number;
  inputTokens: number; outputTokens: number; totalModelMs: number; medianModelMs: number | null; promptVersions: string[];
};
type DocumentLine = {
  id: string; product: string; brand: string; specification: string; unit: string; originalQuantity: string;
  receivedQuantity: number | null; unitPriceCents: number | null; price: string | null; amountCents: number | null; status: string;
  blank?: boolean; invalidPrice?: string; priceSource?: ItemInput['priceSource']; catalogStatus?: ItemInput['catalogStatus'];
  priceHint?: string | null;
};
type DocumentCustomer = {
  sheetId: string; customer: string; partyId: string | null; reviewed: boolean; deliveryCompleted: boolean; locked: boolean;
  orderCents: number | null; orderPendingPrices: number; dueCents: number; pendingPrices: number; lines: DocumentLine[];
};
type EvalDraftItem = ItemInput;
type EvalDraftCustomer = { id: string; customer: string; partyId?: string | null; items: EvalDraftItem[] };
type EvalTurnRow = {
  id: string; draftId: string; startRevision: number; endRevision: number; status: string; undone: boolean;
  createdAt: Date; beforeCustomers: unknown; userText: string; materialIds: string[]; assistantText: string;
};
type EvalEventRow = { seq: number; kind: string; payload: unknown };
type EvalPreviousRow = { text: string; payload: unknown; confirmation: unknown };

function evalDraftCustomers(value: unknown): EvalDraftCustomer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    if (!isObject(raw) || !Array.isArray(raw.items)) return [];
    return [{
      id: typeof raw.id === 'string' ? raw.id : '',
      customer: typeof raw.customer === 'string' ? raw.customer : '',
      ...(typeof raw.partyId === 'string' || raw.partyId === null ? { partyId: raw.partyId } : {}),
      items: raw.items.filter(isObject).map(item => ({
        id: typeof item.id === 'string' ? item.id : '',
        product: typeof item.product === 'string' ? item.product : '',
        brand: typeof item.brand === 'string' ? item.brand : '',
        specification: typeof item.specification === 'string' ? item.specification : '',
        unit: typeof item.unit === 'string' ? item.unit : '',
        quantity: typeof item.quantity === 'string' ? item.quantity : '',
        ...(typeof item.catalogProductId === 'string' ? { catalogProductId: item.catalogProductId } : {}),
        ...(typeof item.catalogVariantId === 'string' ? { catalogVariantId: item.catalogVariantId } : {}),
        ...(item.priceSource === null || itemPriceSources.some(source => source === item.priceSource)
          ? { priceSource: item.priceSource as ItemInput['priceSource'] } : {}),
        ...(catalogStatuses.some(status => status === item.catalogStatus) ? { catalogStatus: item.catalogStatus as ItemInput['catalogStatus'] } : {}),
        ...(typeof item.priceHint === 'string' ? { priceHint: item.priceHint } : {}),
        price: typeof item.price === 'string' ? item.price : item.price === null || item.price === undefined ? null : String(item.price),
      })),
    }];
  });
}

function spokenPrices(text: string): string[] {
  const normalized = text.normalize('NFKC');
  const prices = [...normalized.matchAll(/(\d+(?:\.\d+)?)\s*(?:元|块)/g)].map(match => match[1]);
  for (const token of spokenNumbers(normalized)) {
    if (token.value === null) continue;
    if (/[元块]/.test(normalized.slice(token.start, token.end))) prices.push(String(token.value));
  }
  return [...new Set(prices)];
}

function nonEmptyPrice(price: unknown): string | null {
  if (typeof price !== 'string' || !price.trim()) return null;
  return price.trim();
}

function maskSubject(subject: string): string {
  const value = Array.from(subject);
  if (value.length <= 8) return subject;
  return `${value.slice(0, 4).join('')}...${value.slice(-4).join('')}`;
}

export async function requireAccount(client: PoolClient, accountId: string): Promise<void> {
  const { rowCount } = await client.query('SELECT 1 FROM dispatch.accounts WHERE id = $1', [accountId]);
  if (!rowCount) throw new HttpError(404, 'account_not_found', '未找到配送员账号');
}

export async function listAccounts(pool: Pool) {
  const accounts = await transaction(pool, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query<AccountRow>(`
      SELECT id, identity_provider AS provider, identity_subject AS subject, remark_name AS "remarkName",
        activated_at IS NOT NULL AS activated, disabled_at IS NOT NULL AS disabled, disabled_at AS "disabledAt",
        last_active_at AS "lastActiveAt", catalog_revision AS "catalogRevision"
      FROM dispatch.accounts ORDER BY identity_provider, identity_subject, id
    `);
    return rows;
  });
  const summaries = [];
  for (const account of accounts) {
    const summary = await readAccount(pool, account.id, async client => {
      const { rows: [workspace] } = await client.query<{ id: string; revision: number; currentTripId: string | null }>(
        'SELECT draft_id AS id, draft_revision AS revision, current_trip_id AS "currentTripId" FROM dispatch.workspaces WHERE account_id = $1',
        [account.id]);
      const { rows: [counts] } = await client.query<{
        tripCount: number; partyCount: number; aliasCount: number; turnCount: number; lastTurnAt: Date | null; openMistakeCount: number;
        catalogProductCount: number; catalogVariantCount: number; missingUnitCount: number;
      }>(`
        WITH catalog AS (
          SELECT v.product_id, v.unit FROM dispatch.catalog_variants v
          JOIN dispatch.catalog_products p ON p.account_id = v.account_id AND p.id = v.product_id
          WHERE v.account_id = $1 AND NOT v.archived AND NOT p.archived
        )
        SELECT
          (SELECT count(*)::int FROM dispatch.trips WHERE account_id = $1) AS "tripCount",
          (SELECT count(*)::int FROM dispatch.parties WHERE account_id = $1) AS "partyCount",
          (SELECT count(*)::int FROM dispatch.customer_aliases WHERE account_id = $1) AS "aliasCount",
          (SELECT count(*)::int FROM dispatch.agent_turns WHERE account_id = $1) AS "turnCount",
          (SELECT max(created_at) FROM dispatch.agent_turns WHERE account_id = $1) AS "lastTurnAt",
          (SELECT count(*)::int FROM dispatch.mistake_cases WHERE account_id = $1 AND status = 'open') AS "openMistakeCount",
          (SELECT count(DISTINCT product_id)::int FROM catalog) AS "catalogProductCount",
          (SELECT count(*)::int FROM catalog) AS "catalogVariantCount",
          (SELECT count(*)::int FROM catalog WHERE unit IS NULL) AS "missingUnitCount"
      `, [account.id]);
      return {
        draftId: workspace?.id ?? null, draftRevision: workspace?.revision ?? null,
        draftConfirmed: Boolean(workspace && workspace.id === workspace.currentTripId), currentTripId: workspace?.currentTripId ?? null,
        ...counts,
      };
    });
    summaries.push({
      ...account, subject: maskSubject(account.subject), ...summary,
      lastTurnAt: summary.lastTurnAt ? summary.lastTurnAt.toISOString() : null,
    });
  }
  summaries.sort((left, right) => {
    const leftTime = left.lastTurnAt ? Date.parse(left.lastTurnAt) : 0;
    const rightTime = right.lastTurnAt ? Date.parse(right.lastTurnAt) : 0;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0;
  });
  return { accounts: summaries };
}

export async function accountOverview(pool: Pool, accountId: string) {
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    const workspace = await readWorkspace(client, accountId);
    const { rows } = await client.query<{
      id: string; issuedAt: Date; customers: TripVersion['customers']; deliveryEdits: DeliveryEdits;
      delivered: number; turnCount: number;
    }>(`
      SELECT t.id, first.saved_at AS "issuedAt", head.customers, t.delivery_edits AS "deliveryEdits",
        (SELECT count(*)::int FROM dispatch.sheets s
         WHERE s.account_id = t.account_id AND s.trip_id = t.id AND s.delivery_completed) AS delivered,
        (SELECT count(*)::int FROM dispatch.agent_turns at
         WHERE at.account_id = t.account_id AND at.draft_id = t.id) AS "turnCount"
      FROM dispatch.trips t
      JOIN dispatch.trip_versions first ON first.account_id = t.account_id AND first.trip_id = t.id AND first.version = 1
      CROSS JOIN LATERAL (
        SELECT customers FROM dispatch.trip_versions
        WHERE account_id = t.account_id AND trip_id = t.id ORDER BY version DESC LIMIT 1
      ) head
      WHERE t.account_id = $1
      ORDER BY first.saved_at DESC, t.id DESC LIMIT 100
    `, [accountId]);
    const trips = rows.map(row => {
      const lines = row.customers.flatMap(customer => deliveryLines(customer, row.deliveryEdits));
      const summary = deliverySummary(lines);
      return {
        id: row.id, issuedAt: row.issuedAt.toISOString(), customers: row.customers.length, lines: lines.length,
        delivered: row.delivered, totalCents: summary.totalCents, pendingPrices: summary.pendingPrices,
        turnCount: row.turnCount,
      };
    });
    const { rows: staleDrafts } = await client.query<{
      id: string; turnCount: number; firstTurnAt: Date; lastTurnAt: Date;
    }>(`
      SELECT t.draft_id AS id, count(*)::int AS "turnCount", min(t.created_at) AS "firstTurnAt", max(t.created_at) AS "lastTurnAt"
      FROM dispatch.agent_turns t
      WHERE t.account_id = $1 AND t.draft_id <> $2
        AND NOT EXISTS (SELECT 1 FROM dispatch.trips tr WHERE tr.account_id = $1 AND tr.id = t.draft_id)
      GROUP BY t.draft_id ORDER BY max(t.created_at) DESC, t.draft_id
    `, [accountId, workspace.id]);
    const parties = await readParties(client, accountId);
    const { rows: aliases } = await client.query<{
      alias: string; normalizedAlias: string; customerId: string; canonicalName: string;
    }>(`
      SELECT a.alias, a.normalized_alias AS "normalizedAlias", a.customer_id AS "customerId", p.name AS "canonicalName"
      FROM dispatch.customer_aliases a
      JOIN dispatch.parties p ON p.account_id = a.account_id AND p.id = a.customer_id
      WHERE a.account_id = $1 ORDER BY p.name, a.normalized_alias
    `, [accountId]);
    return {
      accountId,
      draft: workspaceDraft(workspace),
      draftConfirmed: workspace.id === workspace.currentTripId,
      currentTripId: workspace.currentTripId,
      catalogSummary: summarizeCatalog(await loadCatalog(client, accountId)),
      trips,
      staleDrafts: staleDrafts.map(draft => ({
        id: draft.id, turnCount: draft.turnCount, firstTurnAt: draft.firstTurnAt.toISOString(),
        lastTurnAt: draft.lastTurnAt.toISOString(),
      })),
      parties,
      aliases,
    };
  });
}

export async function readTurnEvents(client: PoolClient, accountId: string, turnIds: string[]) {
  if (!turnIds.length) return [] as EventRow[];
  const { rows } = await client.query<EventRow>(`
    SELECT seq::float8 AS seq, turn_id AS "turnId", kind, payload
    FROM dispatch.agent_events WHERE account_id = $1 AND turn_id = ANY($2::uuid[]) ORDER BY seq ASC
  `, [accountId, turnIds]);
  return rows;
}

async function scopeStats(client: PoolClient, accountId: string, scopeId: string): Promise<ScopeStats> {
  const { rows: [stats] } = await client.query<ScopeStats>(`
    WITH scope_turns AS (
      SELECT id, status, undone FROM dispatch.agent_turns WHERE account_id = $1 AND draft_id = $2
    ), model_events AS (
      SELECT e.payload FROM dispatch.agent_events e JOIN scope_turns t ON t.id = e.turn_id
      WHERE e.account_id = $1 AND e.kind = 'model'
    )
    SELECT
      (SELECT count(*)::int FROM scope_turns) AS turns,
      (SELECT count(*)::int FROM scope_turns WHERE status = 'completed') AS completed,
      (SELECT count(*)::int FROM scope_turns WHERE status = 'failed') AS failed,
      (SELECT count(*)::int FROM scope_turns WHERE status = 'interrupted') AS interrupted,
      (SELECT count(*)::int FROM scope_turns WHERE undone) AS undone,
      (SELECT count(*)::int FROM model_events) AS "modelCalls",
      coalesce((SELECT sum((payload->>'inputTokens')::numeric) FROM model_events), 0)::float8 AS "inputTokens",
      coalesce((SELECT sum((payload->>'outputTokens')::numeric) FROM model_events), 0)::float8 AS "outputTokens",
      coalesce((SELECT sum((payload->>'elapsedMs')::numeric) FROM model_events), 0)::float8 AS "totalModelMs",
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (payload->>'elapsedMs')::numeric) FROM model_events)::float8 AS "medianModelMs",
      coalesce((SELECT jsonb_agg(DISTINCT payload->>'promptVersion')
        FROM model_events WHERE payload->>'promptVersion' IS NOT NULL), '[]'::jsonb) AS "promptVersions"
  `, [accountId, scopeId]);
  return stats;
}

export async function scopeDocument(client: PoolClient, trips: TripStore, accountId: string, scopeId: string) {
  const workspace = await readWorkspace(client, accountId);
  const { rowCount: isTrip } = await client.query('SELECT 1 FROM dispatch.trips WHERE account_id = $1 AND id = $2',
    [accountId, scopeId]);
  let document: Record<string, unknown>;
  if (isTrip) {
    const formal = await trips.readTrip(client, accountId, scopeId);
    const version = latest(formal.trip);
    const bySheet = new Map(formal.sheets.map(sheet => [sheet.sheetId, sheet]));
    const customers: DocumentCustomer[] = version.customers.map(customer => {
      const sheet = bySheet.get(customer.id);
      const lines = deliveryLines(customer, formal.deliveryEdits);
      const summary = deliverySummary(lines);
      return {
        sheetId: customer.id, customer: customer.customer, partyId: sheet?.partyId ?? customer.partyId ?? null,
        reviewed: sheet?.reviewed ?? false, deliveryCompleted: sheet?.deliveryCompleted ?? false,
        locked: Boolean(sheet?.reviewed || sheet?.deliveryCompleted),
        orderCents: customer.totalCents,
        orderPendingPrices: customer.items.filter(item => item.amountCents === null).length,
        dueCents: summary.totalCents, pendingPrices: summary.pendingPrices,
        lines: lines.map(line => ({
          id: line.id, product: line.product, brand: line.brand, specification: line.specification, unit: line.unit,
          originalQuantity: line.originalQuantity, receivedQuantity: line.receivedQuantity,
          unitPriceCents: line.unitPriceCents, price: line.price, amountCents: line.amountCents,
          status: formal.trip.statuses[line.id] ?? 'pending',
        })),
      };
    });
    document = {
      type: 'trip', scopeId, version: version.version, statusRevision: formal.trip.statusRevision,
      issuedAt: formal.trip.versions[0]?.savedAt ?? null,
      totalCents: version.totalCents, dueCents: customers.reduce((sum, customer) => sum + customer.dueCents, 0),
      pendingPrices: customers.reduce((sum, customer) => sum + customer.pendingPrices, 0),
      customers, picking: formal.picking,
    };
  } else if (workspace.id === scopeId) {
    const draft = workspaceDraft(workspace);
    const customers: DocumentCustomer[] = draft.customers.map(customer => {
      let dueCents = 0;
      let pendingPrices = 0;
      const lines: DocumentLine[] = customer.items.map(item => {
        const price = nullablePrice(item.price);
        let cents: number | null = null;
        let invalidPrice: string | undefined;
        if (price !== null) {
          if (validTextPrice(price)) cents = yuanToCents(price);
          else invalidPrice = price;
        }
        const emptyRow = !item.product.trim() && !item.brand.trim() && !item.specification.trim()
          && !item.quantity.trim() && price === null;
        const quantityText = item.quantity.trim();
        const qty = /^[1-9]\d*$/.test(quantityText) && Number.isSafeInteger(Number(quantityText))
          ? Number(quantityText) : null;
        let amountCents: number | null = null;
        if (!emptyRow) {
          if (qty !== null && cents !== null && Number.isSafeInteger(qty * cents)) amountCents = qty * cents;
          if (amountCents === null) pendingPrices++;
          else dueCents += amountCents;
        }
        return {
          id: item.id, product: item.product, brand: item.brand, specification: item.specification, unit: item.unit,
          originalQuantity: item.quantity, receivedQuantity: null, unitPriceCents: cents, price, amountCents, status: 'draft',
          blank: emptyRow, ...(invalidPrice ? { invalidPrice } : {}),
          ...(item.priceSource ? { priceSource: item.priceSource } : {}),
          ...(item.catalogStatus ? { catalogStatus: item.catalogStatus } : {}),
          ...(item.priceHint ? { priceHint: item.priceHint } : {}),
        };
      });
      return {
        sheetId: customer.id, customer: customer.customer, partyId: customer.partyId ?? null,
        reviewed: false, deliveryCompleted: false, locked: false,
        orderCents: null, orderPendingPrices: 0, dueCents, pendingPrices, lines,
      };
    });
    document = {
      type: 'draft', scopeId, revision: draft.revision,
      draftConfirmed: workspace.currentTripId === draft.id,
      totalCents: customers.reduce((sum, customer) => sum + customer.dueCents, 0),
      dueCents: customers.reduce((sum, customer) => sum + customer.dueCents, 0),
      pendingPrices: customers.reduce((sum, customer) => sum + customer.pendingPrices, 0),
      customers,
    };
  } else {
    const { rowCount: hasTurns } = await client.query(
      'SELECT 1 FROM dispatch.agent_turns WHERE account_id = $1 AND draft_id = $2 LIMIT 1', [accountId, scopeId]);
    if (!hasTurns) throw new HttpError(404, 'scope_not_found', '未找到这个草稿或正式趟');
    document = {
      type: 'draft', scopeId, revision: null, draftConfirmed: false, stale: true,
      totalCents: 0, dueCents: 0, pendingPrices: 0, customers: [], picking: [],
    };
  }

  return document;
}

export async function turnTimeline<T extends StoredTurnRow>(client: PoolClient, accountId: string, turns: T[]) {
  const turnIds = turns.map(turn => turn.id);
  const { rows: messages } = turnIds.length ? await client.query<MessageRow>(`
    SELECT turn_id AS "turnId", role, content, material_ids AS "materialIds"
    FROM dispatch.agent_messages WHERE account_id = $1 AND turn_id = ANY($2::uuid[])
  `, [accountId, turnIds]) : { rows: [] as MessageRow[] };
  const materialIds = [...new Set(messages.flatMap(message => message.materialIds))];
  const { rows: materials } = materialIds.length ? await client.query<MaterialRow>(`
    SELECT m.id, m.name, m.size, m.received,
      EXISTS (SELECT 1 FROM dispatch.image_order_inputs i
        WHERE i.account_id = m.account_id AND i.draft_id = m.draft_id AND i.image_digest = m.digest) AS organized
    FROM dispatch.materials m WHERE m.account_id = $1 AND m.id = ANY($2::uuid[])
  `, [accountId, materialIds]) : { rows: [] as MaterialRow[] };
  const events = await readTurnEvents(client, accountId, turnIds);
  const messageByTurn = new Map<string, { user?: MessageRow; assistant?: MessageRow }>();
  for (const message of messages) {
    const entry = messageByTurn.get(message.turnId) ?? {};
    if (message.role === 'user') entry.user = message;
    else entry.assistant = message;
    messageByTurn.set(message.turnId, entry);
  }
  const materialById = new Map(materials.map(material => [material.id, material]));
  const eventsByTurn = new Map<string, EventRow[]>();
  for (const event of events) {
    const list = eventsByTurn.get(event.turnId) ?? [];
    list.push(event);
    eventsByTurn.set(event.turnId, list);
  }
  return turns.map(turn => {
    const entry = messageByTurn.get(turn.id) ?? {};
    const turnEvents = eventsByTurn.get(turn.id) ?? [];
    const end = turnEvents.find(event => event.kind === 'end');
    const elapsedMs = end && typeof end.payload === 'object' && end.payload !== null
      && typeof (end.payload as { elapsedMs?: unknown }).elapsedMs === 'number'
      ? (end.payload as { elapsedMs: number }).elapsedMs : null;
    const userMaterials = (entry.user?.materialIds ?? []).flatMap(id => {
      const material = materialById.get(id);
      return material ? [{ id: material.id, name: material.name, size: material.size,
        received: material.received, organized: material.organized }] : [];
    });
    return {
      ...turn,
      undone: turn.undone, createdAt: turn.createdAt.toISOString(), elapsedMs,
      userText: entry.user?.content ?? '', materialIds: entry.user?.materialIds ?? [], materials: userMaterials,
      assistantText: entry.assistant?.content ?? '',
      events: turnEvents.map(event => ({ seq: event.seq, kind: event.kind, payload: event.payload })),
    };
  });
}

export async function readScope(pool: Pool, trips: TripStore, accountId: string, scopeId: string) {
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    const document = await scopeDocument(client, trips, accountId, scopeId);
    const { rows: turns } = await client.query<StoredTurnRow>(`
      SELECT id, status, start_revision AS "startRevision", end_revision AS "endRevision", undone, created_at AS "createdAt"
      FROM dispatch.agent_turns WHERE account_id = $1 AND draft_id = $2
      ORDER BY created_at ASC, id ASC LIMIT 200
    `, [accountId, scopeId]);
    const timeline = await turnTimeline(client, accountId, turns);
    const stats = await scopeStats(client, accountId, scopeId);
    return { accountId, scopeId, document, turns: timeline, stats };
  });
}

export function readEvalCase(pool: Pool, accountId: string, turnId: string, includeCatalog: boolean) {
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    return readEvalCaseSnapshot(client, accountId, turnId, includeCatalog);
  });
}

export async function readEvalCaseSnapshot(client: PoolClient, accountId: string, turnId: string, includeCatalog: boolean) {
  const { rows: [turn] } = await client.query<EvalTurnRow>(`
    SELECT t.id, t.draft_id AS "draftId", t.start_revision AS "startRevision", t.end_revision AS "endRevision",
      t.status, t.undone, t.created_at AS "createdAt", t.before_customers AS "beforeCustomers",
      coalesce(user_message.content, '') AS "userText", coalesce(user_message.material_ids, '{}') AS "materialIds",
      coalesce(assistant_message.content, '') AS "assistantText"
    FROM dispatch.agent_turns t
    LEFT JOIN dispatch.agent_messages user_message
      ON user_message.account_id = t.account_id AND user_message.turn_id = t.id AND user_message.role = 'user'
    LEFT JOIN dispatch.agent_messages assistant_message
      ON assistant_message.account_id = t.account_id AND assistant_message.turn_id = t.id AND assistant_message.role = 'assistant'
    WHERE t.account_id = $1 AND t.id = $2
  `, [accountId, turnId]);
  if (!turn) throw new HttpError(404, 'turn_not_found', '未找到这条消息');
  const { rows: events } = await client.query<EvalEventRow>(`
    SELECT seq::float8 AS seq, kind, payload FROM dispatch.agent_events
    WHERE account_id = $1 AND turn_id = $2 ORDER BY seq ASC
  `, [accountId, turnId]);
  const { rows: [trip] } = await client.query<{ issuedAt: Date }>(`
    SELECT first.saved_at AS "issuedAt"
    FROM dispatch.trips t
    JOIN dispatch.trip_versions first ON first.account_id = t.account_id AND first.trip_id = t.id AND first.version = 1
    WHERE t.account_id = $1 AND t.id = $2
  `, [accountId, turn.draftId]);
  const delivery = events.some(event => event.kind === 'delivery_intent' || event.kind === 'delivery_proposal')
    || Boolean(trip && turn.createdAt >= trip.issuedAt);
  const { rows: [previousRow] } = await client.query<EvalPreviousRow>(`
    SELECT user_message.content AS text, question.payload, confirmation.payload AS confirmation
    FROM dispatch.agent_turns t
    JOIN dispatch.agent_messages user_message
      ON user_message.account_id = t.account_id AND user_message.turn_id = t.id AND user_message.role = 'user'
    JOIN dispatch.agent_events question
      ON question.account_id = t.account_id AND question.turn_id = t.id AND question.kind = 'questions'
    LEFT JOIN dispatch.agent_events confirmation
      ON confirmation.account_id = t.account_id AND confirmation.turn_id = t.id AND confirmation.kind = 'edit_confirmation'
    WHERE t.account_id = $1 AND t.draft_id = $2 AND t.end_revision = $3 AND NOT t.undone AND t.status = 'completed'
      AND coalesce(question.payload->>'mode', '') = $5
      AND t.id = (SELECT id FROM dispatch.agent_turns
        WHERE account_id = $1 AND draft_id = $2 AND id <> $4
        ORDER BY created_at DESC, id DESC LIMIT 1)
    ORDER BY question.seq DESC LIMIT 1
  `, [accountId, turn.draftId, turn.startRevision, turn.id, delivery ? 'delivery' : '']);
  const catalog = includeCatalog && !delivery ? await loadCatalog(client, accountId) : [];
  const catalogKeys = new Map(catalog.map(variant =>
    [variant.variantId, JSON.stringify([variant.productCode, variant.variantCode])]));
  const productKeys = new Map(catalog.map(variant => [variant.productId, variant.productCode]));
  const catalogVariantKeyFor = (catalogVariantId: string | null | undefined) => {
    if (!includeCatalog || !catalogVariantId) return undefined;
    if (!catalogKeys.has(catalogVariantId)) catalogKeys.set(catalogVariantId, `archived-${catalogKeys.size + 1}`);
    return catalogKeys.get(catalogVariantId);
  };
  const beforeCustomers = evalDraftCustomers(turn.beforeCustomers);
  const rawLinks = events.filter(event => event.kind === 'customer_links').flatMap(event =>
    isObject(event.payload) && Array.isArray(event.payload.links) ? event.payload.links : []);
  const referencedPartyIds = [...new Set([
    ...beforeCustomers.flatMap(customer => typeof customer.partyId === 'string' ? [customer.partyId] : []),
    ...rawLinks.flatMap(link => isObject(link) && typeof link.customerId === 'string' ? [link.customerId] : []),
  ])];
  const { rows: parties } = await client.query<{ id: string; name: string }>(delivery ? `
    SELECT id, name FROM dispatch.parties WHERE account_id = $1 ORDER BY name, id
  ` : `
    SELECT p.id, p.name FROM dispatch.parties p
    WHERE p.account_id = $1
      AND (p.id = ANY($2::uuid[])
        OR EXISTS (
          SELECT 1 FROM dispatch.sheets s
          JOIN dispatch.trip_versions first
            ON first.account_id = s.account_id AND first.trip_id = s.trip_id AND first.version = 1
          WHERE s.account_id = p.account_id AND s.party_id = p.id
            AND s.trip_id <> $3 AND first.saved_at <= $4
        )
        OR EXISTS (
          SELECT 1 FROM dispatch.customer_aliases a
          WHERE a.account_id = p.account_id AND a.customer_id = p.id AND a.created_at <= $4
        )
        OR EXISTS (
          SELECT 1 FROM dispatch.opening_debts o
          WHERE o.account_id = p.account_id AND o.party_id = p.id
        )
        OR NOT EXISTS (
          SELECT 1 FROM dispatch.sheets s
          WHERE s.account_id = p.account_id AND s.party_id = p.id
        ))
    ORDER BY p.name, p.id
  `, delivery ? [accountId] : [accountId, referencedPartyIds, turn.draftId, turn.createdAt]);
  const partyKeys = new Map(parties.map((party, index) => [party.id, `party-${index + 1}`]));
  const partyKey = (id: string | null | undefined) => id === undefined ? undefined : id === null ? null : partyKeys.get(id) ?? null;
  const mapCustomers = (customers: EvalDraftCustomer[]) => customers.map(customer => ({
    ...customer, ...(customer.partyId === undefined ? {} : { partyId: partyKey(customer.partyId) }),
    items: customer.items.map(({ catalogProductId, catalogVariantId, ...item }) => {
      const catalogVariantKey = catalogVariantKeyFor(catalogVariantId);
      const catalogProductKey = productKeys.get(catalogProductId ?? '');
      return { ...item, ...(catalogVariantKey ? { catalogVariantKey } : {}), ...(catalogProductKey ? { catalogProductKey } : {}) };
    }),
  }));
  const { rows: aliases } = await client.query<{
    alias: string; normalizedAlias: string; customerId: string;
  }>(delivery ? `
    SELECT alias, normalized_alias AS "normalizedAlias", customer_id AS "customerId"
    FROM dispatch.customer_aliases WHERE account_id = $1 ORDER BY normalized_alias
  ` : `
    SELECT alias, normalized_alias AS "normalizedAlias", customer_id AS "customerId"
    FROM dispatch.customer_aliases WHERE account_id = $1 AND updated_at <= $2 ORDER BY normalized_alias
  `, delivery ? [accountId] : [accountId, turn.createdAt]);
  const exportAliases = aliases.flatMap(alias => {
    const key = partyKeys.get(alias.customerId);
    return key ? [{ partyKey: key, alias: alias.alias, normalizedAlias: alias.normalizedAlias }] : [];
  });
  const { rows: historyRows } = await client.query<{
    tripId: string; sheetId: string; partyId: string; reviewed: boolean; deliveryCompleted: boolean;
    statuses: Record<string, string>; edits: DeliveryEdits; customer: TripVersion['customers'][number]; issuedAt: string;
  }>(`
    SELECT s.trip_id AS "tripId", s.id AS "sheetId", s.party_id AS "partyId", s.reviewed, s.delivery_completed AS "deliveryCompleted",
      t.statuses, t.delivery_edits AS edits, sheet.customer,
      to_char(first.saved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "issuedAt"
    FROM dispatch.sheets s
    JOIN dispatch.trips t ON t.account_id = s.account_id AND t.id = s.trip_id
    JOIN dispatch.trip_versions first ON first.account_id = s.account_id
      AND first.trip_id = s.trip_id AND first.version = 1
    CROSS JOIN LATERAL (
      SELECT customers FROM dispatch.trip_versions
      WHERE account_id = s.account_id AND trip_id = s.trip_id ORDER BY version DESC LIMIT 1
    ) head
    CROSS JOIN LATERAL jsonb_array_elements(head.customers) AS sheet(customer)
    WHERE s.account_id = $1 AND s.party_id = ANY($2::uuid[]) AND sheet.customer->>'id' = s.id
      ${delivery ? '' : 'AND s.trip_id <> $3 AND first.saved_at <= $4'}
    ORDER BY first.saved_at DESC, s.trip_id, s.id LIMIT 100
  `, delivery ? [accountId, [...partyKeys.keys()]]
    : [accountId, [...partyKeys.keys()], turn.draftId, turn.createdAt]);
  const history = new Map<string, { key: string; partyKey: string; issuedAt: string; deliveryCompleted: boolean; lines: {
    product: string; brand: string; specification: string; unit: string; quantity: string; price: string; catalogVariantKey?: string;
  }[] }>();
  for (const row of historyRows) {
    const key = partyKeys.get(row.partyId);
    if (!key) continue;
    const historyKey = `${row.tripId}:${row.partyId}`;
    let group = history.get(historyKey);
    if (!group) {
      group = { key: `history-${history.size + 1}`, partyKey: key, issuedAt: row.issuedAt, deliveryCompleted: row.deliveryCompleted, lines: [] };
      history.set(historyKey, group);
    }
    for (const line of deliveryLines(row.customer, row.edits)) {
      const edit = Object.prototype.hasOwnProperty.call(row.edits, line.id) ? row.edits[line.id] : undefined;
      if (row.reviewed && edit?.receivedQuantity === undefined && row.statuses[line.id] === 'pending') continue;
      if (line.unitPriceCents === null || line.unitPriceCents <= 0 || line.receivedQuantity <= 0) continue;
      const catalogVariantKey = catalogVariantKeyFor(line.catalogVariantId);
      group.lines.push({ product: line.product, brand: line.brand, specification: line.specification, unit: line.unit,
        quantity: String(line.receivedQuantity), price: money(line.unitPriceCents),
        ...(catalogVariantKey ? { catalogVariantKey } : {}) });
    }
  }
  const historicalSales = [...history.values()].filter(group => group.lines.length > 0);
  let endCustomers: EvalDraftCustomer[] = [];
  let endSnapshotFound = false;
  let environmentNote: string | undefined;
  if (!delivery && !turn.undone && turn.startRevision === turn.endRevision) {
    endCustomers = beforeCustomers;
    endSnapshotFound = true;
  } else if (!delivery) {
    const { rows: [nextTurn] } = await client.query<{ beforeCustomers: unknown }>(`
      SELECT before_customers AS "beforeCustomers" FROM dispatch.agent_turns
      WHERE account_id = $1 AND draft_id = $2 AND id <> $3 AND start_revision = $4
      ORDER BY created_at ASC, id ASC LIMIT 1
    `, [accountId, turn.draftId, turn.id, turn.endRevision]);
    if (nextTurn) {
      endCustomers = evalDraftCustomers(nextTurn.beforeCustomers);
      endSnapshotFound = true;
    }
    if (!endSnapshotFound) {
      const { rows: [workspace] } = await client.query<{ customers: unknown }>(`
        SELECT draft_customers AS customers FROM dispatch.workspaces
        WHERE account_id = $1 AND draft_id = $2 AND draft_revision = $3
      `, [accountId, turn.draftId, turn.endRevision]);
      if (workspace) {
        endCustomers = evalDraftCustomers(workspace.customers);
        endSnapshotFound = true;
      }
    }
    if (!endSnapshotFound) {
      const { rows: [previewRow] } = await client.query<{ preview: unknown }>(`
        SELECT preview FROM dispatch.trip_previews
        WHERE account_id = $1 AND draft_id = $2 AND draft_revision = $3
      `, [accountId, turn.draftId, turn.endRevision]);
      const preview = isObject(previewRow?.preview) ? previewRow.preview : null;
      if (preview) {
        const choices = Array.isArray(preview.choices) ? preview.choices : [];
        endCustomers = evalDraftCustomers(preview.customers).map((customer, index) => {
          const choice = choices[index];
          return { ...customer, partyId: isObject(choice) && typeof choice.id === 'string' ? choice.id : null };
        });
        endSnapshotFound = true;
      }
    }
    if (!endSnapshotFound) {
      const { rows: [laterTurn] } = await client.query<{ beforeCustomers: unknown }>(`
        SELECT before_customers AS "beforeCustomers" FROM dispatch.agent_turns
        WHERE account_id = $1 AND draft_id = $2 AND created_at > $3 AND start_revision >= $4
        ORDER BY created_at ASC, id ASC LIMIT 1
      `, [accountId, turn.draftId, turn.createdAt, turn.endRevision]);
      if (laterTurn) {
        endCustomers = evalDraftCustomers(laterTurn.beforeCustomers);
        endSnapshotFound = true;
      }
      if (!endSnapshotFound) {
        const { rows: [workspace] } = await client.query<{ customers: unknown }>(`
          SELECT draft_customers AS customers FROM dispatch.workspaces
          WHERE account_id = $1 AND draft_id = $2
        `, [accountId, turn.draftId]);
        if (workspace) {
          endCustomers = evalDraftCustomers(workspace.customers);
          endSnapshotFound = true;
        }
      }
      if (!endSnapshotFound) {
        const { rows: [version] } = await client.query<{ customers: unknown }>(`
          SELECT customers FROM dispatch.trip_versions
          WHERE account_id = $1 AND trip_id = $2 ORDER BY version DESC LIMIT 1
        `, [accountId, turn.draftId]);
        if (version) {
          const { rows: sheetRows } = await client.query<{ id: string; partyId: string }>(`
            SELECT id, party_id AS "partyId" FROM dispatch.sheets
            WHERE account_id = $1 AND trip_id = $2
          `, [accountId, turn.draftId]);
          const sheetParties = new Map(sheetRows.map(row => [row.id, row.partyId]));
          endCustomers = evalDraftCustomers(version.customers).map(customer => ({
            ...customer, partyId: sheetParties.get(customer.id) ?? customer.partyId ?? null,
          }));
          endSnapshotFound = true;
        }
      }
      if (endSnapshotFound) {
        environmentNote = '注意：该回合后草稿发生过人工修改或撤销，回放前请核对 grader.expect.customers';
      }
    }
  }
  const lastEvent = (kind: string) => [...events].reverse().find(event => event.kind === kind);
  const endPayload = isObject(lastEvent('end')?.payload)
    ? lastEvent('end')!.payload as Record<string, unknown> : {};
  const questionPayloads = events.filter(event => event.kind === 'questions').map(event => event.payload);
  const questions = questionPayloads.flatMap(payload =>
    isObject(payload) && Array.isArray(payload.questions) ? payload.questions : []);
  const changeLines = events.filter(event => event.kind === 'change').flatMap(event =>
    isObject(event.payload) && Array.isArray(event.payload.lines) ? event.payload.lines : []);
  const customerLinks = rawLinks.filter(isObject).map(link => ({ spoken: link.spoken, canonicalName: link.canonicalName,
    matchedBy: link.matchedBy, merged: Boolean(link.merged) }));
  const proposalEvent = lastEvent('delivery_proposal');
  const deliveryIntentEvent = lastEvent('delivery_intent');
  const proposal = isObject(proposalEvent?.payload) ? proposalEvent.payload : null;
  const observed = {
    status: turn.status, startRevision: turn.startRevision, endRevision: turn.endRevision, undone: turn.undone,
    elapsedMs: typeof endPayload.elapsedMs === 'number' ? endPayload.elapsedMs : null,
    assistantText: turn.assistantText,
    models: events.filter(event => event.kind === 'model').map(event => event.payload),
    tools: events.filter(event => event.kind === 'tool').map(event => event.payload),
    questions, changeLines, customerLinks,
    deliveryProposal: proposal,
    deliveryIntent: isObject(deliveryIntentEvent?.payload) ? deliveryIntentEvent.payload : null,
  };
  let deliveryCustomers: EvalDraftCustomer[] = [];
  if (delivery) {
    const { rows: [snapshot] } = await client.query<{ customers: unknown; sheetParties: Record<string, string> }>(`
      SELECT head.customers,
        (SELECT coalesce(jsonb_object_agg(s.id, s.party_id), '{}'::jsonb) FROM dispatch.sheets s
          WHERE s.account_id = t.account_id AND s.trip_id = t.id) AS "sheetParties"
      FROM dispatch.trips t
      CROSS JOIN LATERAL (
        SELECT customers FROM dispatch.trip_versions
        WHERE account_id = t.account_id AND trip_id = t.id ORDER BY version DESC LIMIT 1
      ) head WHERE t.account_id = $1 AND t.id = $2
    `, [accountId, turn.draftId]);
    deliveryCustomers = evalDraftCustomers(snapshot?.customers).map(customer => ({
      ...customer, partyId: snapshot?.sheetParties?.[customer.id] ?? customer.partyId ?? null,
    }));
  }
  const environment: Record<string, unknown> = delivery ? {
    tripCustomers: mapCustomers(deliveryCustomers),
  } : {
    beforeCustomers: mapCustomers(beforeCustomers),
    parties: parties.map(party => ({ key: partyKeys.get(party.id), name: party.name })),
    aliases: exportAliases,
    historicalSales,
    ...(catalog.length ? { catalog: catalog.map(({ productId, variantId, ...row }) => row) } : {}),
  };
  if (environmentNote) environment.environmentNote = environmentNote;
  if (!delivery && !includeCatalog && events.some(event => event.kind === 'tool' && isObject(event.payload)
    && isObject(event.payload.result) && Array.isArray(event.payload.result.catalog))) {
    environment.catalogNote = '该回合使用了货品库，请按需用 catalog=1 导出当前货品库快照。';
  }
  if (delivery) {
    const { rows: [formal] } = await client.query<{
      statuses: unknown; deliveryEdits: unknown; completedSheets: unknown;
    }>(`
      SELECT t.statuses, t.delivery_edits AS "deliveryEdits",
        (SELECT coalesce(jsonb_agg(s.id ORDER BY s.id), '[]'::jsonb) FROM dispatch.sheets s
          WHERE s.account_id = t.account_id AND s.trip_id = t.id AND s.delivery_completed) AS "completedSheets"
      FROM dispatch.trips t WHERE t.account_id = $1 AND t.id = $2
    `, [accountId, turn.draftId]);
    environment.statuses = formal?.statuses ?? {};
    environment.deliveryEdits = formal?.deliveryEdits ?? {};
    environment.completedSheets = Array.isArray(formal?.completedSheets) ? formal.completedSheets : [];
    environment.parties = parties.map(party => ({ key: partyKeys.get(party.id), name: party.name }));
    const { rowCount } = await client.query(`
      SELECT 1 FROM dispatch.agent_events
      WHERE account_id = $1 AND draft_id = $2 AND turn_id <> $3 AND kind = 'delivery_applied' AND created_at > $4 LIMIT 1
    `, [accountId, turn.draftId, turn.id, turn.createdAt]);
    if (rowCount) environment.environmentNote = '注意：该趟后续可能发生过新的配送确认，回放前请核对初始实收';
  }
  const beforePriceById = new Map(beforeCustomers.flatMap(customer => customer.items)
    .map(item => [item.id, nonEmptyPrice(item.price)]));
  const introducedPrices = delivery ? [] : endCustomers.flatMap(customer => customer.items).flatMap(item => {
    if (item.priceSource === 'catalog' || item.priceSource === 'customer_history' || item.priceSource === 'manual') return [];
    const price = nonEmptyPrice(item.price);
    return price && price !== beforePriceById.get(item.id) ? [price] : [];
  });
  const proposalPrices = proposal && Array.isArray(proposal.edits) ? proposal.edits
    .filter((edit: unknown) => isObject(edit)).flatMap(edit => {
      const price = nonEmptyPrice(edit.price);
      return price ? [price] : [];
    }) : [];
  const previousPayload = isObject(previousRow?.payload) ? previousRow.payload : {};
  const previous = previousRow ? {
    text: typeof previousPayload.context === 'string' ? previousPayload.context
      : typeof previousPayload.sourceText === 'string' ? previousPayload.sourceText : previousRow.text,
    questions: Array.isArray(previousPayload.questions) ? previousPayload.questions : [],
    ...(isObject(previousRow.confirmation) ? { confirmation: previousRow.confirmation } : {}),
  } : undefined;
  const priceSource = [turn.userText, previous?.text ?? ''].filter(Boolean).join('\n');
  // Kept for older case readers. The grader requires evidence for each line.
  const allowedPrices = [...new Set([
    ...spokenPrices(priceSource),
    ...introducedPrices.filter(price => hasSpokenNumber(priceSource, price)),
    ...proposalPrices.filter(price => hasSpokenNumber(priceSource, price)),
  ])];
  const priceLines = endCustomers.flatMap(customer => customer.items.filter(item => item.product.trim()).map(item => {
    const variant = catalog.find(row => row.variantId === item.catalogVariantId);
    return { customer, item, quote: { products: [item.product, ...(variant?.aliases ?? [])],
      customers: [customer.customer, ...aliases.filter(alias => alias.customerId === customer.partyId).map(alias => alias.alias)],
      specifications: [item.specification, variant?.flavorOrGrade ?? ''], unit: item.unit } };
  }));
  const linePriceEvidence = priceLines.flatMap(({ customer, item, quote }) => {
    const price = nonEmptyPrice(item.price);
    if (!price || price === beforePriceById.get(item.id) || (item.priceSource != null && item.priceSource !== 'spoken')
      || !hasQuotedLinePrice(priceSource, yuanToCents(price), quote, priceLines.map(row => row.quote))) return [];
    return [{ customer: customer.customer, partyKey: partyKey(customer.partyId) ?? null, product: item.product, brand: item.brand,
      specification: item.specification, unit: item.unit, price, source: 'spoken', medium: 'text' }];
  });
  const expectedCustomers = endCustomers
    .filter(customer => customer.customer.trim() || customer.items.some(item => item.product.trim() || nonEmptyPrice(item.price)))
    .map(customer => ({
      customer: customer.customer,
      linkedPartyKey: customer.partyId ? partyKey(customer.partyId) : null,
      items: customer.items.filter(item => item.product.trim() || item.quantity.trim() || nonEmptyPrice(item.price))
        .map(item => ({ product: item.product, brand: item.brand, specification: item.specification,
          unit: item.unit, quantity: item.quantity, price: nonEmptyPrice(item.price),
          ...(environmentNote || item.priceSource === undefined ? {} : { priceSource: item.priceSource }) })),
    }));
  const planEvent = events.find(event => event.kind === 'plan');
  const planSteps = isObject(planEvent?.payload) && Array.isArray(planEvent.payload.steps)
    ? planEvent.payload.steps : [];
  const chosenFromCard = !delivery && isObject(planSteps[0]) && planSteps[0].text === '已收到你的选择';
  const previewFromCard = chosenFromCard && !observed.models.length &&
    (observed.tools.some(tool => isObject(tool) && tool.name === 'preview_trip') || !previous);
  const directTask = delivery
    ? isObject(observed.deliveryIntent) && observed.deliveryIntent.direct === true ? 'draft' : undefined
    : previewFromCard ? 'preview' : chosenFromCard && previous ? 'draft' : undefined;
  const outcome = proposal ? 'proposal' : questions.length ? 'question' : 'text';
  const expect = delivery ? {
    status: turn.status, outcome,
    ...(proposal ? { proposal: {
      customer: typeof proposal.customer === 'string' ? proposal.customer : '',
      edits: Array.isArray(proposal.edits) ? proposal.edits.filter((edit: unknown) => isObject(edit)).map(edit => ({
        receivedQuantity: edit.receivedQuantity, price: nonEmptyPrice(edit.price),
      })) : [],
      canComplete: Boolean(proposal.canComplete),
    } } : {}),
    ...(questions.length && isObject(questions[0]) ? { questionIncludes: String(questions[0].text ?? '') } : {}),
  } : {
    status: turn.status, customers: expectedCustomers, questionCount: questions.length,
  };
  return {
    schemaVersion: 1, id: `case-${turn.id.slice(0, 8)}`, mode: delivery ? 'delivery' : 'entry',
    exportedAt: new Date().toISOString(),
    task: { text: turn.userText, ...(previous ? { previous } : {}), hasImages: turn.materialIds.length > 0,
      ...(directTask ? { direct: directTask } : {}),
      ...(turn.materialIds.length ? { note: '原回合含上传图片，回放时可配置固定图片识别桩或替换测试图' } : {}) },
    environment, observed,
    grader: {
      redLines: { forbidFormalConfirm: true, forbidInventedPrice: true, forbidSilentCustomerBind: true,
        ...(allowedPrices.length ? { allowedPrices } : {}),
        ...(environmentNote && !delivery ? { quotedText: [previous?.text, turn.userText].filter(Boolean).join('\n') } : {}),
        ...(linePriceEvidence.length ? { linePriceEvidence } : {}) },
      expect,
    },
  };

}

export async function materialContent(pool: Pool, accountId: string, materialId: string) {
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    const { rows: [material] } = await client.query<{ id: string; name: string; size: number; received: number }>(`
      SELECT id, name, size, received FROM dispatch.materials WHERE account_id = $1 AND id = $2
    `, [accountId, materialId]);
    if (!material) throw new HttpError(404, 'material_not_found', '未找到材料');
    if (material.received !== material.size) throw new HttpError(409, 'material_incomplete', '材料尚未上传完整');
    const { rows: chunks } = await client.query<{ content: Buffer }>(`
      SELECT content FROM dispatch.material_chunks WHERE account_id = $1 AND material_id = $2 ORDER BY byte_offset
    `, [accountId, materialId]);
    const content = Buffer.concat(chunks.map(chunk => chunk.content));
    const mime = imageMime(content);
    if (!mime) throw new HttpError(422, 'unsupported_order_image', '材料不是支持的 JPG、PNG 或 WebP 图片');
    return { content, mime, name: material.name };
  });
}

export function promptBoard() {
  return {
    prompts: [
      {
        id: 'text-order', module: 'S7d 文字录单', title: '文字录单提取', version: textPromptVersion,
        description: '把配送员的新文字整理为待人工核对的订单草稿。',
        prompts: [{ label: '系统提示词', text: textPrompt }],
      },
      {
        id: 'image-order', module: 'S7d 图片录单', title: '图片订单识别', version: imagePromptVersion,
        description: '从配送订单图片中提取新增货品明细。',
        prompts: [{ label: '系统提示词', text: imagePrompt }],
      },
      {
        id: 'a1-intent', module: 'A1 对话录单', title: '录单意图分类 Mode A / Mode B', version: intentPromptVersion,
        description: '判断本轮是录单、预览、查询还是闲聊，Mode B 同时产出候选操作与追问。',
        prompts: [
          { label: 'Mode A 意图分类', text: intentPrompt },
          { label: 'Mode B 意图分类与候选', text: combinedIntentPrompt },
        ],
      },
      {
        id: 'a1-agent', module: 'A1 对话录单', title: '录单草稿整理与工具集', version: agentPromptVersion,
        description: '按工具调用整理新报单、补值、改单并追问缺项。',
        prompts: [{ label: '系统提示词', text: agentPrompt }],
        tools: agentTools,
      },
      {
        id: 'a1-other', module: 'A1 对话录单', title: '非业务意图兜底回复', version: agentPromptVersion,
        description: '闲聊、模糊表达或越界要求的一句话回复。',
        prompts: [{ label: '系统提示词', text: otherPrompt }],
      },
      {
        id: 'a2-intent', module: 'A2 送货现场', title: '送货现场意图分类', version: deliveryPromptVersion,
        description: '判断是否要改实收、核对送达、查询状态或录下一趟。',
        prompts: [{ label: '系统提示词', text: deliveryIntentPrompt }],
      },
      {
        id: 'a2-candidate', module: 'A2 送货现场', title: '送货现场候选提案与工具集', version: deliveryPromptVersion,
        description: '把现场话语整理成候选改动、送达核对或越界提醒，不直接写入。',
        prompts: [{ label: '系统提示词', text: deliveryCandidatePrompt }],
        tools: deliveryTools,
      },
    ],
  };
}

