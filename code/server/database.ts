import { readFileSync } from 'node:fs';
import { Pool, PoolClient, PoolConfig } from 'pg';

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

export function trialMode(env = process.env): boolean {
  const mode = env.DISPATCH_SERVER_MODE;
  if (mode === undefined || mode === 'local') return false;
  if (mode === 'trial') return true;
  throw new Error('DISPATCH_SERVER_MODE 须为 local 或 trial');
}

export function databaseOptions(variable: string, env = process.env): PoolConfig {
  const trial = trialMode(env);
  const value = env[variable];
  if (!value) throw new Error(`请设置 ${variable}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} 需要是 PostgreSQL 连接网址`);
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) {
    throw new Error(`${variable} 需要是 PostgreSQL 连接网址`);
  }
  const base = { connectionString: value, connectionTimeoutMillis: 5000 };
  if (!trial) {
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        && [...url.searchParams.keys()].every(key => key === 'sslmode')) return base;
    throw new Error(`${variable} 必须指向本机 PostgreSQL`);
  }

  if (!url.hostname || !url.username || url.pathname.length < 2 || url.search || url.hash) {
    throw new Error(`${variable} 须包含数据库地址、账号和库名，TLS 由 DISPATCH_DB_CA_FILE 配置`);
  }
  const caFile = env.DISPATCH_DB_CA_FILE;
  if (!caFile) throw new Error('试用环境请设置 DISPATCH_DB_CA_FILE');
  return { ...base, ssl: { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true } };
}
