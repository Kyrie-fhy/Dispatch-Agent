const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { rootCertificates } = require('node:tls');
const { test } = require('node:test');
const { Client } = require('pg');
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
  assert.throws(() => databaseOptions(variable, { ...trial, [variable]: url + '#fragment' }), /TLS/);
  assert.deepEqual(databaseOptions(variable, { [variable]: 'postgresql://localhost/dispatch?sslmode=disable' }),
    { connectionString: 'postgresql://localhost/dispatch?sslmode=disable', connectionTimeoutMillis: 5000 });
});

test('trial loopback permits plaintext only without a configured CA', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-trial-ca-'));
  t.after(() => rmSync(directory, { recursive: true }));
  const caFile = join(directory, 'ca.pem');
  const ca = rootCertificates[0];
  const options = (url, extra = {}) => databaseOptions('DISPATCH_DB_URL', {
    DISPATCH_SERVER_MODE: 'trial', DISPATCH_DB_URL: url, ...extra,
  });

  for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
    const url = `postgresql://dispatch_trial_api:example@${hostname}:5432/dispatch_trial`;
    assert.equal(new Client(options(url)).ssl, false);
    assert.equal(new Client(options(url + '?sslmode=disable')).ssl, false);
    assert.throws(() => options(`postgresql://${hostname}/dispatch_trial`), /账号和库名/);
    assert.throws(() => options(`postgresql://dispatch_trial_api@${hostname}/`), /账号和库名/);
    for (const suffix of ['?', '?sslmode=require', '?sslmode=disable&sslmode=disable', '?sslmode=disable&host=other', '#', '#fragment']) {
      assert.throws(() => options(url + suffix), /TLS/);
    }
  }

  const url = 'postgresql://dispatch_trial_api@127.0.0.1/dispatch_trial?sslmode=disable';
  const withCA = { DISPATCH_DB_CA_FILE: caFile };
  assert.throws(() => options(url, { DISPATCH_DB_CA_FILE: '' }), /DISPATCH_DB_CA_FILE/);
  assert.throws(() => options(url, withCA), { code: 'ENOENT' });
  writeFileSync(caFile, ' \n');
  assert.throws(() => options(url, withCA), /无 CA 证书/);
  writeFileSync(caFile, ca);
  assert.deepEqual(new Client(options(url, withCA)).ssl, { ca, rejectUnauthorized: true });
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
