import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { databaseOptions, transaction } from './database';

export async function migrate(pool: Pool): Promise<void> {
  const directory = resolve(__dirname, '../../server/migrations');
  const files = (await readdir(directory)).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(71693, 1)');
    await client.query('CREATE SCHEMA IF NOT EXISTS dispatch');
    await client.query(`CREATE TABLE IF NOT EXISTS dispatch.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ name: string }>('SELECT name FROM dispatch.schema_migrations');
    const known = new Set(applied.rows.map(row => row.name));
    for (const file of files) {
      if (known.has(file)) continue;
      await client.query(await readFile(join(directory, file), 'utf8'));
      await client.query('INSERT INTO dispatch.schema_migrations (name) VALUES ($1)', [file]);
    }
  });
}

async function main() {
  const pool = new Pool(databaseOptions('DISPATCH_DB_ADMIN_URL'));
  try {
    await migrate(pool);
    console.log('PostgreSQL 迁移已完成');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
