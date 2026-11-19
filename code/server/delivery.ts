import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Pool, PoolClient } from 'pg';
import { DeliveryEdits, DeliveryLine, deliveryLines, deliverySummary } from '../miniprogram/core/delivery-execution';
import { isObject, unitPrice } from '../miniprogram/core/orders';
import { Account, deliveredBalance } from '../miniprogram/core/settlement';
import { CustomerOrder, Trip } from '../miniprogram/core/trips';
import { readAccount, writeAccount } from './account-workspace';
import { HttpError } from './http-error';
import { readConfirmInput, readDeliveryEdit, readDeliveryInput, readId, readReviewInput, validRevision } from './request-input';
import { finishDeliveryCard, pendingDeliveryCard } from './agent/store';

export function readDeliveryApply(value: unknown) {
  const basis = readReviewInput(value);
  if (!isObject(value) || typeof value.complete !== 'boolean' || !Array.isArray(value.edits) || value.edits.length > 200 ||
      (!value.edits.length && !value.complete)) throw new HttpError(400, 'invalid_delivery_apply', '请提供有效的送货变更');
  const seen = new Set<string>();
  const edits = value.edits.map(line => {
    if (!isObject(line) || typeof line.lineId !== 'string' || seen.has(line.lineId) ||
        typeof line.receivedQuantity !== 'number' || !Number.isSafeInteger(line.receivedQuantity) || line.receivedQuantity < 0 ||
        (line.price !== null && (typeof line.price !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(line.price) || line.price.length > 40))) {
      throw new HttpError(400, 'invalid_delivery_apply', '明细重复，或实收数量、单价无效');
    }
    seen.add(line.lineId);
    try {
      return { lineId: line.lineId, receivedQuantity: line.receivedQuantity, unitPriceCents: unitPrice(line.price) };
    } catch (error) {
      throw new HttpError(400, 'invalid_delivery_price', (error as Error).message);
    }
  });
  const turnId = value.turnId === undefined ? undefined : readId(value.turnId, '核对卡回合编号');
  return { ...basis, edits, complete: value.complete, turnId };
}

type ReviewBasis = Omit<ReturnType<typeof readReviewInput>, 'requestId'>;
type DeliveryChange = Omit<ReturnType<typeof readDeliveryInput>, 'requestId'>;
type SheetRow = Account & ReviewBasis & { statuses: Trip['statuses']; customers: CustomerOrder[]; paid: string; edits: DeliveryEdits; deliveryCompleted: boolean };
type SheetState = Omit<SheetRow, 'paid'> & { customer: CustomerOrder; paid: number };

interface DeliveryPreview {
  previewId: string;
  change: DeliveryChange;
  before: ReturnType<typeof deliveredBalance>;
  after: ReturnType<typeof deliveredBalance>;
}

function amounts(state: SheetState, statuses = state.statuses) {
  return deliveredBalance({ ...state.customer, items: deliveryLines(state.customer, state.edits) }, statuses, state.paid);
}

function sheetDetails(state: SheetState) {
  const { tripId, sheetId, partyId, reviewed, version, statusRevision, statuses, customer } = state;
  const lines = deliveryLines(customer, state.edits);
  return {
    deliveryCompleted: state.deliveryCompleted, execution: deliverySummary(lines),
    tripId, sheetId, partyId, reviewed, version, statusRevision,
    customer: customer.customer, orderCents: customer.totalCents, amounts: amounts(state),
    lines: lines.map(item => ({ ...item, status: statuses[item.id] })),
  };
}

function checkBasis(state: SheetState, basis: ReviewBasis) {
  if (state.version !== basis.version || state.statusRevision !== basis.statusRevision) {
    throw new HttpError(409, 'delivery_changed', '正式单或配送状态已变化，请重新打开单据核对');
  }
}

function checkEditable(state: SheetState) {
  if (state.deliveryCompleted) throw new HttpError(409, 'delivery_completed', '本客户已确认送达，应收已锁定');
}

function requirePrices(lines: DeliveryLine[]) {
  const pending = lines.filter(line => line.amountCents === null);
  if (pending.length) {
    const names = pending.map(line => [line.brand, line.product, line.specification, line.unit].filter(Boolean).join(' / '));
    throw new HttpError(409, 'delivery_price_required', `请先补填单价：${names.join('、')}`);
  }
}

