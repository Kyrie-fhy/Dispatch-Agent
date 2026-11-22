import { createHash, timingSafeEqual } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Pool, PoolClient } from 'pg';
import { DeliveryEdits, deliveryLines, deliverySummary } from '../miniprogram/core/delivery-execution';
import { isObject, nullablePrice, validTextPrice, yuanToCents } from '../miniprogram/core/orders';
import { hasSpokenNumber, spokenNumbers } from '../miniprogram/core/spoken-numbers';
import { latest, TripVersion } from '../miniprogram/core/trips';
import { readAccount, readParties, readWorkspace, workspaceDraft } from './account-workspace';
import { transaction } from './database';
import { HttpError } from './http-error';
import { imageMime } from './materials';
import { uuidPattern } from './request-input';
import { TripStore } from './trips';
import { imagePrompt, imagePromptVersion, textPrompt, textPromptVersion } from './text-model';
import { agentPrompt, agentPromptVersion, agentTools, otherPrompt } from './agent/model';
import { combinedIntentPrompt, intentPrompt, intentPromptVersion } from './agent/intent';
import { deliveryCandidatePrompt, deliveryIntentPrompt, deliveryPromptVersion, deliveryTools } from './agent/delivery-model';

const adminCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'";

type AccountRow = { id: string; provider: string; subject: string };
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
  blank?: boolean; invalidPrice?: string;
};
type DocumentCustomer = {
  sheetId: string; customer: string; partyId: string | null; reviewed: boolean; deliveryCompleted: boolean; locked: boolean;
  orderCents: number | null; orderPendingPrices: number; dueCents: number; pendingPrices: number; lines: DocumentLine[];
};
type EvalDraftItem = {
  id: string; product: string; brand: string; specification: string; unit: string; quantity: string; price: string | null;
};
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

export function configuredAdminToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.DISPATCH_ADMIN_TOKEN?.trim();
  if (!token) return undefined;
  if (token.length < 16) throw new Error('DISPATCH_ADMIN_TOKEN 长度须不少于 16 位');
  return token;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function maskSubject(subject: string): string {
  const value = Array.from(subject);
  if (value.length <= 8) return subject;
  return `${value.slice(0, 4).join('')}...${value.slice(-4).join('')}`;
}

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
}

function requireAdmin(request: IncomingMessage, token: string): void {
  const match = /^Bearer ([^\s]{1,512})$/.exec(request.headers.authorization ?? '');
  const supplied = match ? digest(match[1]) : Buffer.alloc(32);
  if (!match || !timingSafeEqual(digest(token), supplied)) {
    throw new HttpError(401, 'admin_auth_required', '请输入正确的排障后台口令');
  }
}

function requireId(value: string, label: string): string {
  if (!uuidPattern.test(value)) throw new HttpError(400, 'invalid_id', `请提供有效的${label}`);
  return value;
}

async function requireAccount(client: PoolClient, accountId: string): Promise<void> {
  const { rowCount } = await client.query('SELECT 1 FROM dispatch.accounts WHERE id = $1', [accountId]);
  if (!rowCount) throw new HttpError(404, 'account_not_found', '未找到配送员账号');
}

