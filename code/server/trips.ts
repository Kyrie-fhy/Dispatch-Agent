import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { Account, Party } from '../miniprogram/core/settlement';
import {
  emptyTrip, latest, PickingLine, pickingList, previewTrip, resolveCustomerChoices, statusesFor,
  Trip, TripDraft, TripVersion,
} from '../miniprogram/core/trips';
import { readAccount, readParties, readWorkspace, workspaceDraft, writeAccount } from './account-workspace';
import { HttpError } from './http-error';
import { readConfirmInput, readNextInput, readPreviewInput } from './request-input';

type OrderSummary = Pick<TripVersion, 'customers' | 'totalCents'>;

interface TripPreview extends OrderSummary {
  previewId: string;
  draftId: string;
  revision: number;
  choices: (Party | null)[];
}

interface FormalTrip {
  trip: Trip;
  sheets: Account[];
  picking: PickingLine[];
}

type TripRow = {
  sourcePreviewId: string;
  statuses: Trip['statuses'];
  statusRevision: number;
};

type VersionRow = Omit<TripVersion, 'totalCents' | 'savedAt' | 'amendmentId'> & { totalCents: string; savedAt: Date; amendmentId: string | null };

function draftChanged(): HttpError {
  return new HttpError(409, 'draft_changed', '草稿已变化，请按最新草稿重新预览');
}

function missingTrip(): HttpError {
  return new HttpError(404, 'trip_not_found', '未找到正式送货单');
}

export class TripStore {
  constructor(private readonly pool: Pool) {}

  async workspace(accountId: string) {
    return readAccount(this.pool, accountId, async client => {
      const workspace = await readWorkspace(client, accountId);
      const parties = await readParties(client, accountId);
      const { rows: [current] } = await client.query<Pick<VersionRow, 'version' | 'totalCents'>>(`
        SELECT version, total_cents AS "totalCents"
        FROM dispatch.trip_versions WHERE account_id = $1 AND trip_id = $2
        ORDER BY version DESC LIMIT 1
      `, [accountId, workspace.currentTripId]);
      return {
        draft: workspaceDraft(workspace),
        draftConfirmed: workspace.id === workspace.currentTripId,
        parties,
        currentTrip: current ? { id: workspace.currentTripId, version: current.version, totalCents: Number(current.totalCents) } : null,
      };
    });
  }

  async trip(accountId: string, tripId: string): Promise<FormalTrip> {
    return readAccount(this.pool, accountId, client => this.readTrip(client, accountId, tripId));
  }

  async history(accountId: string, cursor: string | null) {
    return readAccount(this.pool, accountId, async client => {
      const pageSize = 20;
      const { currentTripId } = await readWorkspace(client, accountId);
      const { rows } = await client.query<{
        id: string; issuedAt: Date; version: number; totalCents: string; customers: string[];
      }>(`
        SELECT issued.trip_id AS id, issued.saved_at AS "issuedAt", latest.version, latest.total_cents AS "totalCents",
          ARRAY(SELECT item->>'customer' FROM jsonb_array_elements(latest.customers) AS item) AS customers
        FROM dispatch.trip_versions issued
        JOIN LATERAL (
          SELECT version, total_cents, customers FROM dispatch.trip_versions
          WHERE account_id = issued.account_id AND trip_id = issued.trip_id ORDER BY version DESC LIMIT 1
        ) latest ON true
        WHERE issued.account_id = $1 AND issued.version = 1 AND issued.trip_id IS DISTINCT FROM $2::uuid
          AND ($3::uuid IS NULL OR (issued.saved_at, issued.trip_id) < (
            SELECT saved_at, trip_id FROM dispatch.trip_versions
            WHERE account_id = $1 AND trip_id = $3 AND version = 1
          ))
        ORDER BY issued.saved_at DESC, issued.trip_id DESC LIMIT $4
      `, [accountId, currentTripId, cursor, pageSize + 1]);
      const page = rows.slice(0, pageSize);
      return {
        trips: page.map(row => ({ ...row, issuedAt: row.issuedAt.toISOString(), totalCents: Number(row.totalCents) })),
        nextCursor: rows.length > pageSize ? page[page.length - 1].id : null,
      };
    });
  }

  async preview(accountId: string, { requestId, draftId, revision }: ReturnType<typeof readPreviewInput>): Promise<TripPreview> {
    return writeAccount(this.pool, accountId, requestId, { action: 'preview-trip', draftId, revision }, async (client, workspace) => {
      if (workspace.id !== draftId || workspace.revision !== revision) throw draftChanged();
      if (workspace.currentTripId === draftId) {
        throw new HttpError(409, 'draft_confirmed', '本趟已确认，请查看正式单');
      }

      const { rows: [existing] } = await client.query<{ preview: TripPreview }>(`
        SELECT preview FROM dispatch.trip_previews
        WHERE account_id = $1 AND draft_id = $2 AND draft_revision = $3
      `, [accountId, draftId, revision]);
      if (existing) return existing.preview;

      const draft = workspaceDraft(workspace);
      const parties = await readParties(client, accountId);
      let summary: OrderSummary;
      let choices: (Party | null)[];
      try {
        summary = previewTrip(draft);
        choices = resolveCustomerChoices(draft, parties);
      } catch (error) {
        const message = error instanceof Error ? error.message : '请检查草稿内容';
        throw new HttpError(400, 'invalid_draft', message);
      }
      const preview = { previewId: randomUUID(), draftId, revision, ...summary, choices };
      await client.query(`
        INSERT INTO dispatch.trip_previews (account_id, id, draft_id, draft_revision, preview)
        VALUES ($1, $2, $3, $4, $5)
      `, [accountId, preview.previewId, draftId, revision, JSON.stringify(preview)]);
      return preview;
    });
  }

