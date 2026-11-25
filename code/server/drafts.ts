import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { matchCatalogItem, resolveCatalogAutoPrice } from '../miniprogram/core/catalog';
import { nullablePrice } from '../miniprogram/core/orders';
import { emptyTrip, TripDraft } from '../miniprogram/core/trips';
import { ActivationCodes } from './activation';
import { loadCatalog } from './catalog';
import { setAccount, transaction } from './database';
import { itemIdentityChanged, reconcileManualItem, SaveDraftInput } from './draft-input';
import { businessSession, disabledAccount, lockAccountActivity, missingDraft, readAccount, readParties, readWorkspace, workspaceDraft, writeAccount } from './account-workspace';
import { HttpError } from './http-error';
import { readHistoricalSales } from './memory';

const developmentAccounts = new Set(['a', 'b']);
const sessionLifetimeSeconds = 60 * 60 * 8;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export class DraftStore {
  constructor(private readonly pool: Pool, private readonly requireActivation = false,
    private readonly activationCodes = new ActivationCodes()) {}

  async developmentSession(subject: string) {
    if (!developmentAccounts.has(subject)) {
      throw new HttpError(400, 'invalid_development_account', '请选择本地测试账号 a 或 b');
    }
    return this.startSession('development', subject);
  }

  async wechatSession(appId: string, openId: string, activationCode?: string) {
    return this.startSession('wechat', `${appId}:${openId}`, activationCode);
  }

  private async startSession(provider: 'development' | 'wechat', subject: string, activationCode?: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000);
    const remarkName = await transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`dispatch.${provider}-subject:${subject}`]);
      const findAccount = async () => (await client.query<{
        id: string; activated_at: Date | null; disabled_at: Date | null; session_epoch: number; remark_name: string;
      }>(`SELECT id, activated_at, disabled_at, session_epoch, remark_name FROM dispatch.accounts
        WHERE identity_provider = $1 AND identity_subject = $2`, [provider, subject])).rows[0];
      let account = await findAccount();
      const accountId = account?.id ?? randomUUID();
      await lockAccountActivity(client, accountId);
      // Read the state again after the activity lock so a concurrent disable can never issue a session.
      if (account) account = await findAccount();
      if (account?.disabled_at) throw disabledAccount();
      let remark = account?.remark_name ?? '';
      if (!account?.activated_at) {
        const gated = provider === 'wechat' && this.requireActivation;
        if (gated && !activationCode?.trim()) {
          throw new HttpError(403, 'activation_required', '请输入管理员提供的开通码完成开通');
        }
        const redemption = gated ? await this.activationCodes.unusedForRedemption(client, subject, activationCode!) : null;
        remark = redemption?.remark_name ?? remark;
        if (account) {
          await client.query('UPDATE dispatch.accounts SET activated_at = clock_timestamp(), remark_name = $2 WHERE id = $1',
            [accountId, remark]);
        } else {
          await client.query(`INSERT INTO dispatch.accounts (id, identity_provider, identity_subject, remark_name, activated_at)
            VALUES ($1, $2, $3, $4, clock_timestamp())`, [accountId, provider, subject, remark]);
        }
        if (redemption) {
          await client.query(`UPDATE dispatch.activation_codes SET redeemed_at = clock_timestamp(), redeemed_account_id = $2
            WHERE id = $1`, [redemption.id, accountId]);
        }
      }
      await setAccount(client, accountId);
      const draft = emptyTrip(randomUUID);
      await client.query(`INSERT INTO dispatch.workspaces (account_id, draft_id, draft_customers)
        VALUES ($1, $2, $3) ON CONFLICT (account_id) DO NOTHING`,
      [accountId, draft.id, JSON.stringify(workspaceDraft({ ...draft, currentTripId: null }).customers)]);
      await client.query('DELETE FROM dispatch.sessions WHERE account_id = $1 AND expires_at <= now()', [accountId]);
      await client.query(`INSERT INTO dispatch.sessions (token_digest, account_id, expires_at, session_epoch)
        VALUES ($1, $2, $3, $4)`, [digest(token), accountId, expiresAt, account?.session_epoch ?? 0]);
      return remark;
    });
    const session = { token, expiresAt: expiresAt.toISOString() };
    return provider === 'wechat' ? { ...session, remarkName } : session;
  }

  async accountFor(token: string, appId?: string): Promise<string> {
    const { rows: [session] } = await this.pool.query<{
      account_id: string; session_epoch: number; disabled_at: Date | null; active_due: boolean;
    }>(`
      SELECT s.account_id, s.session_epoch, a.disabled_at,
        (a.last_active_at IS NULL OR a.last_active_at < now() - interval '60 seconds') AS active_due
      FROM dispatch.sessions s JOIN dispatch.accounts a ON a.id = s.account_id
      WHERE s.token_digest = $1 AND s.expires_at > now() AND a.identity_provider = $2
        AND ($3::text IS NULL OR starts_with(a.identity_subject, $3))
        AND (s.session_epoch = a.session_epoch OR a.disabled_at IS NOT NULL)
    `, [digest(token), appId ? 'wechat' : 'development', appId ? `${appId}:` : null]);
    if (!session) throw new HttpError(401, 'session_required', '请重新登录');
    if (session.disabled_at) throw disabledAccount();
    const scope = businessSession.getStore();
    if (scope) Object.assign(scope, { accountId: session.account_id, epoch: session.session_epoch });
    if (session.active_due) {
      void this.pool.query(`
        WITH due AS (
          SELECT id FROM dispatch.accounts WHERE id = $1 AND session_epoch = $2 AND disabled_at IS NULL
            AND (last_active_at IS NULL OR last_active_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED
        )
        UPDATE dispatch.accounts a SET last_active_at = now() FROM due WHERE a.id = due.id
      `, [session.account_id, session.session_epoch]).catch(() => {
        console.error('无法更新配送员最近活跃时间');
      });
    }
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
