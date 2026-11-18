const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { rootCertificates } = require('node:tls');
const { test } = require('node:test');
const { databaseOptions } = require('../../code/server-dist/server/database');

test('non-loopback database requires explicit trial mode and verified TLS', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-trial-ca-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const ca = rootCertificates[0];
  const caFile = join(directory, 'ca.pem');

  const variable = 'DISPATCH_DB_URL';
  const url = 'postgresql://dispatch_trial_api:example@postgres.internal:5432/dispatch_trial';
  const env = { [variable]: url };
  assert.throws(() => databaseOptions(variable, env), /本机 PostgreSQL/);
  assert.throws(() => databaseOptions(variable, { ...env, DISPATCH_SERVER_MODE: 'invalid' }), /local 或 trial/);

  const trial = { ...env, DISPATCH_SERVER_MODE: 'trial' };
  assert.throws(() => databaseOptions(variable, trial), /DISPATCH_DB_CA_FILE/);
  trial.DISPATCH_DB_CA_FILE = caFile;
  writeFileSync(caFile, '');
  assert.throws(() => databaseOptions(variable, trial), /无 CA 证书/);
  writeFileSync(caFile, ca);
  assert.deepEqual(databaseOptions(variable, trial).ssl, { ca, rejectUnauthorized: true });
  assert.throws(() => databaseOptions(variable, { ...trial, [variable]: url + '?sslmode=disable' }), /TLS/);
  assert.throws(() => databaseOptions(variable, { ...trial, [variable]: url + '?host=elsewhere' }), /TLS/);
  assert.deepEqual(databaseOptions(variable, { [variable]: 'postgresql://localhost/dispatch?sslmode=disable' }),
    { connectionString: 'postgresql://localhost/dispatch?sslmode=disable', connectionTimeoutMillis: 5000 });
});

test('trial API startup fails closed without WeChat configuration', () => {
  const entry = resolve(__dirname, '../../code/server-dist/server/main.js');
  const result = spawnSync(process.execPath, [entry], {
    env: { DISPATCH_SERVER_MODE: 'trial' }, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /试用环境必须配置微信登录/);
});