function nextRevision(state: SheetState) {
  if (!validRevision(state.statusRevision, true)) {
    throw new HttpError(409, 'delivery_revision_limit', '配送记录已达到修订上限');
  }
  return state.statusRevision + 1;
}

function planDelivery(state: SheetState, change: DeliveryChange) {
  checkBasis(state, change);
  checkEditable(state);
  const allLines = deliveryLines(state.customer, state.edits);
  const lines = change.lineId === null ? allLines : allLines.filter(item => item.id === change.lineId);
  if (!lines.length) throw new HttpError(404, 'line_not_found', '未找到本客户的货品明细');
  const changed = lines.some(item => state.statuses[item.id] !== change.status);
  if (change.status === 'delivered') requirePrices(lines);
  if (changed) nextRevision(state);
  return {
    changed,
    statuses: { ...state.statuses, ...Object.fromEntries(lines.map(item => [item.id, change.status])) },
  };
}

export async function readFormalSheet(client: PoolClient, accountId: string, tripId: string, sheetId: string): Promise<SheetState> {
  const { rows: [row] } = await client.query<SheetRow>(`
    SELECT s.trip_id AS "tripId", s.id AS "sheetId", s.party_id AS "partyId", s.reviewed, s.delivery_completed AS "deliveryCompleted",
           t.statuses, t.delivery_edits AS edits, t.status_revision AS "statusRevision", v.version, v.customers,
           COALESCE((SELECT sum(cents) FROM dispatch.receipt_allocations
             WHERE account_id = s.account_id AND trip_id = s.trip_id AND sheet_id = s.id), 0)::text AS paid
    FROM dispatch.sheets s
    JOIN dispatch.trips t ON t.account_id = s.account_id AND t.id = s.trip_id
    JOIN LATERAL (
      SELECT version, customers FROM dispatch.trip_versions
      WHERE account_id = s.account_id AND trip_id = s.trip_id ORDER BY version DESC LIMIT 1
    ) v ON true
    WHERE s.account_id = $1 AND s.trip_id = $2 AND s.id = $3
  `, [accountId, tripId, sheetId]);
  if (!row) throw new HttpError(404, 'sheet_not_found', '未找到客户单');
  const customer = row.customers.find(entry => entry.id === sheetId);
  if (!customer) throw new Error('正式版本缺少客户明细');
  return { ...row, customer, paid: Number(row.paid) };
}


export class DeliveryStore {
  constructor(private readonly pool: Pool) {}

