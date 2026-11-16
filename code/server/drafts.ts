import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { emptyTrip, TripDraft } from '../miniprogram/core/trips';
import { setAccount, transaction } from './database';
import { SaveDraftInput } from './draft-input';
import { HttpError } from './http-error';

const developmentAccounts = new Set(['a', 'b']);
const sessionLifetimeSeconds = 60 * 60 * 8;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function missingDraft(): HttpError {
  return new HttpError(404, 'draft_not_found', '未找到草稿');
}

type WorkspaceRow = { id: string; revision: number; customers: TripDraft['customers'] };
const draftColumns = 'draft_id AS id, draft_revision AS revision, draft_customers AS customers';

export class DraftStore {
  constructor(private readonly pool: Pool) {}

  async developmentSession(subject: string) {
    if (!developmentAccounts.has(subject)) {
      throw new HttpError(400, 'invalid_development_account', '请选择本地测试账号 a 或 b');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000);
    await transaction(this.pool, async client => {
      await client.query(`INSERT INTO dispatch.accounts (id, identity_provider, identity_subject)
        VALUES ($1, 'development', $2) ON CONFLICT (identity_provider, identity_subject) DO NOTHING`, [randomUUID(), subject]);
      const { rows: [account] } = await client.query<{ id: string }>(
        "SELECT id FROM dispatch.accounts WHERE identity_provider = 'development' AND identity_subject = $1", [subject]);
      await setAccount(client, account.id);
      const draft = emptyTrip(randomUUID);
      await client.query(`INSERT INTO dispatch.workspaces (account_id, draft_id, draft_customers)
        VALUES ($1, $2, $3) ON CONFLICT (account_id) DO NOTHING`,
      [account.id, draft.id, JSON.stringify(draft.customers)]);
      await client.query('DELETE FROM dispatch.sessions WHERE account_id = $1 AND expires_at <= now()', [account.id]);
      await client.query('INSERT INTO dispatch.sessions (token_digest, account_id, expires_at) VALUES ($1, $2, $3)',
        [digest(token), account.id, expiresAt]);
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async accountFor(token: string): Promise<string> {
    const { rows: [session] } = await this.pool.query<{ account_id: string }>(
      'SELECT account_id FROM dispatch.sessions WHERE token_digest = $1 AND expires_at > now()', [digest(token)]);
    if (!session) throw new HttpError(401, 'session_required', '请重新登录');
    return session.account_id;
  }

  async revoke(token: string): Promise<void> {
    await this.pool.query('DELETE FROM dispatch.sessions WHERE token_digest = $1', [digest(token)]);
  }

  async workspace(accountId: string): Promise<TripDraft> {
    return transaction(this.pool, async client => {
      await setAccount(client, accountId);
      return this.readWorkspace(client, accountId);
    });
  }

  async save(accountId: string, input: SaveDraftInput): Promise<TripDraft> {
    const { draft, requestId } = input;
    const inputDigest = digest(JSON.stringify({ action: 'save-draft', draft }));
    return transaction(this.pool, async client => {
      await setAccount(client, accountId);
      const current = await this.readWorkspace(client, accountId, true);
      if (current.id !== draft.id) throw missingDraft();

      const { rows: [previous] } = await client.query<{ input_digest: Buffer; result: TripDraft }>(
        'SELECT input_digest, result FROM dispatch.request_results WHERE account_id = $1 AND request_id = $2',
        [accountId, requestId]);
      if (previous) {
        if (!previous.input_digest.equals(inputDigest)) {
          throw new HttpError(409, 'request_conflict', '同一请求编号已用于不同的保存');
        }
        return previous.result;
      }

      if (current.revision !== draft.revision) {
        throw new HttpError(409, 'draft_changed', '草稿已更新，请核对最新版本后再保存');
      }
      const saved = { ...draft, revision: current.revision + 1 };
      await client.query(`UPDATE dispatch.workspaces SET draft_revision = $2, draft_customers = $3
        WHERE account_id = $1`, [accountId, saved.revision, JSON.stringify(saved.customers)]);
      await client.query(`INSERT INTO dispatch.request_results (account_id, request_id, input_digest, result)
        VALUES ($1, $2, $3, $4)`, [accountId, requestId, inputDigest, JSON.stringify(saved)]);
      return saved;
    });
  }

  private async readWorkspace(client: PoolClient, accountId: string, lock = false): Promise<TripDraft> {
    const { rows: [draft] } = await client.query<WorkspaceRow>(`
      SELECT ${draftColumns} FROM dispatch.workspaces
      WHERE account_id = $1 ${lock ? 'FOR UPDATE' : ''}
    `, [accountId]);
    if (!draft) throw missingDraft();
    return draft;
  }
}