async function listAccounts(pool: Pool) {
  const accounts = await transaction(pool, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query<AccountRow>(`
      SELECT id, identity_provider AS provider, identity_subject AS subject
      FROM dispatch.accounts ORDER BY identity_provider, identity_subject, id
    `);
    return rows;
  });
  const summaries = [];
  for (const account of accounts) {
    const summary = await readAccount(pool, account.id, async client => {
      const workspace = await readWorkspace(client, account.id);
      const { rows: [counts] } = await client.query<{
        tripCount: number; partyCount: number; aliasCount: number; turnCount: number; lastTurnAt: Date | null;
      }>(`
        SELECT
          (SELECT count(*)::int FROM dispatch.trips WHERE account_id = $1) AS "tripCount",
          (SELECT count(*)::int FROM dispatch.parties WHERE account_id = $1) AS "partyCount",
          (SELECT count(*)::int FROM dispatch.customer_aliases WHERE account_id = $1) AS "aliasCount",
          (SELECT count(*)::int FROM dispatch.agent_turns WHERE account_id = $1) AS "turnCount",
          (SELECT max(created_at) FROM dispatch.agent_turns WHERE account_id = $1) AS "lastTurnAt"
      `, [account.id]);
      return {
        draftId: workspace.id, draftRevision: workspace.revision,
        draftConfirmed: workspace.id === workspace.currentTripId, currentTripId: workspace.currentTripId,
        ...counts,
      };
    });
    summaries.push({
      id: account.id, provider: account.provider, subject: maskSubject(account.subject), ...summary,
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

async function accountOverview(pool: Pool, accountId: string) {
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

async function readTurnEvents(client: PoolClient, accountId: string, turnIds: string[]) {
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

async function readScope(pool: Pool, trips: TripStore, accountId: string, scopeId: string) {
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
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

    const { rows: turns } = await client.query<StoredTurnRow>(`
      SELECT id, status, start_revision AS "startRevision", end_revision AS "endRevision", undone, created_at AS "createdAt"
      FROM dispatch.agent_turns WHERE account_id = $1 AND draft_id = $2
      ORDER BY created_at ASC, id ASC LIMIT 200
    `, [accountId, scopeId]);
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
    const timeline = turns.map(turn => {
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
        id: turn.id, status: turn.status, startRevision: turn.startRevision, endRevision: turn.endRevision,
        undone: turn.undone, createdAt: turn.createdAt.toISOString(), elapsedMs,
        userText: entry.user?.content ?? '', materialIds: entry.user?.materialIds ?? [], materials: userMaterials,
        assistantText: entry.assistant?.content ?? '',
        events: turnEvents.map(event => ({ seq: event.seq, kind: event.kind, payload: event.payload })),
      };
    });
    const stats = await scopeStats(client, accountId, scopeId);
    return { accountId, scopeId, document, turns: timeline, stats };
  });
}

async function readEvalCase(pool: Pool, accountId: string, turnId: string) {
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
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
      tripId: string; sheetId: string; partyId: string; reviewed: boolean;
      statuses: Record<string, string>; edits: DeliveryEdits; customer: TripVersion['customers'][number]; issuedAt: string;
    }>(`
      SELECT s.trip_id AS "tripId", s.id AS "sheetId", s.party_id AS "partyId", s.reviewed,
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
    const history = new Map<string, { key: string; partyKey: string; issuedAt: string; lines: {
      product: string; brand: string; specification: string; unit: string; quantity: string; price: string;
    }[] }>();
    for (const row of historyRows) {
      const key = partyKeys.get(row.partyId);
      if (!key) continue;
      const historyKey = `${row.tripId}:${row.partyId}`;
      let group = history.get(historyKey);
      if (!group) {
        group = { key: `history-${history.size + 1}`, partyKey: key, issuedAt: row.issuedAt, lines: [] };
        history.set(historyKey, group);
      }
      for (const line of deliveryLines(row.customer, row.edits)) {
        const edit = Object.prototype.hasOwnProperty.call(row.edits, line.id) ? row.edits[line.id] : undefined;
        if (row.reviewed && edit?.receivedQuantity === undefined && row.statuses[line.id] === 'pending') continue;
        if (line.unitPriceCents === null || line.unitPriceCents <= 0 || line.receivedQuantity <= 0) continue;
        group.lines.push({ product: line.product, brand: line.brand, specification: line.specification, unit: line.unit,
          quantity: String(line.receivedQuantity), price: (line.unitPriceCents / 100).toFixed(2) });
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
    };
    if (environmentNote) environment.environmentNote = environmentNote;
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
    const allowedPrices = [...new Set([
      ...spokenPrices(priceSource),
      ...introducedPrices.filter(price => hasSpokenNumber(priceSource, price)),
      ...proposalPrices.filter(price => hasSpokenNumber(priceSource, price)),
    ])];
    const expectedCustomers = endCustomers
      .filter(customer => customer.customer.trim() || customer.items.some(item => item.product.trim() || nonEmptyPrice(item.price)))
      .map(customer => ({
        customer: customer.customer,
        linkedPartyKey: customer.partyId ? partyKey(customer.partyId) : null,
        items: customer.items.filter(item => item.product.trim() || item.quantity.trim() || nonEmptyPrice(item.price))
          .map(item => ({ product: item.product, brand: item.brand, specification: item.specification,
            unit: item.unit, quantity: item.quantity, price: nonEmptyPrice(item.price) })),
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
          ...(allowedPrices.length ? { allowedPrices } : {}) },
        expect,
      },
    };
  });
}

async function materialContent(pool: Pool, accountId: string, materialId: string) {
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

function promptBoard() {
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

export async function handleAdmin(pool: Pool, adminToken: string | undefined, request: IncomingMessage,
  response: ServerResponse): Promise<boolean> {
  const path = request.url?.split('?')[0] ?? '';
  if (path !== '/admin' && !path.startsWith('/admin/')) return false;
  if (!adminToken) throw new HttpError(404, 'not_found', '未找到此接口');
  if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', '排障后台仅支持只读查询');
  if (path === '/admin') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': adminCsp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    });
    response.end(adminPage);
    return true;
  }
  if (path.startsWith('/admin/api/')) requireAdmin(request, adminToken);
  if (path === '/admin/api/accounts') {
    sendJson(response, 200, await listAccounts(pool));
    return true;
  }
  if (path === '/admin/api/prompts') {
    sendJson(response, 200, promptBoard());
    return true;
  }
  const overviewRoute = /^\/admin\/api\/accounts\/([^/]+)\/overview$/.exec(path);
  if (overviewRoute) {
    const accountId = requireId(overviewRoute[1], '账号编号');
    sendJson(response, 200, await accountOverview(pool, accountId));
    return true;
  }
  const scopeRoute = /^\/admin\/api\/accounts\/([^/]+)\/scopes\/([^/]+)$/.exec(path);
  if (scopeRoute) {
    const accountId = requireId(scopeRoute[1], '账号编号');
    const scopeId = requireId(scopeRoute[2], '草稿或正式趟编号');
    sendJson(response, 200, await readScope(pool, new TripStore(pool), accountId, scopeId));
    return true;
  }
  const evalCaseRoute = /^\/admin\/api\/accounts\/([^/]+)\/turns\/([^/]+)\/eval-case$/.exec(path);
  if (evalCaseRoute) {
    const accountId = requireId(evalCaseRoute[1], '账号编号');
    const turnId = requireId(evalCaseRoute[2], '回合编号');
    const evalCase = await readEvalCase(pool, accountId, turnId);
    sendJson(response, 200, evalCase, { 'Content-Disposition': `attachment; filename="${evalCase.id}.json"` });
    return true;
  }
  const materialRoute = /^\/admin\/api\/accounts\/([^/]+)\/materials\/([^/]+)\/content$/.exec(path);
  if (materialRoute) {
    const accountId = requireId(materialRoute[1], '账号编号');
    const materialId = requireId(materialRoute[2], '材料编号');
    const material = await materialContent(pool, accountId, materialId);
    response.writeHead(200, {
      'Content-Type': material.mime, 'Content-Length': material.content.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': adminCsp,
    });
    response.end(material.content);
    return true;
  }
  throw new HttpError(404, 'not_found', '未找到此接口');
}

const adminPage = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dispatch 排障后台</title>
<style>
  :root { --green: #12664d; --green-dark: #0b4b38; --ink: #18211d; --muted: #64736b; --line: #dfe7e2;
    --paper: #ffffff; --bg: #f3f6f4; --amber: #b45309; --amber-bg: #fef3c7; --red: #b91c1c; --red-bg: #fee2e2;
    --blue: #1d4ed8; --blue-bg: #dbeafe; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  button, select, input { font: inherit; }
  button { cursor: pointer; }
  .hidden { display: none !important; }
  .mono { font-family: var(--mono); }
  .topbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center;
    padding: 12px 20px; background: var(--green); color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.12); }
  .brand { font-size: 17px; font-weight: 700; letter-spacing: .2px; }
  .brand .tag { margin-left: 8px; padding: 1px 7px; border: 1px solid rgba(255,255,255,.55); border-radius: 999px;
    font-size: 11px; font-weight: 500; vertical-align: 2px; }
  .auth-tag { padding: 3px 9px; border-radius: 999px; background: rgba(255,255,255,.15); color: #e6f5ee;
    font-size: 11px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-left: auto; }
  .controls label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #d9eee6; }
  .controls select { max-width: 260px; padding: 5px 8px; border: 0; border-radius: 6px; background: #fff; color: var(--ink); }
  .controls button { padding: 5px 12px; border: 0; border-radius: 6px; background: #fff; color: var(--green-dark); font-weight: 600; }
  .controls button.ghost { background: transparent; border: 1px solid rgba(255,255,255,.5); color: #fff; font-weight: 500; }
  .tabs { display: flex; gap: 4px; padding: 3px; border-radius: 8px; background: rgba(0,0,0,.18); }
  .tabs button { padding: 5px 12px; border-radius: 6px; background: transparent; color: #d9eee6; font-weight: 500; }
  .tabs button.active { background: #fff; color: var(--green-dark); font-weight: 700; }
  .status { min-height: 26px; padding: 4px 20px; color: var(--muted); font-size: 12px; }
  .status.error { color: var(--red); }
  .toast-stack { position: fixed; right: 18px; bottom: 18px; z-index: 30; display: flex; flex-direction: column;
    gap: 8px; width: min(380px, calc(100vw - 36px)); pointer-events: none; }
  .toast { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid var(--line);
    border-left: 4px solid var(--blue); border-radius: 9px; background: #fff; color: var(--ink);
    box-shadow: 0 12px 30px rgba(18,102,77,.18); font-size: 12px; line-height: 1.45;
    pointer-events: auto; animation: toast-in .18s ease-out; }
  .toast.success { border-left-color: var(--green); }
  .toast.error { border-color: #fecaca; border-left-color: var(--red); background: #fff7f7; }
  .toast.info { border-left-color: var(--blue); }
  .toast-text { flex: 1; min-width: 0; word-break: break-word; overflow-wrap: anywhere; }
  .toast-close { flex: 0 0 auto; padding: 0 2px; border: 0; background: transparent; color: var(--muted);
    font-size: 16px; line-height: 1; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  main { padding: 0 20px 28px; }
  .layout { display: grid; grid-template-columns: minmax(430px, 43%) minmax(0, 1fr); gap: 16px; align-items: start; }
  .panel { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; min-width: 0; }
  .left { position: sticky; top: 78px; max-height: calc(100vh - 96px); display: flex; flex-direction: column; }
  .panel-tabs { display: flex; gap: 4px; padding: 10px 12px 0; border-bottom: 1px solid var(--line); }
  .panel-tabs button { padding: 7px 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); }
  .panel-tabs button.active { border-color: var(--green); color: var(--green); font-weight: 700; }
  .left-content { padding: 14px; overflow: auto; }
  .right { padding: 14px; }
  .summary { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 10px 12px; margin-bottom: 12px; border-radius: 8px;
    background: #f7faf8; border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .summary b { color: var(--ink); }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 12px; background: #fff; }
  .card-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
  .card-head h3 { margin: 0; font-size: 15px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge.ok { background: #dcfce7; color: #166534; }
  .badge.warn { background: var(--amber-bg); color: var(--amber); }
  .badge.bad { background: var(--red-bg); color: var(--red); }
  .badge.info { background: var(--blue-bg); color: var(--blue); }
  .badge.muted { background: #eef2f0; color: var(--muted); }
  .pending { display: inline-block; padding: 0 6px; border-radius: 4px; background: var(--amber-bg); color: var(--amber); font-weight: 700; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 7px; border-bottom: 1px solid #edf1ee; text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 600; background: #f8faf9; white-space: nowrap; }
  td.num, th.num { text-align: right; font-family: var(--mono); white-space: nowrap; }
  .line-sub { color: var(--muted); font-size: 11px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(102px, 1fr)); gap: 8px; margin-bottom: 12px; }
  .stat { padding: 9px 10px; border: 1px solid var(--line); border-radius: 9px; background: #fbfcfb; }
  .stat span { display: block; color: var(--muted); font-size: 11px; }
  .stat b { font-family: var(--mono); font-size: 17px; }
  .filter { display: flex; align-items: center; gap: 7px; margin: 0 0 12px; color: var(--muted); font-size: 12px; }
  .turn { border: 1px solid var(--line); border-left: 3px solid var(--green); border-radius: 10px; padding: 12px; margin-bottom: 14px; background: #fff; }
  .turn.bad { border-left-color: var(--red); }
  .turn.warn { border-left-color: #d97706; }
  .turn-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; color: var(--muted); font-size: 11px; margin-bottom: 8px; }
  .turn-head .spacer { flex: 1; }
  .bubble { padding: 9px 11px; border-radius: 9px; background: #f1f7f4; white-space: pre-wrap; word-break: break-word; }
  .bubble.assistant { background: #f7f8fa; border: 1px solid #e8ebee; margin-top: 8px; }
  .bubble-label { display: block; margin-bottom: 3px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .5px; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 9px; }
  .thumb { width: 132px; height: 100px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #f4f6f5;
    display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 11px; text-align: center; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
  .model-card { margin-top: 10px; padding: 9px 10px; border: 1px solid #b9d9cd; border-radius: 9px; background: #f2faf6; }
  .model-head { display: flex; flex-wrap: wrap; gap: 6px 9px; align-items: center; font-size: 11px; color: var(--muted); }
  .chip { padding: 1px 8px; border: 1px solid #8dc7b2; border-radius: 999px; background: #fff; color: var(--green);
    font: 600 11px var(--mono); }
  .model-card pre, .raw pre, .tools pre, .prompt-text { margin: 7px 0 0; padding: 9px; border-radius: 7px; background: #0f241d;
    color: #d8f3e8; font: 11px/1.55 var(--mono); white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 320px; }
  .input-summary { margin-top: 5px; color: var(--muted); font-size: 11px; }
  .tool-card { min-width: 0; margin-top: 8px; padding: 9px 10px; border: 1px solid #93c5fd;
    border-left: 3px solid var(--blue); border-radius: 9px; background: #eff6ff; overflow: hidden; }
  .tool-card.warn { border-color: #fcd34d; border-left-color: var(--amber); background: #fffbeb; }
  .tool-card.bad { border-color: #fca5a5; border-left-color: var(--red); background: #fef2f2; }
  .tool-head { display: flex; flex-wrap: wrap; gap: 6px 9px; align-items: center; font-size: 11px; color: var(--muted); }
  .tool-body { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; align-items: start; }
  .tool-body > div { min-width: 0; }
  .tool-body pre { min-width: 0; margin-top: 4px; padding: 8px 9px; max-height: 220px; border-radius: 7px;
    background: #fff; color: var(--ink); border: 1px solid #dbeafe; font: 11px/1.55 var(--mono);
    white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; overflow: auto; }
  .tool-body label { display: block; margin-top: 7px; color: var(--muted); font-size: 10px; font-weight: 700; }
  .turn-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .turn-actions button { padding: 3px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff;
    color: var(--green); font-size: 11px; }
  .event-list { margin: 10px 0 0; padding: 0; list-style: none; }
  .event-list li { padding: 5px 8px; border-left: 2px solid #cfe2d9; margin: 3px 0 3px 3px; font-size: 12px; }
  .event-list .kind { display: inline-block; min-width: 104px; color: var(--green); font: 600 11px var(--mono); }
  .muted { color: var(--muted); }
  details.raw { margin-top: 9px; }
  details.raw summary { color: var(--muted); font-size: 11px; cursor: pointer; }
  .prompt-card { border: 1px solid var(--line); border-radius: 11px; padding: 14px; margin-bottom: 14px; background: #fff; }
  .prompt-card.focus { outline: 2px solid #f59e0b; outline-offset: 2px; }
  .prompt-card .meta { color: var(--muted); font-size: 12px; margin: 3px 0 10px; }
  .prompt-block { margin: 10px 0; }
  .prompt-block label { display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; font-weight: 700; }
  .row-actions { display: flex; gap: 8px; align-items: center; }
  .row-actions button { padding: 3px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--green); font-size: 11px; }
  .notice { padding: 9px 12px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); font-size: 12px; margin-bottom: 14px; }
  .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .login-card { width: min(420px, 100%); padding: 26px; border: 1px solid var(--line); border-radius: 14px; background: #fff;
    box-shadow: 0 18px 50px rgba(18,102,77,.12); }
  .login-card h1 { margin: 0 0 6px; color: var(--green); font-size: 22px; }
  .login-card p { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
  .login-card input { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; }
  .login-card button { width: 100%; margin-top: 12px; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--green); color: #fff; font-weight: 700; }
  .error { min-height: 20px; margin-top: 10px; color: var(--red); font-size: 12px; }
  .lightbox { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
    background: rgba(10,20,16,.82); padding: 24px; cursor: zoom-out; }
  .lightbox img { max-width: 96vw; max-height: 92vh; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
  @media (max-width: 1080px) { .layout { grid-template-columns: 1fr; } .left { position: static; max-height: none; } }
</style>
</head>
<body>
<div id="login" class="login-wrap hidden">
  <form id="login-form" class="login-card">
    <h1>Dispatch 排障后台</h1>
    <p>请输入管理员口令。口令只保存在本浏览器会话中，关闭标签页即清除；所有查询均为只读。</p>
    <input id="login-token" type="password" autocomplete="current-password" placeholder="DISPATCH_ADMIN_TOKEN" required>
    <button type="submit">进入后台</button>
    <div id="login-error" class="error"></div>
  </form>
</div>
<div id="app" class="hidden">
  <header class="topbar">
    <div class="brand">Dispatch 排障后台<span class="tag">只读</span></div>
    <span class="auth-tag">口令已启用 · 当前为只读查询</span>
    <div class="controls">
      <label>配送员 <select id="account-select"></select></label>
      <label>范围 <select id="scope-select"></select></label>
      <button id="refresh" type="button">刷新最新数据</button>
      <nav class="tabs">
        <button type="button" data-view="diagnostics" class="active">单据与对话排障</button>
        <button type="button" data-view="prompts">提示词与工具看板</button>
      </nav>
      <button id="logout" type="button" class="ghost">退出口令</button>
    </div>
  </header>
  <div id="status" class="status"></div>
  <main>
    <section id="diagnostics-view">
      <div class="layout">
        <aside class="panel left">
          <div class="panel-tabs">
            <button type="button" data-left="sheets" class="active">送货单</button>
            <button type="button" data-left="picking">取货单</button>
            <button type="button" data-left="memory">熟客与叫法</button>
          </div>
          <div id="left-content" class="left-content"></div>
        </aside>
        <section class="panel right">
          <div id="stats" class="stats"></div>
          <label class="filter"><input id="anomaly-filter" type="checkbox"> 只看需关注/有追问/有改动的回合</label>
          <div id="turns"></div>
        </section>
      </div>
    </section>
    <section id="prompts-view" class="hidden">
      <div class="notice">只读展示 · 修改提示词须经代码提交与真实评测验证。以下内容来自当前服务端代码。</div>
      <div id="prompts"></div>
    </section>
  </main>
</div>
<div id="lightbox" class="lightbox hidden"><img id="lightbox-img" alt="原图"></div>
<div id="toast-stack" class="toast-stack" aria-live="polite" aria-atomic="false"></div>
<script>
(function () {
  var state = { token: '', accounts: [], accountId: '', overview: null, scope: null, view: 'diagnostics',
    left: 'sheets', onlyAnomaly: false, prompts: null, focusVersion: '', materialSources: {} };
  var el = function (id) { return document.getElementById(id); };
  var esc = function (value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  };
  var pending = '<span class="pending">待补价</span>';
  var missingPrice = function (cents, pendingCount) {
    return cents === null || cents === undefined || (cents === 0 && pendingCount > 0);
  };
  var moneyText = function (cents, pendingCount) {
    return missingPrice(cents, pendingCount) ? '待补价' : '¥' + (cents / 100).toFixed(2);
  };
  var moneyHtml = function (cents, pendingCount) {
    return missingPrice(cents, pendingCount) ? pending : esc('¥' + (cents / 100).toFixed(2));
  };
  var dash = '<span class="muted">—</span>';
  var statusLabel = { completed: '已完成', running: '处理中', failed: '失败', interrupted: '中断', done: '完成',
    pending: '待送', delivered: '已送达', unrecorded: '未记录', draft: '草稿', skipped: '跳过', needs_input: '待补充', runningStep: '处理中' };
  var setStatus = function (text, error) {
    var node = el('status');
    node.textContent = text || '';
    node.className = 'status' + (error ? ' error' : '');
  };
  var toast = function (message, type) {
    var stack = el('toast-stack');
    if (!stack || !message) return;
    var node = document.createElement('div');
    node.className = 'toast ' + (type || 'info');
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    var text = document.createElement('div');
    text.className = 'toast-text';
    text.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';
    var remove = function () { if (node.parentNode) node.parentNode.removeChild(node); };
    close.addEventListener('click', remove);
    node.appendChild(text);
    node.appendChild(close);
    stack.appendChild(node);
    while (stack.children.length > 3) stack.removeChild(stack.firstChild);
    setTimeout(remove, type === 'error' ? 6000 : 3400);
  };
  var copyText = function (text, done, fail) {
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-9999px';
      document.body.appendChild(area);
      var copied = false;
      try { area.select(); copied = document.execCommand('copy'); } catch (e) { copied = false; }
      document.body.removeChild(area);
      if (copied) done(); else fail();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  };
  var api = function (path) {
    return fetch('/admin/api' + path, { headers: { Authorization: 'Bearer ' + state.token }, cache: 'no-store' })
      .then(function (response) {
        return response.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (response.status === 401) {
            logout(true);
            throw new Error('口令不正确或已失效');
          }
          if (!response.ok) throw new Error((data && (data.message || data.error)) || ('请求失败 ' + response.status));
          return data;
        });
      });
  };
  var showLogin = function () {
    el('app').classList.add('hidden');
    el('login').classList.remove('hidden');
    el('login-token').focus();
  };
  var clearMaterialUrls = function () {
    Object.keys(state.materialSources).forEach(function (key) {
      var url = state.materialSources[key];
      if (url) URL.revokeObjectURL(url);
    });
    state.materialSources = {};
    el('lightbox').classList.add('hidden');
    el('lightbox-img').removeAttribute('src');
  };
  var logout = function (expired) {
    clearMaterialUrls();
    state.token = '';
    state.accountId = '';
    state.accounts = [];
    state.overview = null;
    state.scope = null;
    sessionStorage.removeItem('dispatchAdminToken');
    el('login-error').textContent = expired ? '口令不正确或已失效，请重新输入。' : '';
    if (expired) toast('口令不正确或已失效，请重新输入。', 'error');
    showLogin();
  };
  var boot = function () {
    state.token = sessionStorage.getItem('dispatchAdminToken') || '';
    if (!state.token) { showLogin(); return; }
    el('login').classList.add('hidden');
    el('app').classList.remove('hidden');
    loadAccounts().catch(function () { /* 顶部状态与登录页已提示错误 */ });
  };
  var loadAccounts = function () {
    setStatus('正在读取配送员账号…');
    return api('/accounts').then(function (data) {
      state.accounts = data.accounts;
      if (!state.accounts.length) { setStatus('库内还没有配送员账号。'); return; }
      if (!state.accounts.some(function (account) { return account.id === state.accountId; })) {
        state.accountId = state.accounts[0].id;
      }
      renderAccountSelect();
      return loadOverview();
    }).catch(function (error) { setStatus(error.message, true); throw error; });
  };
  var accountLabel = function (account) {
    var mode = account.draftConfirmed ? '已出单' : '草稿';
    return account.subject + ' · ' + account.provider + ' · ' + mode + ' · ' + account.tripCount + ' 趟';
  };
  var renderAccountSelect = function () {
    el('account-select').innerHTML = state.accounts.map(function (account) {
      return '<option value="' + esc(account.id) + '"' + (account.id === state.accountId ? ' selected' : '') + '>' +
        esc(accountLabel(account)) + '</option>';
    }).join('');
  };
  var loadOverview = function () {
    setStatus('正在读取账号概览…');
    return api('/accounts/' + state.accountId + '/overview').then(function (data) {
      state.overview = data;
      renderScopeSelect();
      return loadScope();
    }).catch(function (error) { setStatus(error.message, true); throw error; });
  };
  var currentScopeValue = '';
  var renderScopeSelect = function () {
    var overview = state.overview;
    var options = [];
    if (overview.draftConfirmed && overview.currentTripId) {
      options.push({ value: 'trip:' + overview.currentTripId, label: '当前趟（已出单）' });
    } else {
      options.push({ value: 'draft:' + overview.draft.id, label: '当前草稿 · 修订 ' + overview.draft.revision });
    }
    overview.trips.forEach(function (trip) {
      if (trip.id === overview.currentTripId) return;
      options.push({ value: 'trip:' + trip.id, label: '正式趟 · ' + new Date(trip.issuedAt).toLocaleString() + ' · ' + trip.customers + ' 店' });
    });
    overview.staleDrafts.forEach(function (draft) {
      options.push({ value: 'draft:' + draft.id, label: '旧草稿 · ' + draft.turnCount + ' 轮 · ' + new Date(draft.lastTurnAt).toLocaleString() });
    });
    var preferred = overview.draftConfirmed && overview.currentTripId
      ? 'trip:' + overview.currentTripId : 'draft:' + overview.draft.id;
    if (!options.some(function (option) { return option.value === currentScopeValue; })) currentScopeValue = preferred;
    el('scope-select').innerHTML = options.map(function (option) {
      return '<option value="' + esc(option.value) + '"' + (option.value === currentScopeValue ? ' selected' : '') + '>' +
        esc(option.label) + '</option>';
    }).join('');
  };
  var loadScope = function () {
    var value = el('scope-select').value || currentScopeValue;
    currentScopeValue = value;
    var parts = value.split(':');
    var kind = parts[0];
    var id = parts.slice(1).join(':');
    setStatus('正在读取排障数据…');
    return api('/accounts/' + state.accountId + '/scopes/' + id).then(function (data) {
      state.scope = data;
      setStatus('已载入 ' + (kind === 'trip' ? '正式趟' : '草稿') + ' ' + id.slice(0, 8) + '，数据为只读。');
      renderDiagnostics();
    }).catch(function (error) { setStatus(error.message, true); throw error; });
  };
  var renderDiagnostics = function () {
    renderLeft();
    renderStats();
    renderTurns();
  };
  var renderStats = function () {
    var stats = state.scope.stats;
    var cards = [
      ['回合数', stats.turns], ['模型调用', stats.modelCalls],
      ['输入 Token', stats.inputTokens], ['输出 Token', stats.outputTokens],
      ['模型中位耗时', stats.medianModelMs === null ? '—' : Math.round(stats.medianModelMs) + ' ms'],
      ['失败 / 撤销', stats.failed + ' / ' + stats.undone]
    ];
    el('stats').innerHTML = cards.map(function (card) {
      return '<div class="stat"><span>' + esc(card[0]) + '</span><b>' + esc(card[1]) + '</b></div>';
    }).join('');
  };
  var renderLeft = function () {
    if (state.left === 'picking') { renderPicking(); return; }
    if (state.left === 'memory') { renderMemory(); return; }
    renderSheets();
  };
  var scopeSummary = function () {
    var document = state.scope.document;
    var parts = [];
    if (document.stale) {
      return '<div class="summary"><span>旧草稿</span><span class="mono">' + esc(document.scopeId) +
        '</span><span>原始草稿明细已不在当前工作区，以下保留对话与 Harness 事件</span></div>';
    }
    if (document.type === 'trip') {
      parts.push('正式趟 · 第 <b>' + esc(document.version) + '</b> 版');
      parts.push('配送修订 <b>' + esc(document.statusRevision) + '</b>');
      parts.push('出单 <b>' + esc(document.issuedAt ? new Date(document.issuedAt).toLocaleString() : '—') + '</b>');
      parts.push('应收 <b>' + moneyHtml(document.dueCents, document.pendingPrices) + '</b>');
    } else {
      parts.push('当前草稿 · 修订 <b>' + esc(document.revision) + '</b>');
      parts.push(document.draftConfirmed ? '<b>已出单</b>' : '未出单');
      parts.push('预计 <b>' + (document.dueCents === 0 && document.pendingPrices === 0
        ? dash : moneyHtml(document.dueCents, document.pendingPrices)) + '</b>');
    }
    parts.push(document.pendingPrices ? '<b>' + esc(document.pendingPrices) + '</b> 处待补价' : '无待补价');
    parts.push('门店 <b>' + esc(document.customers.length) + '</b>');
    return '<div class="summary">' + parts.map(function (part) { return '<span>' + part + '</span>'; }).join('') + '</div>';
  };
  var lineStatus = function (status) {
    var cls = status === 'delivered' ? 'ok' : status === 'unrecorded' ? 'warn' : 'muted';
    return '<span class="badge ' + cls + '">' + esc(statusLabel[status] || status) + '</span>';
  };
  var renderSheets = function () {
    var document = state.scope.document;
    var html = scopeSummary();
    if (document.stale) html += '<div class="notice">这是一份已经离开当前工作区的旧草稿，只剩对话和 Harness 记录可供排查。</div>';
    else if (!document.customers.length) html += '<div class="notice">没有客户单。</div>';
    document.customers.forEach(function (customer) {
      var locked = customer.locked ? '<span class="badge ok">已锁定</span>' : '<span class="badge info">可修改</span>';
      html += '<div class="card"><div class="card-head"><h3>' + esc(customer.customer || '（未命名客户）') + '</h3><div>' + locked + '</div></div>';
      var pendingLabel = customer.pendingPrices ? ' · ' + customer.pendingPrices + ' 处待补价' : '';
      if (document.type === 'trip') {
        html += '<div class="muted" style="font-size:12px;margin-bottom:6px">原订 ' +
          moneyHtml(customer.orderCents, customer.orderPendingPrices) + ' · 预计应收 ' +
          moneyHtml(customer.dueCents, customer.pendingPrices) + pendingLabel + '</div>';
      } else {
        var blankCustomer = !customer.lines.length || customer.lines.every(function (line) { return line.blank; });
        html += '<div class="muted" style="font-size:12px;margin-bottom:6px">预计合计 ' +
          (blankCustomer ? dash : moneyHtml(customer.dueCents, customer.pendingPrices)) + pendingLabel + '</div>';
      }
      html += '<table><thead><tr><th>货品</th><th class="num">原订</th><th class="num">实收</th><th class="num">单价</th><th class="num">小计</th><th>状态</th></tr></thead><tbody>';
      customer.lines.forEach(function (line) {
        var name = [line.brand, line.product, line.specification].filter(Boolean).join(' / ') || '（空行）';
        var original = line.blank ? dash : esc(line.originalQuantity || '—') + ' ' + esc(line.unit || '');
        var received = line.receivedQuantity === null ? dash : esc(line.receivedQuantity) + ' ' + esc(line.unit || '');
        var unit = line.blank ? dash : line.invalidPrice !== undefined
          ? '<span class="badge bad">异常: ' + esc(line.invalidPrice) + '</span>'
          : moneyHtml(line.unitPriceCents, 0);
        var amount = line.blank ? dash : moneyHtml(line.amountCents, 0);
        html += '<tr><td>' + esc(name) + '<div class="line-sub mono">' + esc(line.id) + '</div></td>' +
          '<td class="num">' + original + '</td>' +
          '<td class="num">' + received + '</td>' +
          '<td class="num">' + unit + '</td>' +
          '<td class="num">' + amount + '</td>' +
          '<td>' + lineStatus(line.status) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    });
    el('left-content').innerHTML = html;
  };
  var renderPicking = function () {
    var document = state.scope.document;
    var rows = document.picking || [];
    if (document.type === 'draft') {
      var grouped = {};
      document.customers.forEach(function (customer) {
        customer.lines.forEach(function (line) {
          if (!line.product) return;
          var key = [line.brand, line.product, line.specification, line.unit].join('\\u0000');
          if (!grouped[key]) grouped[key] = { brand: line.brand, product: line.product, specification: line.specification,
            unit: line.unit, quantity: 0 };
          grouped[key].quantity += Number(line.originalQuantity) || 0;
        });
      });
      rows = Object.keys(grouped).map(function (key) { return grouped[key]; });
    }
    var html = scopeSummary();
    if (!rows.length) html += '<div class="notice">' +
      (document.stale ? '旧草稿的取货明细已不在当前工作区。' : '这趟还没有可汇总的取货货品。') + '</div>';
    else {
      html += '<table><thead><tr><th>货品</th><th class="num">取货数量</th></tr></thead><tbody>';
      rows.forEach(function (row) {
        html += '<tr><td>' + esc([row.brand, row.product, row.specification].filter(Boolean).join(' / ') || '（空行）') +
          '</td><td class="num">' + esc(row.quantity) + ' ' + esc(row.unit || '') + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    el('left-content').innerHTML = html;
  };
  var renderMemory = function () {
    var overview = state.overview;
    var aliasByCustomer = {};
    overview.aliases.forEach(function (alias) {
      (aliasByCustomer[alias.customerId] = aliasByCustomer[alias.customerId] || []).push(alias);
    });
    var html = '<div class="card"><div class="card-head"><h3>熟客档案</h3><span class="muted">' +
      esc(overview.parties.length) + ' 位 · ' + esc(overview.aliases.length) + ' 条叫法</span></div>';
    if (!overview.parties.length) html += '<div class="notice">还没有熟客。</div>';
    else {
      html += '<table><thead><tr><th>正式店名</th><th>已记叫法</th></tr></thead><tbody>';
      overview.parties.forEach(function (party) {
        var aliases = aliasByCustomer[party.id] || [];
        html += '<tr><td>' + esc(party.name) + '<div class="line-sub mono">' + esc(party.id) + '</div></td><td>' +
          (aliases.length ? aliases.map(function (alias) { return '<span class="badge info">' + esc(alias.alias) + '</span>'; }).join(' ') :
            '<span class="muted">—</span>') + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    html += '</div>';
    el('left-content').innerHTML = html;
  };
  var summarizeEvent = function (event) {
    var payload = event.payload || {};
    if (event.kind === 'plan') return (payload.steps || []).map(function (step) { return step.text; }).join(' → ');
    if (event.kind === 'step') return (payload.id || '') + ' · ' + (statusLabel[payload.state] || payload.state || '') +
      (payload.result ? ' · ' + payload.result : '');
    if (event.kind === 'questions') return (payload.questions || []).map(function (question) {
      return (question.customer ? question.customer + '：' : '') + question.text;
    }).join('；');
    if (event.kind === 'change') return (payload.lines || []).join('；');
    if (event.kind === 'customer_links') return (payload.links || []).map(function (link) {
      return link.spoken + ' → ' + link.canonicalName + (link.merged ? '（合并）' : '');
    }).join('；');
    if (event.kind === 'edit_confirmation') return '确认操作：' + (payload.operations || []).length + ' 项，接受词「' + payload.accept + '」';
    if (event.kind === 'delivery_proposal') return (payload.customer || '') + ' · 行 ' + (payload.edits || []).length +
      ' · ' + (payload.canComplete ? '可确认送达' : '需核对') + (payload.pendingPriceNames && payload.pendingPriceNames.length ?
        ' · 待补价：' + payload.pendingPriceNames.join('、') : '');
    if (event.kind === 'delivery_applied') return '核对卡状态：' + (payload.status || '');
    if (event.kind === 'preview') return '预览 ' + ((payload.preview && payload.preview.previewId) || '') + ' · 应收 ' +
      moneyText(payload.preview && payload.preview.totalCents, payload.preview && payload.preview.pendingPrices);
    if (event.kind === 'undo') return '撤销到修订 ' + payload.revision;
    if (event.kind === 'end') return '结束：' + (statusLabel[payload.status] || payload.status) + ' · 修订 ' + payload.revision +
      (payload.elapsedMs !== undefined ? ' · ' + payload.elapsedMs + ' ms' : '') + (payload.errorCode ? ' · ' + payload.errorCode : '');
    if (event.kind === 'submitted') return '提交：' + (payload.textLength || 0) + ' 字 · ' + (payload.images || 0) + ' 图';
    if (event.kind === 'image_applied') return '图片已应用 ' + String(payload.digest || '').slice(0, 12);
    if (event.kind === 'tool') return '工具 ' + (payload.name || '');
    return JSON.stringify(payload);
  };
  var prettyJson = function (value) {
    var text = value === undefined || value === null ? '' : String(value);
    try { text = JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value, null, 2); } catch (e) { text = String(value); }
    return text;
  };
  var intentOf = function (turn) {
    var found = null;
    turn.events.forEach(function (event) {
      if (event.kind === 'model' && event.payload && event.payload.phase === 'intent' && event.payload.intents) found = event.payload.intents;
    });
    return found;
  };
  var turnSignals = function (turn) {
    var signals = [];
    var bad = turn.status === 'failed' || turn.status === 'interrupted';
    if (bad) signals.push({ label: turn.status === 'failed' ? '执行失败' : '执行中断', cls: 'bad' });
    if (turn.undone) signals.push({ label: '已撤销', cls: 'warn' });
    var asked = turn.events.some(function (event) {
      return event.kind === 'questions' || event.kind === 'edit_confirmation';
    });
    if (asked) signals.push({ label: '护栏追问/确认', cls: 'warn' });
    var changed = turn.startRevision !== turn.endRevision;
    if (changed) signals.push({ label: '有改动', cls: 'info' });
    if (turn.events.some(function (event) { return event.kind === 'delivery_proposal'; })) {
      signals.push({ label: '现场提案', cls: 'info' });
    }
    var intent = intentOf(turn);
    if (intent && intent.draft && !changed && !asked) signals.push({ label: '口语未产生改动', cls: 'warn' });
    if (turn.elapsedMs !== null && turn.elapsedMs !== undefined && turn.elapsedMs > 3000) {
      signals.push({ label: '慢响应 (>3s)', cls: 'warn' });
    }
    return signals;
  };
  var modelCardHtml = function (payload) {
    var toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
    var summary = payload.inputSummary;
    var parts = [];
    if (summary) {
      if (summary.customerCount !== undefined) parts.push('草稿 ' + summary.customerCount + ' 店 ' + (summary.itemCount || 0) + ' 行');
      if (summary.pendingPrices !== undefined) parts.push(summary.pendingPrices + ' 处待补价');
      if (Array.isArray(summary.spokenNumbers) && summary.spokenNumbers.length) parts.push('口语数字 ' + summary.spokenNumbers.length);
      if (summary.hasPreviousQuestions) parts.push('有前轮追问');
      if (summary.hasLastSummary) parts.push('有上轮摘要');
      if (summary.shopCount !== undefined) parts.push('门店 ' + summary.shopCount);
      if (summary.lineCount !== undefined) parts.push('明细 ' + summary.lineCount);
      if (summary.questionCount !== undefined) parts.push('前轮问题 ' + summary.questionCount);
    }
    var html = '<div class="model-card"><div class="model-head">' +
      '<button type="button" class="chip" data-prompt-version="' + esc(payload.promptVersion || '') + '">' +
      esc(payload.promptVersion || '未标版本') + '</button>' +
      '<span>' + esc(payload.model || '') + '</span><span>' + esc(payload.outcome || '') + '</span>' +
      (payload.phase ? '<span>阶段 ' + esc(payload.phase) + '</span>' : '') +
      '<span>' + esc(payload.elapsedMs === undefined ? '—' : payload.elapsedMs + ' ms') + '</span>' +
      '<span>Token ' + esc(payload.inputTokens === undefined ? '—' : payload.inputTokens) + ' / ' +
      esc(payload.outputTokens === undefined ? '—' : payload.outputTokens) + '</span></div>';
    if (parts.length) html += '<div class="input-summary">输入摘要：' + esc(parts.join(' · ')) + '</div>';
    toolCalls.forEach(function (call) {
      html += '<div class="row-actions" style="margin-top:7px"><span class="badge info">模型提案 · ' + esc(call.name) + '</span></div>' +
        '<pre>' + esc(prettyJson(call.arguments)) + '</pre>';
    });
    return html + '</div>';
  };
  var toolCardHtml = function (payload) {
    var result = payload.result || {};
    var outcome = result.outcome || 'recorded';
    var cls = outcome === 'error' || outcome === 'issues' ? 'bad'
      : outcome === 'question' || outcome === 'questions' || outcome === 'confirmation' || outcome === 'blocked_or_noop' ? 'warn' : '';
    var badge = cls === 'bad' ? 'bad' : cls === 'warn' ? 'warn' : 'info';
    return '<div class="tool-card ' + cls + '"><div class="tool-head">' +
      '<span class="badge ' + badge + '">工具/护栏 · ' + esc(payload.name || '') + '</span>' +
      '<span class="badge muted mono">' + esc(payload.promptVersion || '') + '</span>' +
      '<span>裁决 ' + esc(outcome) + '</span></div>' +
      '<div class="tool-body"><div><label>入参摘要</label><pre>' + esc(prettyJson(payload.arguments)) + '</pre></div>' +
      '<div><label>服务端结果</label><pre>' + esc(prettyJson(result)) + '</pre></div></div></div>';
  };
  var renderTurns = function () {
    var turns = state.scope.turns;
    if (state.onlyAnomaly) {
      turns = turns.filter(function (turn) { return turnSignals(turn).length > 0; });
    }
    if (!turns.length) {
      el('turns').innerHTML = '<div class="notice">' + (state.onlyAnomaly ? '没有符合筛选条件的回合。' : '这个范围还没有对话回合。') + '</div>';
      return;
    }
    var html = '';
    turns.forEach(function (turn) {
      var signals = turnSignals(turn);
      var bad = signals.some(function (signal) { return signal.cls === 'bad'; });
      var warn = signals.some(function (signal) { return signal.cls === 'warn'; });
      var others = [];
      html += '<article class="turn ' + (bad ? 'bad' : warn ? 'warn' : '') + '">';
      html += '<div class="turn-head"><span class="mono">' + esc(turn.createdAt ? new Date(turn.createdAt).toLocaleString() : '') + '</span>' +
        '<span class="badge ' + (turn.status === 'completed' ? 'ok' : bad ? 'bad' : 'warn') + '">' +
        esc(statusLabel[turn.status] || turn.status) + '</span>' +
        signals.map(function (signal) {
          return '<span class="badge ' + signal.cls + '">' + esc(signal.label) + '</span>';
        }).join('') +
        '<span>修订 ' + esc(turn.startRevision) + ' → ' + esc(turn.endRevision) + '</span>' +
        (turn.elapsedMs !== null ? '<span>总耗时 ' + esc(turn.elapsedMs) + ' ms</span>' : '') +
        '<span class="spacer"></span>' +
        '<span class="turn-actions"><button type="button" data-eval-export="' + esc(turn.id) + '">导出评测 Case</button>' +
        '<button type="button" data-eval-copy="' + esc(turn.id) + '">复制 Case</button></span>' +
        '<span class="mono muted">' + esc(turn.id) + '</span></div>';
      html += '<div class="bubble"><span class="bubble-label">配送员原话</span>' + esc(turn.userText || '（无文字）') + '</div>';
      if (turn.materials.length) {
        html += '<div class="thumbs">';
        turn.materials.forEach(function (material) {
          html += '<div class="thumb" data-thumb="' + esc(material.id) + '">加载图片…<div class="line-sub">' + esc(material.name) +
            (material.organized ? ' · 已识别' : '') + '</div></div>';
        });
        html += '</div>';
      }
      html += '<div class="bubble assistant"><span class="bubble-label">助手回复</span>' + esc(turn.assistantText || '（暂无回复）') + '</div>';
      turn.events.forEach(function (event) {
        if (event.kind === 'model') { html += modelCardHtml(event.payload || {}); return; }
        if (event.kind === 'tool') { html += toolCardHtml(event.payload || {}); return; }
        others.push(event);
      });
      if (others.length) {
        html += '<ul class="event-list">';
        others.forEach(function (event) {
          html += '<li><span class="kind">' + esc(event.kind) + '</span>' + esc(summarizeEvent(event)) + '</li>';
        });
        html += '</ul>';
      }
      html += '<details class="raw"><summary>展开原始事件 JSON（' + esc(turn.events.length) + ' 条）</summary><pre>' +
        esc(JSON.stringify(turn.events, null, 2)) + '</pre></details>';
      html += '</article>';
    });
    el('turns').innerHTML = html;
    loadThumbs();
  };
  var loadThumbs = function () {
    var nodes = document.querySelectorAll('[data-thumb]');
    var accountId = state.accountId;
    Array.prototype.forEach.call(nodes, function (node) {
      var id = node.getAttribute('data-thumb');
      var key = accountId + ':' + id;
      if (state.materialSources[key]) {
        injectThumb(node, state.materialSources[key]);
        return;
      }
      fetch('/admin/api/accounts/' + accountId + '/materials/' + id + '/content', {
        headers: { Authorization: 'Bearer ' + state.token }, cache: 'no-store'
      }).then(function (response) {
        if (!response.ok) throw new Error('图片 ' + response.status);
        return response.blob();
      }).then(function (blob) {
        var url = URL.createObjectURL(blob);
        if (!state.token || accountId !== state.accountId) {
          URL.revokeObjectURL(url);
          return;
        }
        state.materialSources[key] = url;
        injectThumb(node, url);
      }).catch(function (error) {
        node.textContent = '图片加载失败：' + error.message;
      });
    });
  };
  var injectThumb = function (node, url) {
    node.innerHTML = '';
    var image = document.createElement('img');
    image.src = url;
    image.alt = '上传原图';
    image.addEventListener('click', function () { openLightbox(url); });
    node.appendChild(image);
  };
  var openLightbox = function (url) {
    el('lightbox-img').src = url;
    el('lightbox').classList.remove('hidden');
    setStatus('已放大原图，点击黑色遮罩关闭。');
  };
  var setView = function (view, quiet) {
    state.view = view;
    el('diagnostics-view').classList.toggle('hidden', view !== 'diagnostics');
    el('prompts-view').classList.toggle('hidden', view !== 'prompts');
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (button) {
      button.classList.toggle('active', button.getAttribute('data-view') === view);
    });
    if (view === 'prompts') loadPrompts().catch(function () { /* 顶部状态已提示 */ });
    if (!quiet) {
      var label = view === 'prompts' ? '提示词与工具看板' : '单据与对话排障';
      setStatus('已切换到「' + label + '」。');
      toast('已切换到「' + label + '」。', 'info');
    }
  };
  var loadPrompts = function () {
    if (state.prompts) { renderPrompts(); return Promise.resolve(); }
    setStatus('正在读取提示词与工具模板…');
    return api('/prompts').then(function (data) {
      state.prompts = data.prompts;
      setStatus('提示词与工具模板为当前服务端只读快照。');
      renderPrompts();
    }).catch(function (error) {
      setStatus(error.message, true);
      throw error;
    });
  };
  var renderPrompts = function () {
    var html = '';
    state.prompts.forEach(function (entry, index) {
      var focused = state.focusVersion && entry.version === state.focusVersion;
      html += '<article class="prompt-card' + (focused ? ' focus' : '') + '" data-prompt-card="' + index + '">';
      html += '<div class="card-head"><h3>' + esc(entry.title) + '</h3><div class="row-actions">' +
        '<span class="badge muted">' + esc(entry.module) + '</span>' +
        '<span class="badge info mono">' + esc(entry.version) + '</span>' +
        '<button type="button" data-copy-prompt="' + index + '">复制全文</button></div></div>';
      html += '<div class="meta">' + esc(entry.description) + '</div>';
      entry.prompts.forEach(function (prompt) {
        html += '<div class="prompt-block"><label>' + esc(prompt.label) + '</label><pre class="prompt-text">' +
          esc(prompt.text) + '</pre></div>';
      });
      if (entry.tools) {
        html += '<details class="tools"><summary>展开工具 JSON Schema</summary><pre>' +
          esc(JSON.stringify(entry.tools, null, 2)) + '</pre></details>';
      }
      html += '</article>';
    });
    el('prompts').innerHTML = html;
    if (state.focusVersion) {
      var card = document.querySelector('.prompt-card.focus');
      if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };
  var copyPrompt = function (index) {
    var entry = state.prompts[index];
    if (!entry) return;
    var text = entry.prompts.map(function (prompt) { return '【' + prompt.label + '】\\n' + prompt.text; }).join('\\n\\n');
    copyText(text, function () {
      setStatus('已复制「' + entry.title + '」全文。');
      toast('已复制「' + entry.title + '」全文。', 'success');
    }, function () {
      setStatus('复制失败，请手动选择文本。', true);
      toast('复制失败：未能写入剪贴板，请手动选择文本。', 'error');
    });
  };
  var copyEvalCase = function (turnId) {
    if (!state.accountId) {
      toast('请先选择配送员账号。', 'error');
      return;
    }
    setStatus('正在读取评测 Case…');
    api('/accounts/' + state.accountId + '/turns/' + turnId + '/eval-case').then(function (data) {
      var text = JSON.stringify(data, null, 2);
      copyText(text, function () {
        setStatus('已复制 ' + data.id + ' 的评测 Case JSON。');
        toast('已复制 ' + data.id + ' 评测 Case。', 'success');
      }, function () {
        setStatus('复制失败，请改用导出按钮。', true);
        toast('复制失败：未能写入剪贴板，请改用「导出评测 Case」。', 'error');
      });
    }).catch(function (error) {
      setStatus(error.message, true);
      toast('复制失败：' + error.message, 'error');
    });
  };
  var exportEvalCase = function (turnId) {
    if (!state.accountId) {
      toast('请先选择配送员账号。', 'error');
      return;
    }
    setStatus('正在导出评测 Case…');
    api('/accounts/' + state.accountId + '/turns/' + turnId + '/eval-case').then(function (data) {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = data.id + '.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      setStatus('已导出 ' + data.id + '.json；含脱敏环境、Trace 与双层 Grader 模板。');
      toast('已导出 ' + data.id + '.json。', 'success');
    }).catch(function (error) {
      setStatus(error.message, true);
      toast('导出失败：' + error.message, 'error');
    });
  };
  el('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var value = el('login-token').value.trim();
    if (!value) {
      el('login-error').textContent = '请输入排障后台口令。';
      toast('请输入排障后台口令。', 'error');
      return;
    }
    state.token = value;
    sessionStorage.setItem('dispatchAdminToken', value);
    el('login-error').textContent = '';
    loadAccounts().then(function () {
      el('login').classList.add('hidden');
      el('app').classList.remove('hidden');
      toast('已进入排障后台。', 'success');
    }).catch(function (error) {
      state.token = '';
      sessionStorage.removeItem('dispatchAdminToken');
      el('login-error').textContent = error.message;
      toast('登录失败：' + error.message, 'error');
      showLogin();
    });
  });
  el('logout').addEventListener('click', function () {
    logout(false);
    toast('已退出口令。', 'info');
  });
  el('refresh').addEventListener('click', function () {
    if (state.view === 'prompts') {
      state.prompts = null;
      loadPrompts().then(function () {
        toast('已刷新提示词与工具模板。', 'success');
      }, function (error) {
        toast('刷新失败：' + error.message, 'error');
      });
    } else if (state.accountId) {
      loadAccounts().then(function () {
        toast('已刷新最新排障数据。', 'success');
      }, function (error) {
        toast('刷新失败：' + error.message, 'error');
      });
    } else {
      toast('当前没有可刷新的配送员账号。', 'info');
    }
  });
  el('account-select').addEventListener('change', function (event) {
    clearMaterialUrls();
    state.accountId = event.target.value;
    currentScopeValue = '';
    loadOverview().then(function () {
      var account = state.accounts.filter(function (item) { return item.id === state.accountId; })[0];
      toast('已切换到配送员 ' + (account ? account.subject : state.accountId.slice(0, 8)) + '。', 'success');
    }, function (error) {
      toast('切换账号失败：' + error.message, 'error');
    });
  });
  el('scope-select').addEventListener('change', function () {
    loadScope().then(function () {
      var select = el('scope-select');
      var label = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : '所选范围';
      toast('已载入「' + label + '」。', 'success');
    }, function (error) {
      toast('载入范围失败：' + error.message, 'error');
    });
  });
  el('anomaly-filter').addEventListener('change', function (event) {
    state.onlyAnomaly = event.target.checked;
    if (state.scope) renderTurns();
    var count = document.querySelectorAll('#turns article.turn').length;
    var message = state.onlyAnomaly ? '已筛选出 ' + count + ' 轮需关注回合。' : '已显示全部 ' + count + ' 轮回合。';
    setStatus(message);
    toast(message, 'info');
  });
  document.addEventListener('click', function (event) {
    var view = event.target.closest('[data-view]');
    if (view) { setView(view.getAttribute('data-view')); return; }
    var left = event.target.closest('[data-left]');
    if (left) {
      state.left = left.getAttribute('data-left');
      Array.prototype.forEach.call(document.querySelectorAll('[data-left]'), function (button) {
        button.classList.toggle('active', button.getAttribute('data-left') === state.left);
      });
      renderLeft();
      var leftLabel = { sheets: '送货单', picking: '取货单', memory: '熟客与叫法' }[state.left] || state.left;
      setStatus('已切换到「' + leftLabel + '」视图。');
      toast('已切换到「' + leftLabel + '」。', 'info');
      return;
    }
    var version = event.target.closest('[data-prompt-version]');
    if (version) {
      var versionLabel = version.getAttribute('data-prompt-version');
      state.focusVersion = versionLabel;
      setView('prompts', true);
      toast('已定位到版本 ' + (versionLabel || '未标版本') + ' 的提示词卡片。', 'success');
      return;
    }
    var copy = event.target.closest('[data-copy-prompt]');
    if (copy) { copyPrompt(Number(copy.getAttribute('data-copy-prompt'))); return; }
    var exportCase = event.target.closest('[data-eval-export]');
    if (exportCase) { exportEvalCase(exportCase.getAttribute('data-eval-export')); return; }
    var copyCase = event.target.closest('[data-eval-copy]');
    if (copyCase) { copyEvalCase(copyCase.getAttribute('data-eval-copy')); return; }
    if (event.target === el('lightbox')) {
      el('lightbox').classList.add('hidden');
      setStatus('已关闭原图。');
    }
  });
  boot();
})();
</script>
</body>
</html>`;