  apply(accountId: string, tripId: string, sheetId: string, { requestId, edits: changes, complete, turnId, ...basis }: ReturnType<typeof readDeliveryApply>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'delivery-apply', tripId, sheetId, changes, complete, turnId, basis }, async (client, workspace) => {
      if (workspace.id !== tripId || workspace.currentTripId !== tripId) {
        throw new HttpError(409, 'delivery_changed', '本趟已切换，请打开最新送货单。');
      }
      const state = await readFormalSheet(client, accountId, tripId, sheetId);
      checkBasis(state, basis);
      checkEditable(state);
      if (state.reviewed) throw new HttpError(409, 'delivery_completed', '本客户已核对，应收已锁定');
      const key = turnId && { account: accountId, draftId: tripId, id: turnId };
      if (key) {
        const card = await pendingDeliveryCard(client, key, sheetId);
        const expected = card.edits.map(({ lineId, receivedQuantity, price }) => ({ lineId, receivedQuantity, unitPriceCents: unitPrice(price) }));
        if (card.version !== basis.version || card.statusRevision !== basis.statusRevision || !isDeepStrictEqual(changes, expected)) {
          throw new HttpError(409, 'delivery_changed', '提交内容与核对卡不一致，请重新核对。');
        }
      }
      const edits = { ...state.edits };
      const statuses = { ...state.statuses };
      const original = deliveryLines(state.customer, state.edits);
      let changed = false;
      for (const { lineId, ...edit } of changes) {
        const line = original.find(item => item.id === lineId);
        if (!line) throw new HttpError(404, 'line_not_found', '未找到本客户的货品明细');
        if (line.receivedQuantity === edit.receivedQuantity && line.unitPriceCents === edit.unitPriceCents) continue;
        changed = true;
        edits[lineId] = edit;
        if (edit.receivedQuantity === 0 || edit.unitPriceCents === null) statuses[lineId] = 'pending';
      }
      let lines: DeliveryLine[];
      try {
        lines = deliveryLines(state.customer, edits);
        deliverySummary(lines);
      } catch (error) {
        throw new HttpError(400, 'invalid_delivery_amount', (error as Error).message);
      }
      if (complete) {
        requirePrices(lines);
        for (const line of lines) statuses[line.id] = line.receivedQuantity > 0 ? 'delivered' : 'pending';
        await client.query('UPDATE dispatch.sheets SET reviewed = true, delivery_completed = true WHERE account_id = $1 AND trip_id = $2 AND id = $3',
          [accountId, tripId, sheetId]);
      }
      const statusRevision = changed || complete ? nextRevision(state) : state.statusRevision;
      if (changed || complete) await client.query(`UPDATE dispatch.trips SET delivery_edits = $3, statuses = $4, status_revision = $5
        WHERE account_id = $1 AND id = $2`, [accountId, tripId, JSON.stringify(edits), JSON.stringify(statuses), statusRevision]);
      if (key) await finishDeliveryCard(client, key, complete ? 'completed' : 'saved');
      return sheetDetails({ ...state, edits, statuses, statusRevision, reviewed: complete, deliveryCompleted: complete });
    });
  }

  sheet(accountId: string, tripId: string, sheetId: string) {
    return readAccount(this.pool, accountId, async client => sheetDetails(await readFormalSheet(client, accountId, tripId, sheetId)));
  }

  editLine(accountId: string, tripId: string, sheetId: string, { requestId, lineId, edit, ...basis }: ReturnType<typeof readDeliveryEdit>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'edit-delivery-line', tripId, sheetId, lineId, edit, basis }, async client => {
      const state = await readFormalSheet(client, accountId, tripId, sheetId);
      checkBasis(state, basis);
      checkEditable(state);
      if (state.reviewed) throw new HttpError(409, 'delivery_reviewed', '本客户已核对，请从对账工作区处理更正');
      if (!state.customer.items.some(item => item.id === lineId)) {
        throw new HttpError(404, 'line_not_found', '未找到本客户的货品明细');
      }
      const edits = { ...state.edits, [lineId]: edit };
      const statuses = { ...state.statuses };
      if (edit.receivedQuantity === 0 || edit.unitPriceCents === null) statuses[lineId] = 'pending';
      try {
        deliverySummary(deliveryLines(state.customer, edits));
      } catch (error) {
        throw new HttpError(400, 'invalid_delivery_amount', (error as Error).message);
      }
      const statusRevision = nextRevision(state);
      await client.query(`
        UPDATE dispatch.trips SET delivery_edits = $3, statuses = $4, status_revision = $5 WHERE account_id = $1 AND id = $2
      `, [accountId, tripId, JSON.stringify(edits), JSON.stringify(statuses), statusRevision]);
      return sheetDetails({ ...state, edits, statuses, statusRevision });
    });
  }

  complete(accountId: string, tripId: string, sheetId: string, { requestId, ...basis }: ReturnType<typeof readReviewInput>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'complete-delivery', tripId, sheetId, ...basis }, async client => {
      const state = await readFormalSheet(client, accountId, tripId, sheetId);
      checkBasis(state, basis);
      if (state.deliveryCompleted) return sheetDetails(state);
      if (state.reviewed) throw new HttpError(409, 'delivery_reviewed', '本客户已核对，请从对账工作区处理更正');
      const lines = deliveryLines(state.customer, state.edits);
      requirePrices(lines);
      const statuses = { ...state.statuses, ...Object.fromEntries(lines.map(line =>
        [line.id, line.receivedQuantity > 0 ? 'delivered' : 'pending'] as const)) };
      const statusRevision = nextRevision(state);
      await client.query(`
        UPDATE dispatch.trips SET statuses = $3, status_revision = $4 WHERE account_id = $1 AND id = $2
      `, [accountId, tripId, JSON.stringify(statuses), statusRevision]);
      await client.query(`
        UPDATE dispatch.sheets SET reviewed = true, delivery_completed = true WHERE account_id = $1 AND trip_id = $2 AND id = $3
      `, [accountId, tripId, sheetId]);
      return sheetDetails({ ...state, statuses, statusRevision, reviewed: true, deliveryCompleted: true });
    });
  }

  setDelivery(accountId: string, tripId: string, sheetId: string, { requestId, ...change }: ReturnType<typeof readDeliveryInput>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'set-delivery', tripId, sheetId, change }, async client => {
      const state = await readFormalSheet(client, accountId, tripId, sheetId);
      const plan = planDelivery(state, change);
      if (state.reviewed && plan.changed) throw new HttpError(409, 'delivery_preview_required', '本单已核对，请先预览配送与账目变化');
      return this.applyDelivery(client, accountId, state, plan);
    });
  }

  preview(accountId: string, tripId: string, sheetId: string, { requestId, ...change }: ReturnType<typeof readDeliveryInput>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'preview-delivery', tripId, sheetId, change }, async client => {
      const state = await readFormalSheet(client, accountId, tripId, sheetId);
      const plan = planDelivery(state, change);
      const preview: DeliveryPreview = {
        previewId: randomUUID(), change, before: amounts(state), after: amounts(state, plan.statuses),
      };
      await client.query(`
        INSERT INTO dispatch.delivery_previews (account_id, id, trip_id, sheet_id, preview)
        VALUES ($1, $2, $3, $4, $5)
      `, [accountId, preview.previewId, tripId, sheetId, JSON.stringify(preview)]);
      return preview;
    });
  }

  confirm(accountId: string, tripId: string, sheetId: string, { requestId, previewId }: ReturnType<typeof readConfirmInput>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'confirm-delivery', tripId, sheetId, previewId }, async client => {
      const { rows: [stored] } = await client.query<{ preview: DeliveryPreview }>(`
        SELECT preview FROM dispatch.delivery_previews
        WHERE account_id = $1 AND id = $2 AND trip_id = $3 AND sheet_id = $4
      `, [accountId, previewId, tripId, sheetId]);
      if (!stored) throw new HttpError(404, 'preview_not_found', '未找到本客户的配送预览，请重新生成');
      const state = await readFormalSheet(client, accountId, tripId, sheetId);
      if (state.paid !== stored.preview.before.paid) {
        throw new HttpError(409, 'delivery_changed', '本单实收已变化，请重新预览配送与账目变化');
      }
      return this.applyDelivery(client, accountId, state, planDelivery(state, stored.preview.change));
    });
  }

  review(accountId: string, tripId: string, sheetId: string, { requestId, ...basis }: ReturnType<typeof readReviewInput>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'review-sheet', tripId, sheetId, ...basis }, async client => {
      const state = await readFormalSheet(client, accountId, tripId, sheetId);
      checkBasis(state, basis);
      requirePrices(deliveryLines(state.customer, state.edits));
      if (state.customer.items.some(item => state.statuses[item.id] === 'unrecorded')) {
        throw new HttpError(409, 'unrecorded_delivery', '请先标记所有未记录的明细');
      }
      if (!state.reviewed) {
        await client.query(`
          UPDATE dispatch.sheets SET reviewed = true WHERE account_id = $1 AND trip_id = $2 AND id = $3
        `, [accountId, tripId, sheetId]);
      }
      return sheetDetails({ ...state, reviewed: true });
    });
  }

  private async applyDelivery(client: PoolClient, accountId: string, state: SheetState, plan: ReturnType<typeof planDelivery>) {
    if (!plan.changed) return sheetDetails(state);
    const statusRevision = nextRevision(state);
    await client.query(`
      UPDATE dispatch.trips SET statuses = $3, status_revision = $4 WHERE account_id = $1 AND id = $2
    `, [accountId, state.tripId, JSON.stringify(plan.statuses), statusRevision]);
    return sheetDetails({ ...state, statuses: plan.statuses, statusRevision });
  }
}
