import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { CatalogStore } from './catalog';
import { databaseOptions } from './database';

async function main(args: string[]) {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--account', '--file'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options.has(args[i])) {
      throw new Error('用法：npm run catalog:import -- --account <uuid|dev:subject> --file <csv路径>');
    }
    options.set(args[i], args[i + 1]);
  }
  const account = options.get('--account');
  const file = options.get('--file');
  if (!account || !file) throw new Error('请提供 --account <uuid|dev:subject> 与 --file <csv路径>');
  const csv = await readFile(file);
  const pool = new Pool(databaseOptions('DISPATCH_DB_ADMIN_URL'));
  try {
    console.log(JSON.stringify(await new CatalogStore(pool).importCsv(account, csv)));
  } finally {
    await pool.end();
  }
}

void main(process.argv.slice(2)).catch(error => {
  const safe = error instanceof Error && !('code' in error);
  console.error(safe ? error.message : '读取货品 CSV 或写入数据库失败，请检查文件及管理员连接配置');
  process.exitCode = 1;
});
