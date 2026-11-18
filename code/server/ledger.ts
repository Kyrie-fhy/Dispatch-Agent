import { DeliveryEdits, deliveryLines } from '../miniprogram/core/delivery-execution';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import {
  Account, checkOpening, customerDebts, Ledger, OpeningDebt, openingDebtId, OpeningPreview,
  orderDebtId, planReceipt, Receipt, ReceiptPreview, Sheet, sumCents,
} from '../miniprogram/core/settlement';
import { CustomerOrder, Trip } from '../miniprogram/core/trips';
import { readAccount, writeAccount } from './account-workspace';
import { HttpError } from './http-error';

type LedgerInput = { requestId: string; cents: number };
type OpeningInput = LedgerInput & Pick<OpeningDebt, 'day' | 'source'>;
type ConfirmInput = { requestId: string; previewId: string };
type LedgerState = { ledger: Ledger; trips: Trip[] };
type OpeningRow = Omit<OpeningDebt, 'cents'> & { cents: string };
type ReceiptRow = Omit<Receipt, 'cents' | 'savedAt' | 'allocations'> & {
  cents: string; savedAt: Date;
  allocations: ({ cents: number } & ({ openingId: string } | Sheet))[];
};

const businessDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

function businessDay(date: Date): string {
  const parts = Object.fromEntries(businessDate.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function sheetAccount(client: PoolClient, accountId: string, sheet: Sheet): Promise<Account> {
  const { rows: [account] } = await client.query<Account>(`
    SELECT trip_id AS "tripId", id AS "sheetId", party_id AS "partyId", reviewed
    FROM dispatch.sheets WHERE account_id = $1 AND trip_id = $2 AND id = $3
  `, [accountId, sheet.tripId, sheet.sheetId]);
  if (!account) throw new HttpError(404, 'sheet_not_found', '未找到客户单');
  return account;
}

async function openingDebts(client: PoolClient, accountId: string, partyId: string): Promise<OpeningDebt[]> {
  const { rows } = await client.query<OpeningRow>(`
    SELECT id, party_id AS "partyId", to_char(day, 'YYYY-MM-DD') AS day, cents, source
    FROM dispatch.opening_debts WHERE account_id = $1 AND party_id = $2
  `, [accountId, partyId]);
  return rows.map(row => ({ ...row, cents: Number(row.cents) }));
}

async function receipts(client: PoolClient, accountId: string, partyId: string, id: string | null = null): Promise<Receipt[]> {
  const { rows } = await client.query<ReceiptRow>(`
    SELECT r.id, r.party_id AS "partyId", r.cents, r.saved_at AS "savedAt",
      jsonb_agg(jsonb_build_object(
        'cents', a.cents
      ) || CASE WHEN a.opening_id IS NOT NULL THEN jsonb_build_object('openingId', a.opening_id)
        ELSE jsonb_build_object('tripId', a.trip_id, 'sheetId', a.sheet_id) END ORDER BY a.position) AS allocations
    FROM dispatch.receipts r
    JOIN dispatch.receipt_allocations a ON a.account_id = r.account_id AND a.receipt_id = r.id
    WHERE r.account_id = $1 AND r.party_id = $2 AND ($3::uuid IS NULL OR r.id = $3)
    GROUP BY r.account_id, r.id ORDER BY r.saved_at, r.id
  `, [accountId, partyId, id]);
  return rows.map(row => ({
    ...row, cents: Number(row.cents), savedAt: row.savedAt.toISOString(),
    allocations: row.allocations.map(target => ({
      debtId: 'openingId' in target ? openingDebtId(target.openingId) : orderDebtId(target), cents: target.cents,
    })),
  }));
}

async function ledgerState(client: PoolClient, accountId: string, partyId: string): Promise<LedgerState> {
  const opening = await openingDebts(client, accountId, partyId);
  const payments = await receipts(client, accountId, partyId);
  const { rows } = await client.query<Account & {
    statuses: Trip['statuses']; edits: DeliveryEdits; statusRevision: number; version: number; customers: CustomerOrder[]; issuedAt: Date;
  }>(`
    SELECT s.trip_id AS "tripId", s.id AS "sheetId", s.party_id AS "partyId", s.reviewed,
      t.statuses, t.delivery_edits AS edits, t.status_revision AS "statusRevision", v.version, v.customers, issued.saved_at AS "issuedAt"
    FROM dispatch.sheets s
    JOIN dispatch.trips t ON t.account_id = s.account_id AND t.id = s.trip_id
    JOIN dispatch.trip_versions issued ON issued.account_id = s.account_id AND issued.trip_id = s.trip_id AND issued.version = 1
    JOIN LATERAL (
      SELECT version, customers FROM dispatch.trip_versions
      WHERE account_id = s.account_id AND trip_id = s.trip_id ORDER BY version DESC LIMIT 1
    ) v ON true
    WHERE s.account_id = $1 AND s.party_id = $2 AND s.reviewed
  `, [accountId, partyId]);
  const accounts = rows.map(({ tripId, sheetId, partyId, reviewed }) => ({ tripId, sheetId, partyId, reviewed }));
  const trips: Trip[] = rows.map(row => {
    const customer = row.customers.find(item => item.id === row.sheetId);
    if (!customer) throw new Error('正式版本缺少客户明细');
    const savedAt = row.issuedAt.toISOString();
    const current = { version: row.version, customers: [{ ...customer, items: deliveryLines(customer, row.edits) }], totalCents: customer.totalCents, savedAt };
    // The allocation order always uses the first issue time, including for amended sheets.
    const versions = row.version === 1 ? [current] : [{ ...current, version: 1 }, current];
    return { id: row.tripId, origin: 's2', statuses: row.statuses, statusRevision: row.statusRevision, versions };
  });
  return { trips, ledger: { accounts, opening, receipts: payments, parties: [] } };
}

async function savePreview(client: PoolClient, accountId: string, sheet: Sheet, kind: string, preview: OpeningPreview | ReceiptPreview) {
  await client.query(`
    INSERT INTO dispatch.ledger_previews (account_id, id, trip_id, sheet_id, kind, payload)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [accountId, preview.id, sheet.tripId, sheet.sheetId, kind, JSON.stringify(preview)]);
  return preview;
}

async function loadPreview<T>(client: PoolClient, accountId: string, sheet: Sheet, id: string, kind: string): Promise<T> {
  const { rows: [row] } = await client.query<{ payload: T }>(`
    SELECT payload FROM dispatch.ledger_previews
    WHERE account_id = $1 AND id = $2 AND trip_id = $3 AND sheet_id = $4 AND kind = $5
  `, [accountId, id, sheet.tripId, sheet.sheetId, kind]);
  if (!row) throw new HttpError(404, 'preview_not_found', '未找到本客户单的账目预览');
  return row.payload;
}

function validateOpening(account: Account, opening: OpeningDebt[], preview: OpeningPreview): void {
  try {
    checkOpening({ ledger: { accounts: [account], opening, receipts: [], parties: [] } }, preview, businessDay(new Date()));
  } catch (error) {
    throw new HttpError(409, 'opening_rejected', (error as Error).message);
  }
}

export class LedgerStore {
  constructor(private readonly pool: Pool) {}

  read(accountId: string, sheet: Sheet) {
    return readAccount(this.pool, accountId, async client => {
      const account = await sheetAccount(client, accountId, sheet);
      const state = await ledgerState(client, accountId, account.partyId);
      const debts = customerDebts(state, account.partyId, businessDay);
      const remainingCents = sumCents(debts.map(debt => debt.remaining));
      const current = debts.find(debt => debt.id === orderDebtId(sheet));
      return { partyId: account.partyId, debts, receipts: state.ledger.receipts, remainingCents,
        otherRemainingCents: remainingCents - (current?.remaining ?? 0) };
    });
  }

  previewOpening(accountId: string, sheet: Sheet, { requestId, ...input }: OpeningInput) {
    return writeAccount(this.pool, accountId, requestId, { action: 'preview-opening', sheet, input }, async client => {
      const account = await sheetAccount(client, accountId, sheet);
      const preview = { ...input, id: randomUUID(), sheet, partyId: account.partyId };
      validateOpening(account, await openingDebts(client, accountId, account.partyId), preview);
      return savePreview(client, accountId, sheet, 'opening', preview);
    });
  }

  confirmOpening(accountId: string, sheet: Sheet, { requestId, previewId }: ConfirmInput) {
    return writeAccount(this.pool, accountId, requestId, { action: 'confirm-opening', sheet, previewId }, async client => {
      const preview = await loadPreview<OpeningPreview>(client, accountId, sheet, previewId, 'opening');
      const account = await sheetAccount(client, accountId, sheet);
      const existing = await openingDebts(client, accountId, account.partyId);
      const previous = existing.find(debt => debt.id === previewId);
      if (previous) return previous;
      validateOpening(account, existing, preview);
      const { id, partyId, day, cents, source } = preview;
      await client.query(`
        INSERT INTO dispatch.opening_debts (account_id, id, party_id, day, cents, source) VALUES ($1, $2, $3, $4, $5, $6)
      `, [accountId, id, partyId, day, cents, source]);
      return { id, partyId, day, cents, source };
    });
  }

  previewReceipt(accountId: string, sheet: Sheet, { requestId, cents }: LedgerInput) {
    return writeAccount(this.pool, accountId, requestId, { action: 'preview-receipt', sheet, cents }, async client => {
      const account = await sheetAccount(client, accountId, sheet);
      if (!account.reviewed) throw new HttpError(409, 'sheet_not_reviewed', '请先确认对账');
      const state = await ledgerState(client, accountId, account.partyId);
      let preview: ReceiptPreview;
      try {
        preview = planReceipt(state, sheet, cents, randomUUID(), businessDay);
      } catch (error) {
        throw new HttpError(409, 'receipt_rejected', (error as Error).message);
      }
      return savePreview(client, accountId, sheet, 'receipt', preview);
    });
  }

  confirmReceipt(accountId: string, sheet: Sheet, { requestId, previewId }: ConfirmInput) {
    return writeAccount(this.pool, accountId, requestId, { action: 'confirm-receipt', sheet, previewId }, async client => {
      const preview = await loadPreview<ReceiptPreview>(client, accountId, sheet, previewId, 'receipt');
      const account = await sheetAccount(client, accountId, sheet);
      const [previous] = await receipts(client, accountId, account.partyId, previewId);
      if (previous) return previous;
      const state = await ledgerState(client, accountId, account.partyId);
      const changed = () => new HttpError(409, 'ledger_changed', '客户账目已变化，请重新预览收款');
      let current: ReceiptPreview;
      try {
        current = planReceipt(state, sheet, preview.cents, previewId, businessDay);
      } catch {
        throw changed();
      }
      if (current.partyId !== preview.partyId || current.basis !== preview.basis) throw changed();
      return this.saveReceipt(client, accountId, state, current);
    });
  }

  private async saveReceipt(client: PoolClient, accountId: string, state: LedgerState, preview: ReceiptPreview): Promise<Receipt> {
    const { id, partyId, cents } = preview;
    const allocations = preview.allocations.map(({ debtId, cents }) => ({ debtId, cents }));
    const { rows: [saved] } = await client.query<{ savedAt: Date }>(`
      INSERT INTO dispatch.receipts (account_id, id, party_id, cents) VALUES ($1, $2, $3, $4) RETURNING saved_at AS "savedAt"
    `, [accountId, id, partyId, cents]);
    const openIds = new Map(state.ledger.opening.map(debt => [openingDebtId(debt.id), debt.id]));
    const sheets = new Map(state.ledger.accounts.map(sheet => [orderDebtId(sheet), sheet]));
    const targets = allocations.map(({ debtId }) => ({ opening: openIds.get(debtId), sheet: sheets.get(debtId) }));
    await client.query(`
      INSERT INTO dispatch.receipt_allocations (account_id, receipt_id, party_id, position, cents, opening_id, trip_id, sheet_id)
      SELECT $1, $2, $3, ordinality - 1, cents, opening_id, trip_id, sheet_id
      FROM unnest($4::bigint[], $5::uuid[], $6::uuid[], $7::text[]) WITH ORDINALITY a(cents, opening_id, trip_id, sheet_id, ordinality)
    `, [accountId, id, partyId, allocations.map(allocation => allocation.cents), targets.map(target => target.opening ?? null),
      targets.map(target => target.sheet?.tripId ?? null), targets.map(target => target.sheet?.sheetId ?? null)]);
    return { id, partyId, cents, savedAt: saved.savedAt.toISOString(), allocations };
  }
}
