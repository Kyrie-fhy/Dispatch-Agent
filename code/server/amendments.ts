import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Sheet } from '../miniprogram/core/settlement';
import { planAmendment, TripVersion } from '../miniprogram/core/trips';
import { writeAccount } from './account-workspace';
import { readFormalSheet } from './delivery';
import { readAmendmentInput } from './draft-input';
import { HttpError } from './http-error';
import { readConfirmInput, validRevision } from './request-input';

type SheetState = Awaited<ReturnType<typeof readFormalSheet>>;
type Edit = Omit<ReturnType<typeof readAmendmentInput>, 'requestId'>;
type VersionRow = Omit<TripVersion, 'totalCents' | 'savedAt'> & { totalCents: string; savedAt: Date };

function accountBasis(state: SheetState) {
  return JSON.stringify([state.partyId, state.reviewed, state.paid]);
}

function changed() {
  return new HttpError(409, 'amendment_changed', '正式单、配送状态或本单账目已变化，请重新打开并预览');
}

function evaluate(state: SheetState, edit: Edit) {
  if (state.version !== edit.version || state.statusRevision !== edit.statusRevision) throw changed();
  if (state.deliveryCompleted || state.customer.items.some(item => Object.prototype.hasOwnProperty.call(state.edits, item.id))) {
    throw new HttpError(409, 'delivery_execution_exists', '本客户已有现场配送记录，请在配送明细处理');
  }
  if (!validRevision(state.version, true)) throw new HttpError(409, 'version_limit', '正式单已达到版本上限');
  try {
    const plan = planAmendment(state, state.statuses, state.customer,
      { id: state.sheetId, customer: state.customer.customer, items: edit.items }, edit.replacementStatuses, state.paid, true);
    if (plan.customer.items.some(item => item.amountCents === null && (state.reviewed || plan.statuses[item.id] === 'delivered'))) {
      throw new Error('已送达或已核对的货品须填写单价');
    }
    return plan;
  } catch (error) {
    throw new HttpError(400, 'invalid_amendment', (error as Error).message);
  }
}

export class AmendmentStore {
  constructor(private readonly pool: Pool) {}

  preview(accountId: string, sheet: Sheet, { requestId, ...edit }: ReturnType<typeof readAmendmentInput>) {
    return writeAccount(this.pool, accountId, requestId, { action: 'preview-amendment', sheet, edit }, async client => {
      const state = await readFormalSheet(client, accountId, sheet.tripId, sheet.sheetId);
      const plan = evaluate(state, edit);
      const previewId = randomUUID();
      await client.query(`
        INSERT INTO dispatch.amendment_previews (account_id, trip_id, sheet_id, id, payload)
        VALUES ($1, $2, $3, $4, $5)
      `, [accountId, sheet.tripId, sheet.sheetId, previewId, JSON.stringify({ edit, basis: accountBasis(state) })]);
      return {
        previewId, ...sheet, version: state.version, statusRevision: state.statusRevision, reviewed: state.reviewed,
        orderCents: { before: plan.original.totalCents, after: plan.customer.totalCents },
        changes: plan.changes, picking: plan.picking, unchecked: plan.unchecked, before: plan.before, after: plan.after,
      };
    });
  }

  confirm(accountId: string, sheet: Sheet, { requestId, previewId }: ReturnType<typeof readConfirmInput>): Promise<TripVersion> {
    return writeAccount(this.pool, accountId, requestId, { action: 'confirm-amendment', sheet, previewId }, async client => {
      const { rows: [stored] } = await client.query<{ payload: { edit: Edit; basis: string } }>(`
        SELECT payload FROM dispatch.amendment_previews
        WHERE account_id = $1 AND trip_id = $2 AND sheet_id = $3 AND id = $4
      `, [accountId, sheet.tripId, sheet.sheetId, previewId]);
      if (!stored) throw new HttpError(404, 'preview_not_found', '未找到本客户单的更正预览');

      const { rows: [previous] } = await client.query<VersionRow>(`
        SELECT version, customers, total_cents AS "totalCents", saved_at AS "savedAt", amendment_id AS "amendmentId"
        FROM dispatch.trip_versions WHERE account_id = $1 AND trip_id = $2 AND amendment_id = $3
      `, [accountId, sheet.tripId, previewId]);
      if (previous) return { ...previous, totalCents: Number(previous.totalCents), savedAt: previous.savedAt.toISOString() };

      const state = await readFormalSheet(client, accountId, sheet.tripId, sheet.sheetId);
      if (accountBasis(state) !== stored.payload.basis) throw changed();
      const { customers, statuses, totalCents } = evaluate(state, stored.payload.edit);
      const version = state.version + 1;
      const { rows: [saved] } = await client.query<{ savedAt: Date }>(`
        INSERT INTO dispatch.trip_versions (account_id, trip_id, version, customers, total_cents, amendment_id)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING saved_at AS "savedAt"
      `, [accountId, sheet.tripId, version, JSON.stringify(customers), totalCents, previewId]);
      await client.query('UPDATE dispatch.trips SET statuses = $3 WHERE account_id = $1 AND id = $2',
        [accountId, sheet.tripId, JSON.stringify(statuses)]);
      return { version, customers, totalCents, savedAt: saved.savedAt.toISOString(), amendmentId: previewId };
    });
  }
}
