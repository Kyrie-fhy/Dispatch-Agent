import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { Account, deliveredBalance } from '../miniprogram/core/settlement';
import { CustomerOrder, Trip } from '../miniprogram/core/trips';
import { readAccount, writeAccount } from './account-workspace';
import { HttpError } from './http-error';
import { readConfirmInput, readDeliveryInput, readReviewInput, validRevision } from './request-input';

type ReviewBasis = Omit<ReturnType<typeof readReviewInput>, 'requestId'>;
type DeliveryChange = Omit<ReturnType<typeof readDeliveryInput>, 'requestId'>;
type SheetRow = Account & ReviewBasis & { statuses: Trip['statuses']; customers: CustomerOrder[]; paid: string };
type SheetState = Omit<SheetRow, 'customers' | 'paid'> & { customer: CustomerOrder; paid: number };

interface DeliveryPreview {
  previewId: string;
  change: DeliveryChange;
  before: ReturnType<typeof deliveredBalance>;
  after: ReturnType<typeof deliveredBalance>;
}

function amounts(state: SheetState, statuses = state.statuses) {
  return deliveredBalance(state.customer, statuses, state.paid);
}

function sheetDetails(state: SheetState) {
  const { tripId, sheetId, partyId, reviewed, version, statusRevision, statuses, customer } = state;
  return {
    tripId, sheetId, partyId, reviewed, version, statusRevision,
    customer: customer.customer, orderCents: customer.totalCents, amounts: amounts(state),
    lines: customer.items.map(item => ({ ...item, status: statuses[item.id] })),
  };
}

function checkBasis(state: SheetState, basis: ReviewBasis) {
  if (state.version !== basis.version || state.statusRevision !== basis.statusRevision) {
    throw new HttpError(409, 'delivery_changed', '正式单或配送状态已变化，请重新打开单据核对');
  }
}

function planDelivery(state: SheetState, change: DeliveryChange) {
  checkBasis(state, change);
  const lines = change.lineId === null ? state.customer.items : state.customer.items.filter(item => item.id === change.lineId);
  if (!lines.length) throw new HttpError(404, 'line_not_found', '未找到本客户的货品明细');
  const changed = lines.some(item => state.statuses[item.id] !== change.status);
  if (changed && !validRevision(state.statusRevision, true)) {
    throw new HttpError(409, 'delivery_revision_limit', '配送记录已达到修订上限');
  }
  return {
    changed,
    statuses: { ...state.statuses, ...Object.fromEntries(lines.map(item => [item.id, change.status])) },
  };
}

export class DeliveryStore {
  constructor(private readonly pool: Pool) {}

  sheet(accountId: string, tripId: string, sheetId: string) {
    return readAccount(this.pool, accountId, async client => sheetDetails(await this.readSheet(client, accountId, tripId, sheetId)));
  }

  setDelivery(accountId: string, tripId: string, sheetId: string, { requestId, ...change }: ReturnType<typeof readDeliveryInput>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'set-delivery', tripId, sheetId, change }, async client => {
      const state = await this.readSheet(client, accountId, tripId, sheetId);
      const plan = planDelivery(state, change);
      if (state.reviewed && plan.changed) throw new HttpError(409, 'delivery_preview_required', '本单已核对，请先预览配送与账目变化');
      return this.applyDelivery(client, accountId, state, plan);
    });
  }

  preview(accountId: string, tripId: string, sheetId: string, { requestId, ...change }: ReturnType<typeof readDeliveryInput>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'preview-delivery', tripId, sheetId, change }, async client => {
      const state = await this.readSheet(client, accountId, tripId, sheetId);
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
      const state = await this.readSheet(client, accountId, tripId, sheetId);
      if (state.paid !== stored.preview.before.paid) {
        throw new HttpError(409, 'delivery_changed', '本单实收已变化，请重新预览配送与账目变化');
      }
      return this.applyDelivery(client, accountId, state, planDelivery(state, stored.preview.change));
    });
  }

  review(accountId: string, tripId: string, sheetId: string, { requestId, ...basis }: ReturnType<typeof readReviewInput>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'review-sheet', tripId, sheetId, ...basis }, async client => {
      const state = await this.readSheet(client, accountId, tripId, sheetId);
      checkBasis(state, basis);
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

  private async readSheet(client: PoolClient, accountId: string, tripId: string, sheetId: string): Promise<SheetState> {
    const { rows: [row] } = await client.query<SheetRow>(`
      SELECT s.trip_id AS "tripId", s.id AS "sheetId", s.party_id AS "partyId", s.reviewed,
             t.statuses, t.status_revision AS "statusRevision", v.version, v.customers,
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
    const { customers, paid, ...state } = row;
    const customer = customers.find(entry => entry.id === sheetId);
    if (!customer) throw new Error('正式版本缺少客户明细');
    return { ...state, customer, paid: Number(paid) };
  }

  private async applyDelivery(client: PoolClient, accountId: string, state: SheetState, plan: ReturnType<typeof planDelivery>) {
    if (!plan.changed) return sheetDetails(state);
    const statusRevision = state.statusRevision + 1;
    await client.query(`
      UPDATE dispatch.trips SET statuses = $3, status_revision = $4 WHERE account_id = $1 AND id = $2
    `, [accountId, state.tripId, JSON.stringify(plan.statuses), statusRevision]);
    return sheetDetails({ ...state, statuses: plan.statuses, statusRevision });
  }
}
