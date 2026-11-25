import type { Pool, PoolClient } from 'pg';
import { normalizeMemoryText } from '../../miniprogram/core/memory';
import { lockAccountActivity, readAccount, readParties, readWorkspace } from '../account-workspace';
import { ActivationCodes } from '../activation';
import { interruptAccountTurns } from '../agent/store';
import { setAccount, transaction } from '../database';
import { HttpError } from '../http-error';
import { readDirectory, readHistoricalSales, writeAlias } from '../memory';
import type { Input } from './http';
import { inputText, invalidInput, requireId } from './http';
import { requireAccount } from './store';

const accountFields = `id, remark_name AS "remarkName", activated_at IS NOT NULL AS activated,
  disabled_at IS NOT NULL AS disabled, disabled_at AS "disabledAt"`;

export async function renameAccount(pool: Pool, accountId: string, body: Input) {
  const remarkName = inputText(body.remarkName, '配送员备注名', 40, true);
  const { rows: [account] } = await pool.query(`
    UPDATE dispatch.accounts SET remark_name = $2 WHERE id = $1 RETURNING ${accountFields}
  `, [accountId, remarkName]);
  if (!account) throw new HttpError(404, 'account_not_found', '未找到配送员账号');
  return account;
}

export function setAccountDisabled(pool: Pool, accountId: string, disabled: boolean) {
  return transaction(pool, async client => {
    await lockAccountActivity(client, accountId, true);
    const { rows: [account] } = await client.query(`
      UPDATE dispatch.accounts SET disabled_at = ${disabled ? 'clock_timestamp(), session_epoch = session_epoch + 1' : 'NULL'}
      WHERE id = $1 RETURNING ${accountFields}
    `, [accountId]);
    if (!account) throw new HttpError(404, 'account_not_found', '未找到配送员账号');
    if (disabled) {
      await client.query('DELETE FROM dispatch.sessions WHERE account_id = $1', [accountId]);
      await setAccount(client, accountId);
      await interruptAccountTurns(client, accountId, '账号已暂停使用');
    }
    return account;
  });
}

const activationRecords = `
  SELECT c.id, c.code_hint AS "codeHint", c.remark_name AS "remarkName", c.created_at AS "createdAt",
    c.revoked_at AS "revokedAt", c.redeemed_at AS "redeemedAt", c.redeemed_account_id AS "redeemedAccountId",
    a.remark_name AS "redeemedAccountRemark",
    CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked' WHEN c.redeemed_at IS NOT NULL THEN 'redeemed' ELSE 'unused' END AS status
  FROM dispatch.activation_codes c LEFT JOIN dispatch.accounts a ON a.id = c.redeemed_account_id
`;

export async function listActivationCodes(pool: Pool) {
  const { rows } = await pool.query(activationRecords + ' ORDER BY c.created_at DESC, c.id DESC');
  return { records: rows };
}

async function activationRecord(client: PoolClient, id: string) {
  return (await client.query(activationRecords + ' WHERE c.id = $1', [id])).rows[0];
}

export function issueActivationCode(pool: Pool, codes: ActivationCodes, body: Input) {
  const remarkName = inputText(body.remarkName, '配送员备注名', 40, true);
  const requestId = body.requestId === undefined ? null : inputText(body.requestId, '请求编号', 200, true);
  return transaction(pool, async client => {
    const { id, code } = await codes.issue(client, remarkName, requestId);
    return { code, record: await activationRecord(client, id) };
  });
}

export function revokeActivationCode(pool: Pool, codes: ActivationCodes, codeId: string, reissue: boolean) {
  return transaction(pool, async client => {
    const { rows: [entry] } = await client.query<{ remark_name: string; revoked_at: Date | null; redeemed_at: Date | null }>(`
      SELECT remark_name, revoked_at, redeemed_at FROM dispatch.activation_codes WHERE id = $1 FOR UPDATE
    `, [codeId]);
    if (!entry) throw new HttpError(404, 'activation_code_not_found', '未找到开通码');
    if (entry.revoked_at || entry.redeemed_at) throw new HttpError(409, 'activation_code_not_unused', '仅未使用的开通码可以作废');
    await client.query('UPDATE dispatch.activation_codes SET revoked_at = clock_timestamp() WHERE id = $1', [codeId]);
    if (!reissue) return { record: await activationRecord(client, codeId) };
    const { id, code } = await codes.issue(client, entry.remark_name, null);
    return { code, record: await activationRecord(client, id), revokedId: codeId };
  });
}

