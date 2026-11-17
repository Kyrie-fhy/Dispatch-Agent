import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { Party } from '../miniprogram/core/settlement';
import { TripDraft } from '../miniprogram/core/trips';
import { setAccount, transaction } from './database';
import { HttpError } from './http-error';

export type Workspace = TripDraft & { currentTripId: string | null };

export function missingDraft(): HttpError {
  return new HttpError(404, 'draft_not_found', '未找到草稿');
}

export async function readWorkspace(client: PoolClient, accountId: string, lock = false): Promise<Workspace> {
  const { rows: [workspace] } = await client.query<Workspace>(`
    SELECT draft_id AS id, draft_revision AS revision, draft_customers AS customers, current_trip_id AS "currentTripId"
    FROM dispatch.workspaces WHERE account_id = $1 ${lock ? 'FOR UPDATE' : ''}
  `, [accountId]);
  if (!workspace) throw missingDraft();
  return workspace;
}

export function workspaceDraft({ id, revision, customers }: Workspace): TripDraft {
  return { id, revision, customers };
}

export async function readParties(client: PoolClient, accountId: string): Promise<Party[]> {
  const { rows } = await client.query<Party>(
    'SELECT id, name FROM dispatch.parties WHERE account_id = $1 ORDER BY name, id', [accountId]);
  return rows;
}

export function readAccount<T>(pool: Pool, accountId: string, read: (client: PoolClient) => Promise<T>): Promise<T> {
  return transaction(pool, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await setAccount(client, accountId);
    return read(client);
  });
}

export async function readAccountResult<T>(client: PoolClient, accountId: string, requestId: string,
  input: { action: string; [name: string]: unknown }) {
  const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest();
  const { rows: [previous] } = await client.query<{ input_digest: Buffer; result: T }>(
    'SELECT input_digest, result FROM dispatch.request_results WHERE account_id = $1 AND request_id = $2',
    [accountId, requestId]);
  if (previous && !previous.input_digest.equals(inputDigest)) {
    throw new HttpError(409, 'request_conflict', '同一请求编号已用于不同的操作或内容');
  }
  return { inputDigest, previous };
}

export function writeAccount<T>(
  pool: Pool,
  accountId: string,
  requestId: string,
  input: { action: string; [name: string]: unknown },
  write: (client: PoolClient, workspace: Workspace) => Promise<T>,
): Promise<T> {
  return transaction(pool, async client => {
    await setAccount(client, accountId);
    const workspace = await readWorkspace(client, accountId, true);
    const { inputDigest, previous } = await readAccountResult<T>(client, accountId, requestId, input);
    if (previous) return previous.result;

    const result = await write(client, workspace);
    await client.query(`INSERT INTO dispatch.request_results (account_id, request_id, input_digest, result)
      VALUES ($1, $2, $3, $4)`, [accountId, requestId, inputDigest, JSON.stringify(result)]);
    return result;
  });
}
