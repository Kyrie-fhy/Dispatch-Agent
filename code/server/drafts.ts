import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { matchCatalogItem, resolveCatalogAutoPrice } from '../miniprogram/core/catalog';
import { nullablePrice } from '../miniprogram/core/orders';
import { emptyTrip, TripDraft } from '../miniprogram/core/trips';
import { loadCatalog } from './catalog';
import { setAccount, transaction } from './database';
import { itemIdentityChanged, reconcileManualItem, SaveDraftInput } from './draft-input';
import { missingDraft, readAccount, readParties, readWorkspace, workspaceDraft, writeAccount } from './account-workspace';
import { HttpError } from './http-error';
import { readHistoricalSales } from './memory';

const developmentAccounts = new Set(['a', 'b']);
const sessionLifetimeSeconds = 60 * 60 * 8;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export class DraftStore {
  constructor(private readonly pool: Pool) {}

  async developmentSession(subject: string) {
    if (!developmentAccounts.has(subject)) {
      throw new HttpError(400, 'invalid_development_account', '请选择本地测试账号 a 或 b');
    }
    return this.startSession('development', subject);
  }

  async wechatSession(appId: string, openId: string) {
    return this.startSession('wechat', `${appId}:${openId}`);
  }

  private async startSession(provider: 'development' | 'wechat', subject: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000);
    await transaction(this.pool, async client => {
      await client.query(`INSERT INTO dispatch.accounts (id, identity_provider, identity_subject)
        VALUES ($1, $2, $3) ON CONFLICT (identity_provider, identity_subject) DO NOTHING`, [randomUUID(), provider, subject]);
      const { rows: [account] } = await client.query<{ id: string }>(
        'SELECT id FROM dispatch.accounts WHERE identity_provider = $1 AND identity_subject = $2', [provider, subject]);
      await setAccount(client, account.id);
      const draft = emptyTrip(randomUUID);
      await client.query(`INSERT INTO dispatch.workspaces (account_id, draft_id, draft_customers)
        VALUES ($1, $2, $3) ON CONFLICT (account_id) DO NOTHING`,
      [account.id, draft.id, JSON.stringify(workspaceDraft({ ...draft, currentTripId: null }).customers)]);
      await client.query('DELETE FROM dispatch.sessions WHERE account_id = $1 AND expires_at <= now()', [account.id]);
      await client.query('INSERT INTO dispatch.sessions (token_digest, account_id, expires_at) VALUES ($1, $2, $3)',
        [digest(token), account.id, expiresAt]);
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async accountFor(token: string, appId?: string): Promise<string> {
    const { rows: [session] } = await this.pool.query<{ account_id: string }>(`
      SELECT s.account_id FROM dispatch.sessions s JOIN dispatch.accounts a ON a.id = s.account_id
      WHERE s.token_digest = $1 AND s.expires_at > now() AND a.identity_provider = $2
        AND ($3::text IS NULL OR starts_with(a.identity_subject, $3))
    `, [digest(token), appId ? 'wechat' : 'development', appId ? `${appId}:` : null]);
    if (!session) throw new HttpError(401, 'session_required', '请重新登录');
    return session.account_id;
  }

  async revoke(token: string): Promise<void> {
    await this.pool.query('DELETE FROM dispatch.sessions WHERE token_digest = $1', [digest(token)]);
  }

  async draft(accountId: string, draftId: string): Promise<TripDraft> {
    return readAccount(this.pool, accountId, async client => {
      const workspace = await readWorkspace(client, accountId);
      if (workspace.id !== draftId) throw missingDraft();
      return workspaceDraft(workspace);
    });
  }

  async checkVoiceDraft(accountId: string, draftId: string, revision: number): Promise<void> {
    await readAccount(this.pool, accountId, async client => {
      const workspace = await readWorkspace(client, accountId);
      if (workspace.id !== draftId) throw missingDraft();
      if (workspace.currentTripId === draftId) throw new HttpError(409, 'draft_confirmed', '本趟已确认，请开始下一趟');
      if (workspace.revision !== revision) throw new HttpError(409, 'draft_changed', '草稿已更新，请刷新后重新录音。');
    });
  }

  async save(accountId: string, input: SaveDraftInput): Promise<TripDraft> {
    const { draft, requestId } = input;
    return writeAccount(this.pool, accountId, requestId, { action: 'save-draft', draft }, async (client, current) => {
      if (current.id !== draft.id) throw missingDraft();
      if (current.currentTripId === draft.id) {
        throw new HttpError(409, 'draft_confirmed', '本趟已确认，请开始下一趟');
      }
      if (current.revision !== draft.revision) {
        throw new HttpError(409, 'draft_changed', '草稿已更新，请核对最新版本后再保存');
      }
      const existingIds = draft.customers.flatMap(customer => customer.partyId ? [customer.partyId] : []);
      if (existingIds.length) {
        const parties = new Set((await readParties(client, accountId)).map(party => party.id));
        if (existingIds.some(partyId => !parties.has(partyId))) {
          throw new HttpError(400, 'invalid_customer', '未找到所选客户，请重新选择');
        }
      }
      const oldLines = new Map(current.customers.flatMap(customer => customer.items.map(item =>
        [item.id, { item, partyId: customer.partyId, customerId: customer.id }] as const)));
      const customers = draft.customers.map(customer => ({ ...customer, items: customer.items.map(item => {
        const prior = oldLines.get(item.id);
        return reconcileManualItem(item, prior?.item, prior?.partyId === customer.partyId && prior?.customerId === customer.id);
      }) }));
      // 改单位/规格后仍未手填单价的老明细，服务端再查一次货品库与熟客成交价，
      // 唯一对上规格就自动带价；仍对不上则刷新最新的参考价提示。
      const requery = customers.flatMap(customer => customer.items.flatMap((item, index) => {
        const prior = oldLines.get(item.id);
        if (!prior || !itemIdentityChanged(item, prior.item) || nullablePrice(item.price) !== null) return [];
        return [{ customer, index }];
      }));
      if (requery.length) {
        const catalog = await loadCatalog(client, accountId);
        if (catalog.length) {
          const partyIds = [...new Set(requery.flatMap(({ customer }) => customer.partyId ? [customer.partyId] : []))];
          const sales = partyIds.length ? await readHistoricalSales(client, accountId, partyIds) : [];
          for (const { customer, index } of requery) {
            const item = customer.items[index];
            customer.items[index] = resolveCatalogAutoPrice(item, matchCatalogItem(item, catalog), customer.partyId, sales);
          }
        }
      }
      const saved = workspaceDraft({ ...draft, customers, revision: current.revision + 1, currentTripId: current.currentTripId });
      await client.query(`UPDATE dispatch.workspaces SET draft_revision = $2, draft_customers = $3
        WHERE account_id = $1`, [accountId, saved.revision, JSON.stringify(saved.customers)]);
      return saved;
    });
  }
}