export function listCustomers(pool: Pool, accountId: string) {
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    const { customers, aliases } = await readDirectory(client, accountId);
    const { rows } = await client.query<{ id: string; lastDeliveredAt: Date; lastDeliveredAtBasis: string; deliveredTripCount: number }>(`
      SELECT s.party_id AS id, max(coalesce(s.delivery_completed_at, issued.saved_at)) AS "lastDeliveredAt",
        (array_agg(CASE WHEN s.delivery_completed_at IS NULL THEN 'trip_issued_at' ELSE 'delivery_completed_at' END
          ORDER BY coalesce(s.delivery_completed_at, issued.saved_at) DESC, s.delivery_completed_at DESC NULLS LAST))[1] AS "lastDeliveredAtBasis",
        count(DISTINCT s.trip_id)::int AS "deliveredTripCount"
      FROM dispatch.sheets s JOIN dispatch.trip_versions issued
        ON issued.account_id = s.account_id AND issued.trip_id = s.trip_id AND issued.version = 1
      WHERE s.account_id = $1 AND s.delivery_completed GROUP BY s.party_id
    `, [accountId]);
    const activity = new Map(rows.map(row => [row.id, row]));
    return { customers: customers.map(customer => ({
      ...customer, aliases: aliases.filter(alias => alias.customerId === customer.id),
      lastDeliveredAt: activity.get(customer.id)?.lastDeliveredAt ?? null,
      lastDeliveredAtBasis: activity.get(customer.id)?.lastDeliveredAtBasis ?? null,
      deliveredTripCount: activity.get(customer.id)?.deliveredTripCount ?? 0,
    })) };
  });
}

export function customerPrices(pool: Pool, accountId: string, customerId: string) {
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    if (!(await client.query('SELECT 1 FROM dispatch.parties WHERE account_id = $1 AND id = $2', [accountId, customerId])).rowCount) {
      throw new HttpError(404, 'customer_not_found', '未找到本账号的客户');
    }
    const sales = (await readHistoricalSales(client, accountId, [customerId])).filter(row => row.deliveryCompleted === true)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || b.tripId.localeCompare(a.tripId) || a.linePosition - b.linePosition)
      .slice(0, 500);
    return { customerId, sales };
  });
}

export function changeCustomerAlias(pool: Pool, accountId: string, body: Input, remove: boolean) {
  const customerId = requireId(body.customerId, '客户编号');
  const alias = inputText(body.alias, '客户简称', 200, true);
  const normalizedAlias = normalizeMemoryText(alias);
  if (!normalizedAlias || Buffer.byteLength(normalizedAlias) > 800) invalidInput('请输入有效的客户简称');
  for (const flag of ['allowRebind', 'allowCanonicalConflict']) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') invalidInput(`${flag} 须为布尔值`);
  }
  return transaction(pool, async client => {
    await setAccount(client, accountId);
    await requireAccount(client, accountId);
    await readWorkspace(client, accountId, true);
    const customers = await readParties(client, accountId);
    if (!customers.some(customer => customer.id === customerId)) {
      throw new HttpError(404, 'customer_not_found', '未找到本账号的客户');
    }
    if (!remove) return writeAlias(client, accountId, { customerId, alias, normalizedAlias,
      allowRebind: body.allowRebind === true, allowCanonicalConflict: body.allowCanonicalConflict === true }, customers);
    const { rows: [removed] } = await client.query(`
      DELETE FROM dispatch.customer_aliases WHERE account_id = $1 AND normalized_alias = $2 AND customer_id = $3
      RETURNING customer_id AS "customerId", alias, normalized_alias AS "normalizedAlias"
    `, [accountId, normalizedAlias, customerId]);
    if (!removed && (await client.query(`
      SELECT 1 FROM dispatch.customer_aliases WHERE account_id = $1 AND normalized_alias = $2
    `, [accountId, normalizedAlias])).rowCount) {
      throw new HttpError(409, 'customer_alias_conflict', '该简称已关联其他客户，请刷新后核对');
    }
    return { removed: removed ?? null };
  });
}
