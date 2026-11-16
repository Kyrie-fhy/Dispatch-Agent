import { Pool, PoolClient } from 'pg';

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

export async function setAccount(client: PoolClient, accountId: string): Promise<void> {
  await client.query("SELECT set_config('dispatch.account_id', $1, true)", [accountId]);
}

export async function requireApplicationRole(pool: Pool): Promise<void> {
  const { rows: [role] } = await pool.query<{ permitted: boolean }>(`
    SELECT pg_has_role(current_user, 'dispatch_app', 'USAGE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_roles r
        WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole)
          AND pg_has_role(current_user, r.oid, 'MEMBER')
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'dispatch' AND c.relkind = 'r'
          AND pg_has_role(current_user, c.relowner, 'MEMBER')
      ) AS permitted
  `);
  if (!role.permitted) throw new Error('请使用已授予 dispatch_app 的非管理员数据库账号启动服务');
}

export function localDatabaseUrl(variable: string): string {
  const value = process.env[variable];
  if (!value) throw new Error(`请设置 ${variable}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} 需要是 PostgreSQL 连接网址`);
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || [...url.searchParams.keys()].some(key => key !== 'sslmode')) {
    throw new Error(`${variable} 必须指向本机 PostgreSQL`);
  }
  return value;
}