  async confirm(accountId: string, { requestId, previewId }: ReturnType<typeof readConfirmInput>): Promise<FormalTrip> {
    return writeAccount(this.pool, accountId, requestId, { action: 'confirm-trip', previewId }, async (client, workspace) => {
      const { rows: [stored] } = await client.query<{ preview: TripPreview }>(
        'SELECT preview FROM dispatch.trip_previews WHERE account_id = $1 AND id = $2', [accountId, previewId]);
      if (!stored) throw new HttpError(404, 'preview_not_found', '未找到预览，请重新生成');
      const { preview } = stored;
      const { draftId: tripId } = preview;
      const existing = await this.tripRow(client, accountId, tripId);
      if (existing?.sourcePreviewId === previewId) return this.readTrip(client, accountId, tripId, existing);
      if (existing || workspace.id !== tripId || workspace.revision !== preview.revision) throw draftChanged();

      await this.createTrip(client, accountId, preview);
      return this.readTrip(client, accountId, tripId);
    });
  }

  async nextDraft(accountId: string, { requestId, draftId }: ReturnType<typeof readNextInput>): Promise<TripDraft> {
    return writeAccount(this.pool, accountId, requestId, { action: 'next-draft', draftId }, async (client, workspace) => {
      if (workspace.id !== draftId || workspace.currentTripId !== draftId) {
        throw new HttpError(409, 'draft_open', '请先确认当前草稿，再开始下一趟');
      }
      const draft = emptyTrip(randomUUID);
      await client.query(`
        UPDATE dispatch.workspaces SET draft_id = $2, draft_revision = $3, draft_customers = $4
        WHERE account_id = $1
      `, [accountId, draft.id, draft.revision, JSON.stringify(draft.customers)]);
      return draft;
    });
  }

  private async createTrip(client: PoolClient, accountId: string, preview: TripPreview): Promise<void> {
    const { draftId, previewId, customers, totalCents } = preview;
    const statuses = statusesFor(customers, 'pending');
    await client.query(`
      INSERT INTO dispatch.trips (account_id, id, source_preview_id, statuses)
      VALUES ($1, $2, $3, $4)
    `, [accountId, draftId, previewId, JSON.stringify(statuses)]);
    await client.query(`
      INSERT INTO dispatch.trip_versions (account_id, trip_id, version, customers, total_cents, saved_at)
      VALUES ($1, $2, 1, $3, $4, clock_timestamp())
    `, [accountId, draftId, JSON.stringify(customers), totalCents]);

    const newParties: Party[] = [];
    const linkedIds = customers.map((customer, index) => {
      const existing = preview.choices[index];
      if (existing) return existing.id;
      const party = { id: randomUUID(), name: customer.customer };
      newParties.push(party);
      return party.id;
    });
    if (newParties.length) {
      await client.query(`
        INSERT INTO dispatch.parties (account_id, id, name)
        SELECT $1, id, name FROM unnest($2::uuid[], $3::text[]) AS new_party(id, name)
      `, [accountId, newParties.map(party => party.id), newParties.map(party => party.name)]);
    }
    await client.query(`
      INSERT INTO dispatch.sheets (account_id, trip_id, id, party_id)
      SELECT $1, $2, id, party_id FROM unnest($3::text[], $4::uuid[]) AS sheet(id, party_id)
    `, [accountId, draftId, customers.map(customer => customer.id), linkedIds]);
    await client.query('UPDATE dispatch.workspaces SET current_trip_id = $2 WHERE account_id = $1', [accountId, draftId]);
  }

  private async tripRow(client: PoolClient, accountId: string, tripId: string): Promise<TripRow | undefined> {
    const { rows: [row] } = await client.query<TripRow>(`
      SELECT source_preview_id AS "sourcePreviewId", statuses, status_revision AS "statusRevision"
      FROM dispatch.trips WHERE account_id = $1 AND id = $2
    `, [accountId, tripId]);
    return row;
  }

  private async readTrip(client: PoolClient, accountId: string, tripId: string, known?: TripRow): Promise<FormalTrip> {
    const row = known ?? await this.tripRow(client, accountId, tripId);
    if (!row) throw missingTrip();
    const { rows } = await client.query<VersionRow>(`
      SELECT version, customers, total_cents AS "totalCents", saved_at AS "savedAt", amendment_id AS "amendmentId"
      FROM dispatch.trip_versions WHERE account_id = $1 AND trip_id = $2 ORDER BY version
    `, [accountId, tripId]);
    if (!rows.length) throw new Error('正式单缺少版本快照');
    const versions = rows.map(row => ({
      version: row.version, customers: row.customers, totalCents: Number(row.totalCents), savedAt: row.savedAt.toISOString(),
      ...(row.amendmentId ? { amendmentId: row.amendmentId } : {}),
    }));
    const trip: Trip = { id: tripId, origin: 's2', versions, statuses: row.statuses, statusRevision: row.statusRevision };
    const { rows: sheets } = await client.query<Account>(`
      SELECT trip_id AS "tripId", id AS "sheetId", party_id AS "partyId", reviewed
      FROM dispatch.sheets WHERE account_id = $1 AND trip_id = $2 ORDER BY id
    `, [accountId, tripId]);
    return { trip, sheets, picking: pickingList(latest(trip).customers) };
  }
}
