import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { HttpError } from './http-error';

const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const codePattern = new RegExp('^[' + alphabet + ']{8}$');

export function configuredActivation(env: NodeJS.ProcessEnv) {
  const flag = env.DISPATCH_REQUIRE_ACTIVATION?.trim().toLowerCase();
  return {
    requireActivation: flag === '1' || flag === 'true' ||
      (env.DISPATCH_SERVER_MODE === 'trial' && flag !== '0' && flag !== 'false'),
    activationPepper: env.DISPATCH_ACTIVATION_PEPPER?.trim() || env.DISPATCH_ADMIN_TOKEN?.trim(),
  };
}

export function invalidActivationCode() {
  return new HttpError(403, 'invalid_activation_code', '开通码无效或已被使用，请联系管理员核对');
}

export class ActivationCodes {
  private windowEnd = 0;
  private total = 0;
  private readonly attempts = new Map<string, number>();

  constructor(private readonly pepper = 'dispatch-local-activation-v1') {}

  private digest(code: string) {
    return createHmac('sha256', this.pepper).update(code).digest();
  }

  async unusedForRedemption(client: PoolClient, subject: string, input: string) {
    const now = Date.now();
    if (now >= this.windowEnd) {
      this.windowEnd = now + 60_000;
      this.total = 0;
      this.attempts.clear();
    }
    const count = this.attempts.get(subject) ?? 0;
    if (count >= 8 || this.total >= 120) {
      throw new HttpError(429, 'activation_rate_limited', '开通尝试过于频繁，请稍后再试');
    }
    this.attempts.set(subject, count + 1);
    this.total++;
    const compact = input.length <= 128 ? input.replace(/[\s-]/gu, '').toUpperCase() : '';
    const normalized = compact.length === 10 && compact.startsWith('DZ') ? compact.slice(2) : compact;
    if (!codePattern.test(normalized)) throw invalidActivationCode();
    const { rows: [record] } = await client.query<{ id: string; remark_name: string }>(`
      SELECT id, remark_name FROM dispatch.activation_codes
      WHERE code_digest = $1 AND revoked_at IS NULL AND redeemed_at IS NULL FOR UPDATE
    `, [this.digest(normalized)]);
    if (!record) throw invalidActivationCode();
    return record;
  }

  async issue(client: PoolClient, remarkName: string, requestId: string | null) {
    // The digest and request ID both have unique constraints. A collision generates fresh randomness.
    for (let attempt = 0; attempt < 5; attempt++) {
      const value = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
      const id = randomUUID();
      const suffix = value.slice(4);
      const result = await client.query(`
        INSERT INTO dispatch.activation_codes (id, code_digest, code_hint, remark_name, request_id)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING
      `, [id, this.digest(value), 'DZ-****-' + suffix, remarkName, requestId]);
      if (result.rowCount) return { id, code: 'DZ-' + value.slice(0, 4) + '-' + suffix };
      if (requestId) {
        const { rows: [previous] } = await client.query<{ id: string; remark_name: string }>(
          'SELECT id, remark_name FROM dispatch.activation_codes WHERE request_id = $1', [requestId]);
        if (previous) {
          if (previous.remark_name !== remarkName) {
            throw new HttpError(409, 'request_conflict', '同一请求编号已用于其他开通码');
          }
          return { id: previous.id, code: null };
        }
      }
    }
    throw new HttpError(503, 'activation_issue_failed', '暂时无法生成开通码，请重试');
  }
}
