const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { readdir, readFile } = require('node:fs/promises');
const { setTimeout: pause } = require('node:timers/promises');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { Pool } = require('pg');
const { catalogCsvColumns, parseCatalogCsv } = require('../../code/server-dist/miniprogram/core/catalog');
const { emptyTrip } = require('../../code/server-dist/miniprogram/core/trips');
const { businessSession, lockAccountActivity, writeAccount } = require('../../code/server-dist/server/account-workspace');
const { configuredActivation } = require('../../code/server-dist/server/activation');
const { handleAdmin } = require('../../code/server-dist/server/admin');
const { AgentStore } = require('../../code/server-dist/server/agent/store');
const { CatalogStore } = require('../../code/server-dist/server/catalog');
const { setAccount, transaction } = require('../../code/server-dist/server/database');
const { DraftStore } = require('../../code/server-dist/server/drafts');
const { startLocalServer } = require('../../code/server-dist/server/main');
const { MaterialStore } = require('../../code/server-dist/server/materials');
const { migrate } = require('../../code/server-dist/server/migrate');
const { adminDataScript } = require('../../code/server-dist/server/admin/page-data');
const { adminOpsScript } = require('../../code/server-dist/server/admin/page-ops');
const { adminShellHtml, adminShellScript } = require('../../code/server-dist/server/admin/page-shell');

const adminToken = 'test-admin-v2-isolated-secret';
const appId = 'wx0123456789abcdef';
const legacyToken = 'A'.repeat(43);
const apiPrefix = '/admin/api';
const formalTables = ['trips', 'trip_versions', 'sheets', 'trip_previews', 'workspaces'];
const sha256 = value => createHash('sha256').update(value).digest();

function asCsv(rows) {
  return [catalogCsvColumns, ...rows].map(row => row.map(value => '"' + value.replace(/"/g, '""') + '"').join(',')).join('\r\n');
}

const baseRow = ['FISH', '500', '冻品', '原安井鱼豆腐', '安井', '鱼豆腐', '500g', '单规格', '箱', '19.80',
  '在售', '已核实', '别名「鱼腐」'];
const secondRow = ['RICE', '1', '主食', '糯米团', '', '糯米团', '1kg', '单规格', '', '9.90', '在售', '', ''];

async function isolatedDatabase(t) {
  const url = new URL(process.env.DISPATCH_TEST_ADMIN_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.notEqual(url.pathname, '/dispatch_local');
  const name = 'dispatch_test_' + randomBytes(8).toString('hex');
  const password = randomBytes(24).toString('hex');
  const admin = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  let owner;
  let app;
  t.after(async () => {
    try {
      await app?.end();
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
    } finally {
      await admin.end();
    }
  });
  try {
    await admin.query('CREATE ROLE dispatch_app NOLOGIN');
  } catch (error) {
    if (error.code !== '42710' && error.constraint !== 'pg_authid_rolname_index') throw error;
  }
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
  await admin.query(`GRANT dispatch_app TO ${name}`);
  url.pathname = '/' + name;
  owner = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const directory = new URL('../../code/server/migrations/', pathToFileURL(__filename));
  const files = (await readdir(directory)).filter(file => /^0(?:0[1-9]|1[0-2])_/.test(file)).sort();
  const legacyAccount = randomUUID();
  const legacyDraft = emptyTrip(randomUUID);
  await transaction(owner, async client => {
    await client.query('CREATE SCHEMA dispatch');
    await client.query(`CREATE TABLE dispatch.schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const file of files) {
      await client.query(await readFile(new URL(file, directory), 'utf8'));
      await client.query('INSERT INTO dispatch.schema_migrations (name) VALUES ($1)', [file]);
    }
    await client.query("INSERT INTO dispatch.accounts (id, identity_provider, identity_subject) VALUES ($1, 'wechat', $2)",
      [legacyAccount, appId + ':legacy']);
    await client.query('INSERT INTO dispatch.workspaces (account_id, draft_id, draft_customers) VALUES ($1,$2,$3)',
      [legacyAccount, legacyDraft.id, JSON.stringify(legacyDraft.customers)]);
    await client.query("INSERT INTO dispatch.sessions VALUES ($1, $2, now() + interval '1 hour')", [sha256(legacyToken), legacyAccount]);
  });
  await migrate(owner);
  url.username = name;
  url.password = password;
  app = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  return { owner, app, legacyAccount };
}

async function start(db, wechat, options) {
  // The parallel catalog test file may already be using DISPATCH_API_PORT.
  const server = await startLocalServer(db.app, 0, wechat, undefined, undefined, undefined, undefined, undefined, undefined,
    adminToken, undefined, options);
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
    const response = await fetch(origin + path, { method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, raw,
      data: raw.length && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw.toString('utf8')) : raw.toString('utf8') };
  };
  return {
    origin, request,
    admin: (path, method = 'GET', body, headers) => request(apiPrefix + path, { method, token: adminToken, body, headers }),
    login: (code, activationCode) => request('/v1/session/wechat', { method: 'POST', body: { code, activationCode } }),
    async stop() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      await closed;
    },
  };
}

function expect(response, status = 200, error) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  if (error) assert.equal(response.data.error, error);
  return response.data;
}

function issue(api, remarkName, requestId) {
  return api.admin('/activation-codes', 'POST', { remarkName, requestId }).then(response => expect(response));
}

async function waitForAdvisoryWaiter(owner, mode) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const { rowCount } = await owner.query(`SELECT 1 FROM pg_locks
      WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND locktype = 'advisory' AND NOT granted AND mode = $1`, [mode]);
    if (rowCount) return;
    await pause(25);
  }
  assert.fail('Timed out waiting for advisory lock mode ' + mode);
}

async function protectFormalTables(owner) {
  await owner.query(`CREATE FUNCTION dispatch.reject_admin_formal_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'admin cannot write %', TG_TABLE_NAME; END $$`);
  for (const table of formalTables) {
    await owner.query(`CREATE TRIGGER reject_admin_formal_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON dispatch.${table}
      FOR EACH STATEMENT EXECUTE FUNCTION dispatch.reject_admin_formal_write()`);
  }
}

/* ============ 后台页面离线事件模拟（最小 DOM + fetch） ============ */

const adminHtmlEntities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const adminDecodeHtml = value => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, code) => adminHtmlEntities[code]);

function adminAttrSelector(node, name, expected) {
  if (!node.hasAttribute(name)) return false;
  return expected === undefined || node.getAttribute(name) === expected;
}

function adminMatchesSimple(node, rawSelector) {
  if (!node || node.nodeType !== 1) return false;
  for (const part of rawSelector.split(',').map(value => value.trim()).filter(Boolean)) {
    let rest = part;
    let matched = true;
    const tag = rest.match(/^[a-zA-Z][\w-]*/);
    if (tag) {
      matched = node.tagName === tag[0].toUpperCase();
      rest = rest.slice(tag[0].length);
    }
    for (const attr of rest.matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g)) {
      const expected = attr[2] ?? attr[3] ?? attr[4];
      matched = matched && adminAttrSelector(node, attr[1], expected);
    }
    for (const id of rest.matchAll(/#([\w-]+)/g)) {
      matched = matched && node.getAttribute('id') === id[1];
    }
    for (const cls of rest.matchAll(/\.([\w-]+)/g)) {
      matched = matched && node.classList.contains(cls[1]);
    }
    if (rest.includes(':checked')) matched = matched && (node.checked === true || node.hasAttribute('checked'));
    if (matched) return true;
  }
  return false;
}

function adminSelectorParts(selector) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const ch of selector) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (current) { parts.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

class AdminClassList {
  constructor(node) { this.node = node; }
  values() { return new Set(String(this.node.getAttribute('class') || '').split(/\s+/).filter(Boolean)); }
  write(values) { this.node.setAttribute('class', [...values].join(' ')); }
  add(name) { const values = this.values(); values.add(name); this.write(values); }
  remove(name) { const values = this.values(); values.delete(name); this.write(values); }
  contains(name) { return this.values().has(name); }
  toggle(name, force) {
    const values = this.values();
    const enabled = force === undefined ? !values.has(name) : Boolean(force);
    if (enabled) values.add(name); else values.delete(name);
    this.write(values);
    return enabled;
  }
}

class AdminNode {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = {};
    this.childNodes = [];
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.style = {};
    this.classList = new AdminClassList(this);
    this._value = undefined;
    this._checked = undefined;
    this._textContent = null;
    this._innerHTML = '';
  }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get isConnected() {
    let node = this;
    while (node) { if (node === this.ownerDocument.body) return true; node = node.parentNode; }
    return false;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() {
    if (this._textContent !== null) return this._textContent;
    return this.childNodes.map(node => typeof node === 'string' ? node : node.textContent).join('');
  }
  set textContent(value) {
    this._textContent = String(value);
    this.childNodes = [];
    this.children = [];
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = String(value === null || value === undefined ? '' : value);
    this._textContent = null;
    this.childNodes = [];
    this.children = [];
    for (const node of parseAdminHtml(this._innerHTML, this.ownerDocument)) this.appendChild(node);
  }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const options = this.querySelectorAll('option');
      const selected = options.find(option => option.hasAttribute('selected')) || options[0];
      return selected ? (selected.getAttribute('value') ?? selected.textContent.trim()) : '';
    }
    if (this.hasAttribute('value')) return this.getAttribute('value');
    if (this.tagName === 'TEXTAREA') return this.textContent;
    return '';
  }
  set value(value) { this._value = String(value); }
  get checked() {
    if (this._checked !== undefined) return this._checked;
    return this.hasAttribute('checked');
  }
  set checked(value) { this._checked = Boolean(value); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  appendChild(node) {
    if (typeof node === 'string') node = node;
    if (typeof node !== 'string') {
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
    }
    this._textContent = null;
    this.childNodes.push(node);
    if (typeof node !== 'string') this.children.push(node);
    return node;
  }
  removeChild(node) {
    this.childNodes = this.childNodes.filter(child => child !== node);
    if (typeof node !== 'string') this.children = this.children.filter(child => child !== node);
    if (typeof node !== 'string' && node.parentNode === this) node.parentNode = null;
    return node;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] || []).filter(item => item !== listener);
  }
  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (adminMatchesSimple(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  matches(selector) { return adminMatchesSimple(this, selector); }
  querySelectorAll(selector) {
    const parts = adminSelectorParts(selector);
    if (!parts.length) return [];
    let search = [this];
    let found = [];
    for (const part of parts) {
      found = [];
      const seen = new Set();
      for (const root of search) {
        const candidates = [root, ...adminDescendants(root)];
        for (const candidate of candidates) {
          if (seen.has(candidate) || !adminMatchesSimple(candidate, part)) continue;
          seen.add(candidate);
          found.push(candidate);
        }
      }
      search = found;
    }
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {}
  select() {}
  click() { this.ownerDocument.__fire(this, 'click'); }
  scrollIntoView() {}
}

function adminDescendants(node) {
  const list = [];
  for (const child of node.children) {
    list.push(child);
    list.push(...adminDescendants(child));
  }
  return list;
}

function parseAdminHtml(html, document) {
  const voidTags = new Set(['BR', 'HR', 'IMG', 'INPUT', 'META', 'LINK']);
  const root = new AdminNode(document, 'template');
  const stack = [root];
  const source = String(html);
  const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
  let last = 0;
  let match;
  const addText = text => {
    if (!text) return;
    const value = adminDecodeHtml(text);
    stack[stack.length - 1].appendChild(value);
  };
  while ((match = tokenRe.exec(source))) {
    addText(source.slice(last, match.index));
    last = tokenRe.lastIndex;
    if (match[1]) {
      const tag = match[1].toUpperCase();
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].tagName === tag) { stack.length = index; break; }
      }
      continue;
    }
    if (!match[2]) continue;
    const node = new AdminNode(document, match[2]);
    const attrs = match[3] || '';
    for (const attr of attrs.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      node.setAttribute(attr[1], adminDecodeHtml(attr[2] ?? attr[3] ?? attr[4] ?? ''));
    }
    stack[stack.length - 1].appendChild(node);
    if (!voidTags.has(node.tagName) && match[4] !== '/') stack.push(node);
  }
  addText(source.slice(last));
  return root.childNodes;
}

function createAdminDocument() {
  const document = {
    listeners: {},
    createElement(tag) { return new AdminNode(document, tag); },
    getElementById(id) {
      const found = document.body.querySelector('#' + id);
      return found;
    },
    querySelector(selector) { return document.body.querySelector(selector); },
    querySelectorAll(selector) { return document.body.querySelectorAll(selector); },
    addEventListener(type, listener) { (document.listeners[type] ||= []).push(listener); },
    removeEventListener(type, listener) {
      document.listeners[type] = (document.listeners[type] || []).filter(item => item !== listener);
    },
    __fire(node, type, extra) {
      const event = { type, target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, ...extra };
      let current = node;
      while (current) {
        for (const listener of (current.listeners?.[type] || []).slice()) listener.call(current, event);
        current = current.parentNode;
      }
      for (const listener of (document.listeners[type] || []).slice()) listener.call(document, event);
    },
  };
  document.body = new AdminNode(document, 'body');
  return document;
}

const adminJson = (status, data) => ({
  status,
  ok: status >= 200 && status < 300,
  text: () => Promise.resolve(data === undefined ? '' : JSON.stringify(data)),
  blob: () => Promise.resolve(new Blob([JSON.stringify(data ?? null)])),
});

const adminFlush = async (rounds = 20) => {
  for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve));
};

const adminAccounts = [
  { id: 'A', remarkName: '甲配送', disabled: false, missingUnitCount: 0, openMistakeCount: 0 },
  { id: 'B', remarkName: '乙配送', disabled: false, missingUnitCount: 0, openMistakeCount: 0 },
];

function adminCatalogFixture(overrides = {}) {
  return {
    catalogRevision: 7,
    importedAt: '2026-10-01T10:00:00Z',
    categories: ['冻品'],
    summary: { productCount: 1, variantCount: 1, activeVariantCount: 1, discontinuedVariantCount: 0, missingUnitVariantCount: 0 },
    items: [{
      productId: 'p-fish', variantId: 'v-fish', product: '鱼豆腐', brand: '安井', category: '冻品',
      packaging: '袋装', flavorOrGrade: '原味', specification: '500g', unit: '箱', priceCents: 1980,
      status: 'active', aliases: ['鱼豆腐', '鱼腐'], brandAliases: ['安井', '安景'],
      productCode: 'FISH', variantCode: 'V001',
    }],
    ...overrides,
  };
}

function createAdminHarness(options = {}) {
  const document = createAdminDocument();
  document.body.innerHTML = adminShellHtml;
  const calls = [];
  const catalog = options.catalog || adminCatalogFixture();
  const records = options.records || [];
  const fallback = call => {
    const path = call.url.replace('/admin/api', '');
    if (path === '/accounts') return adminJson(200, { accounts: adminAccounts });
    if (path === '/system/status') return adminJson(200, { database: { reachable: true }, wechat: {}, models: {} });
    if (path === '/activation-codes') return adminJson(200, { records });
    if (path === '/prompts') return adminJson(200, { prompts: [] });
    if (/^\/accounts\/[^/]+\/dashboard$/.test(path)) {
      return adminJson(200, { pulse: {}, todos: {}, ai7d: {} });
    }
    if (/^\/accounts\/[^/]+\/catalog$/.test(path)) return adminJson(200, catalog);
    if (/^\/accounts\/[^/]+\/customers$/.test(path)) return adminJson(200, { customers: [] });
    if (/^\/accounts\/[^/]+\/quality-turns/.test(path)) return adminJson(200, { turns: [] });
    if (/^\/accounts\/[^/]+\/mistakes/.test(path)) return adminJson(200, { mistakes: [] });
    return adminJson(200, { catalogRevision: catalog.catalogRevision + 1, item: catalog.items[0] });
  };
  const fetch = (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    let response;
    try { response = options.handler ? options.handler(call, calls) : undefined; }
    catch (error) { response = Promise.reject(error); }
    return Promise.resolve(response === undefined ? fallback(call) : response);
  };
  const storage = new Map();
  const sandbox = {
    document,
    sessionStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    fetch,
    navigator: {},
    URL: { createObjectURL: () => 'blob:admin', revokeObjectURL() {} },
    ...(options.FileReader ? { FileReader: options.FileReader } : {}),
    console,
    setTimeout: (callback, delay) => (delay >= 1000 ? 0 : setTimeout(callback, 0)),
    clearTimeout,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const script of [adminShellScript, adminOpsScript, adminDataScript]) {
    new vm.Script(script).runInContext(context);
  }
  const App = sandbox.__dispatchAdmin;
  assert.ok(App, '后台脚本应挂载 window.__dispatchAdmin');
  const fire = (node, type, extra) => {
    assert.ok(node, '事件目标节点应存在');
    document.__fire(node, type, extra);
  };
  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 100; index++) {
      if (predicate()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Timed out waiting for ' + label);
  };
  const openSection = async section => {
    sandbox.sessionStorage.setItem('dispatchAdminToken', 'test-admin-token');
    App.state.token = 'test-admin-token';
    await App.loadAccounts();
    App.navigate(section);
    await adminFlush();
  };
  return { document, App, calls, fire, waitFor, openSection, catalog };
}


async function addTurn(owner, accountId, draft, { status = 'completed', text = '', events = [], timestamp = new Date(), undone = false } = {}) {
  const id = randomUUID();
  await owner.query(`INSERT INTO dispatch.agent_turns
    (account_id,id,draft_id,start_revision,end_revision,before_customers,status,created_at,undone)
    VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8)`, [accountId, id, draft.id, draft.revision, JSON.stringify(draft.customers), status, timestamp, undone]);
  await owner.query(`INSERT INTO dispatch.agent_messages (account_id,turn_id,role,content)
    SELECT $1, $2, role, $3 FROM unnest($4::text[]) role`,
  [accountId, id, text, status === 'running' ? ['user'] : ['user', 'assistant']]);
  for (const [kind, payload] of events) {
    await owner.query('INSERT INTO dispatch.agent_events (account_id,draft_id,turn_id,kind,payload) VALUES ($1,$2,$3,$4,$5)',
      [accountId, draft.id, id, kind, JSON.stringify(payload)]);
  }
  return id;
}

test('activation configuration preserves explicit local and trial choices', () => {
  assert.equal(configuredActivation({}).requireActivation, false);
  assert.equal(configuredActivation({ DISPATCH_REQUIRE_ACTIVATION: 'true' }).requireActivation, true);
  assert.equal(configuredActivation({ DISPATCH_SERVER_MODE: 'trial' }).requireActivation, true);
  assert.equal(configuredActivation({ DISPATCH_SERVER_MODE: 'trial', DISPATCH_REQUIRE_ACTIVATION: '0' }).requireActivation, false);
  assert.equal(configuredActivation({ DISPATCH_SERVER_MODE: 'trial', DISPATCH_REQUIRE_ACTIVATION: 'false' }).requireActivation, false);
  assert.equal(configuredActivation({ DISPATCH_ADMIN_TOKEN: 'fallback', DISPATCH_ACTIVATION_PEPPER: 'explicit' }).activationPepper, 'explicit');
});

test('admin v2 offline keeps existing product aliases when adding a variant and hides generated codes', async () => {
  const catalog = adminCatalogFixture();
  catalog.items.push({
    productId: 'p-manual', variantId: 'v-manual', product: '手工鱼丸', brand: '自制', category: '冻品',
    packaging: '', flavorOrGrade: '', specification: '500g', unit: '袋', priceCents: 1200,
    status: 'active', aliases: [], brandAliases: [],
    productCode: 'M-123e4567-e89b-12d3-a456-426614174000',
    variantCode: 'V-123e4567-e89b-12d3-a456-426614174000',
  });
  const harness = createAdminHarness({ catalog });
  await harness.openSection('catalog');
  await harness.waitFor(() => harness.document.querySelector('#catalogRows'), 'catalog rows');
  const rowsText = harness.document.querySelector('#catalogRows').textContent;
  assert.ok(rowsText.includes('手工建档'), '自动生成的货号应显示为手工建档');
  assert.equal(rowsText.includes('123e4567'), false, '列表不得暴露自动生成货号的完整 UUID');
  assert.ok(rowsText.includes('FISH / V001'), 'CSV 人类货号应照常展示');

  harness.fire(harness.document.querySelector('[data-catalog-add]'), 'click');
  const picker = harness.document.querySelector('#catalogEditorProduct');
  assert.equal(picker.value, '__new__');
  picker.value = 'p-fish';
  harness.fire(picker, 'change');
  assert.equal(harness.document.querySelector('#catAliases').value, '鱼豆腐、鱼腐');
  assert.equal(harness.document.querySelector('#catBrandAliases').value, '安井、安景');
  harness.document.querySelector('#catPrice').value = '20.00';
  harness.fire(harness.document.querySelector('#modalRoot [data-modal-confirm]'), 'click');
  await harness.waitFor(() => harness.calls.some(call => call.method === 'POST' && call.url.endsWith('/catalog/items')),
    'new variant request');
  const posted = harness.calls.find(call => call.method === 'POST' && call.url.endsWith('/catalog/items'));
  assert.equal(posted.url, '/admin/api/accounts/A/catalog/items');
  assert.equal(posted.body.productId, 'p-fish');
  assert.equal(posted.body.priceCents, 2000);
  assert.equal('aliases' in posted.body, false, '未改别名时不得发送清空数组');
  assert.equal('brandAliases' in posted.body, false, '未改品牌别名时不得发送清空数组');
});

test('admin v2 offline closes account-scoped modals when the viewed courier changes', async () => {
  const harness = createAdminHarness({ catalog: adminCatalogFixture() });
  await harness.openSection('catalog');
  await harness.waitFor(() => harness.document.querySelector('#catalogRows'), 'catalog rows');
  harness.fire(harness.document.querySelector('[data-catalog-add]'), 'click');
  const staleConfirm = harness.document.querySelector('#modalRoot [data-modal-confirm]');
  assert.ok(staleConfirm);
  const select = harness.document.querySelector('#accountSelect');
  select.value = 'B';
  harness.fire(select, 'change');
  await harness.waitFor(() => harness.App.state.accountId === 'B' && harness.document.querySelector('#catalogRows'),
    'courier B catalog');
  const modal = harness.document.querySelector('#modalRoot');
  assert.equal(modal.classList.contains('hidden'), true, '切换配送员后弹窗必须关闭');
  assert.equal(modal.innerHTML, '');
  harness.fire(staleConfirm, 'click');
  await adminFlush(30);
  assert.equal(harness.calls.some(call => call.method === 'POST' && call.url.includes('/accounts/B/')), false,
    '原账号弹窗的旧确认不得写到新账号');
});

test('admin v2 offline ignores a late test-query reply from the previous courier', async () => {
  let releaseA;
  const harness = createAdminHarness({
    catalog: adminCatalogFixture(),
    handler(call) {
      if (call.method === 'POST' && call.url === '/admin/api/accounts/A/catalog/test-query') {
        return new Promise(resolve => {
          releaseA = () => resolve(adminJson(200, { status: 'active', priceCents: 111, priceSource: 'catalog',
            item: null, candidates: [], reason: 'A-only' }));
        });
      }
      if (call.method === 'POST' && call.url === '/admin/api/accounts/B/catalog/test-query') {
        return adminJson(200, { status: 'active', priceCents: 222, priceSource: 'catalog',
          item: null, candidates: [], reason: 'B-only' });
      }
      return undefined;
    },
  });
  await harness.openSection('catalog');
  await harness.waitFor(() => harness.document.querySelector('[data-catalog-query]'), 'catalog query button');
  harness.document.querySelector('#catalog-query-text').value = '安井鱼豆腐500g 2箱';
  harness.fire(harness.document.querySelector('[data-catalog-query]'), 'click');
  await harness.waitFor(() => Boolean(releaseA), 'pending A query');
  const select = harness.document.querySelector('#accountSelect');
  select.value = 'B';
  harness.fire(select, 'change');
  await harness.waitFor(() => harness.App.state.accountId === 'B' && harness.document.querySelector('#catalogRows'),
    'courier B catalog');
  releaseA();
  await adminFlush(30);
  const box = harness.document.querySelector('#catalog-query-result');
  assert.equal(box.textContent.includes('A-only'), false, 'A 的迟到回包不得渲染到 B 页面');
  assert.equal(box.textContent.includes('1.11'), false, 'A 的价格不得出现在 B 页面');
  harness.document.querySelector('#catalog-query-text').value = '乙店查询';
  harness.fire(harness.document.querySelector('[data-catalog-query]'), 'click');
  await harness.waitFor(() => box.textContent.includes('B-only'), 'courier B query result');
});

test('admin v2 offline edits a large safe-integer price without dropping one cent', async () => {
  const catalog = adminCatalogFixture();
  catalog.items.push({
    productId: 'p-big', variantId: 'v-big', product: '大额货品', brand: '测试', category: '冻品',
    packaging: '', flavorOrGrade: '', specification: '1件', unit: '件', priceCents: 9007199254740982,
    status: 'active', aliases: [], brandAliases: [], productCode: 'BIG', variantCode: 'BIG-1',
  });
  const harness = createAdminHarness({ catalog });
  await harness.openSection('catalog');
  await harness.waitFor(() => harness.document.querySelector('[data-catalog-edit="v-big"]'), 'big price edit button');
  assert.equal(harness.App.centsToYuan(9007199254740982), '90071992547409.82');
  harness.fire(harness.document.querySelector('[data-catalog-edit="v-big"]'), 'click');
  assert.equal(harness.document.querySelector('#catPrice').value, '90071992547409.82');
  harness.fire(harness.document.querySelector('#modalRoot [data-modal-confirm]'), 'click');
  await harness.waitFor(() => harness.calls.some(call => call.method === 'PATCH' && call.url.endsWith('/catalog/variants/v-big')),
    'big price PATCH');
  const patched = harness.calls.find(call => call.method === 'PATCH' && call.url.endsWith('/catalog/variants/v-big'));
  assert.equal(patched.body.priceCents, 9007199254740982);
});

test('admin v2 offline keeps the reissued one-time code modal open', async () => {
  let reissued = false;
  const first = { id: 'c1', remarkName: '甲配送', status: 'unused', codeHint: 'DZ-****', createdAt: '2026-10-01T10:00:00Z' };
  const second = { id: 'c2', remarkName: '甲配送', status: 'unused', codeHint: 'DZ-****', createdAt: '2026-10-01T10:05:00Z' };
  const harness = createAdminHarness({
    records: [first],
    handler(call) {
      if (call.method === 'GET' && call.url.endsWith('/activation-codes')) {
        return adminJson(200, { records: reissued ? [second] : [first] });
      }
      if (call.method === 'POST' && call.url.endsWith('/activation-codes/c1/reissue')) {
        reissued = true;
        return adminJson(200, { revokedId: 'c1', code: 'DZ-AAAA-BBBB', record: second });
      }
      return undefined;
    },
  });
  await harness.openSection('accounts');
  await harness.waitFor(() => harness.document.querySelector('[data-code-reissue="c1"]'), 'reissue button');
  harness.fire(harness.document.querySelector('[data-code-reissue="c1"]'), 'click');
  assert.ok(harness.document.querySelector('#modalRoot [data-modal-confirm]'));
  harness.fire(harness.document.querySelector('#modalRoot [data-modal-confirm]'), 'click');
  await harness.waitFor(() => harness.document.querySelector('#modalRoot').textContent.includes('DZ-AAAA-BBBB'),
    'new one-time code');
  await adminFlush(30);
  const modal = harness.document.querySelector('#modalRoot');
  assert.equal(modal.classList.contains('hidden'), false, '旧确认流程不得关闭新码弹窗');
  assert.ok(modal.textContent.includes('一次性开通码已生成'));
});

test('admin v2 offline drops a late CSV FileReader callback from a previous courier modal', async () => {
  const readers = [];
  class FakeFileReader {
    readAsText(file) {
      this.file = file;
      readers.push(this);
    }
  }
  const harness = createAdminHarness({
    catalog: adminCatalogFixture(),
    FileReader: FakeFileReader,
    handler(call) {
      if (call.method === 'POST' && call.url.endsWith('/catalog/import/preview')) {
        return adminJson(200, {
          valid: true, mode: 'incremental', previewToken: 'tok-' + call.body.csv.slice(0, 6),
          addedProducts: 0, addedVariants: 0, priceChanges: [], statusChanges: [], unitChanges: [],
          unchangedCount: 1, missingUnitCount: 0, errors: [],
        });
      }
      if (call.method === 'POST' && call.url.endsWith('/catalog/import/confirm')) {
        return adminJson(200, { importId: 'imp-1', catalogRevision: 8, mode: 'incremental' });
      }
      return undefined;
    },
  });
  await harness.openSection('catalog');
  await harness.waitFor(() => harness.document.querySelector('[data-catalog-upload]'), 'import button A');
  harness.fire(harness.document.querySelector('[data-catalog-upload]'), 'click');
  const fileA = harness.document.querySelector('#catalogCsvFile');
  fileA.files = [{ name: 'A.csv', size: 12 }];
  harness.fire(fileA, 'change');
  assert.equal(readers.length, 1);

  const select = harness.document.querySelector('#accountSelect');
  select.value = 'B';
  harness.fire(select, 'change');
  await harness.waitFor(() => harness.App.state.accountId === 'B' && harness.document.querySelector('[data-catalog-upload]'),
    'import button B');
  harness.fire(harness.document.querySelector('[data-catalog-upload]'), 'click');
  const fileB = harness.document.querySelector('#catalogCsvFile');
  fileB.files = [{ name: 'B.csv', size: 12 }];
  harness.fire(fileB, 'change');
  assert.equal(readers.length, 2);

  readers[1].result = 'CSV-B-CONTENT';
  readers[1].onload();
  await harness.waitFor(() => harness.calls.some(call => call.url === '/admin/api/accounts/B/catalog/import/preview'),
    'preview B');

  readers[0].result = 'CSV-A-CONTENT';
  readers[0].onload();
  await adminFlush(30);

  harness.fire(harness.document.querySelector('#modalRoot [data-modal-confirm]'), 'click');
  await harness.waitFor(() => harness.calls.some(call => call.url === '/admin/api/accounts/B/catalog/import/confirm'),
    'confirm B');
  const confirm = harness.calls.find(call => call.url === '/admin/api/accounts/B/catalog/import/confirm');
  assert.equal(confirm.body.csv, 'CSV-B-CONTENT', '迟到的 A 文件回调不得覆盖 B 的导入内容');
  assert.equal(confirm.body.previewToken, 'tok-CSV-B-');
});

test('admin v2 offline calculates draft known amount accurately on trips list without regex loss', async () => {
  const harness = createAdminHarness({
    handler(call) {
      if (call.method === 'GET' && call.url === '/admin/api/accounts/A/overview') {
        return adminJson(200, {
          accountId: 'A',
          draftConfirmed: false,
          currentTripId: null,
          draft: {
            id: 'd1', revision: 2,
            customers: [{
              id: 'c1', customer: '甲店', partyId: null,
              items: [
                { id: 'i1', product: '鱼豆腐', brand: '安井', specification: '500g', unit: '箱', quantity: '2', price: '19.80' },
                { id: 'i2', product: '虾丸', brand: '', specification: '', unit: '箱', quantity: '1', price: null },
              ],
            }],
          },
          trips: [],
          staleDrafts: [],
        });
      }
      return undefined;
    },
  });
  await harness.openSection('trips');
  await harness.waitFor(() => harness.document.querySelector('#view').textContent.includes('¥39.60'),
    'draft known amount ¥39.60');
  const text = harness.document.querySelector('#view').textContent;
  assert.ok(text.includes('¥39.60'), '草稿有效单价必须按整数分正确汇总');
  assert.ok(text.includes('1 项待补价'), '缺价行应单独计入待补价');
});

test('admin v2 offline omits untouched aliases containing Chinese pause commas when editing variant price', async () => {
  const catalog = adminCatalogFixture();
  catalog.items[0].aliases = ['鱼丸、鱼饺组合装'];
  const harness = createAdminHarness({ catalog });
  await harness.openSection('catalog');
  await harness.waitFor(() => harness.document.querySelector('[data-catalog-edit="v-fish"]'), 'edit button');
  harness.fire(harness.document.querySelector('[data-catalog-edit="v-fish"]'), 'click');
  harness.document.querySelector('#catPrice').value = '21.50';
  harness.fire(harness.document.querySelector('#modalRoot [data-modal-confirm]'), 'click');
  await harness.waitFor(() => harness.calls.some(call => call.method === 'PATCH' && call.url.endsWith('/catalog/variants/v-fish')),
    'variant PATCH');
  const patched = harness.calls.find(call => call.method === 'PATCH' && call.url.endsWith('/catalog/variants/v-fish'));
  assert.equal(patched.body.priceCents, 2150);
  assert.equal('aliases' in patched.body, false, '未改动别名框时编辑规格不得拆分重写已有别名');
  assert.equal('brandAliases' in patched.body, false, '未改动品牌别名框时编辑规格不得重写已有品牌别名');
});

test('admin dispatch rejects methods, authentication and cross-origin writes before database access', async () => {
  const pool = { query: () => assert.fail('guarded routes must not reach PostgreSQL') };
  const call = async (url, method, headers = {}, token = adminToken) => {
    const request = Object.assign(Readable.from([Buffer.from('{}')]), { method, url,
      headers: { host: '127.0.0.1:8788', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    const result = {};
    const response = {
      writeHead: (status, responseHeaders) => Object.assign(result, { status, headers: responseHeaders }),
      end: content => Object.assign(result, { content }),
    };
    assert.equal(await handleAdmin(pool, token, request, response), true);
    return result;
  };
  const page = await call('/admin', 'GET');
  assert.equal(page.status, 200);
  const scripts = [...page.content.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  for (const script of scripts) new vm.Script(script[1]);
  await assert.rejects(call('/admin/api/accounts', 'GET'), { status: 401, code: 'admin_auth_required' });
  await assert.rejects(call('/admin/api/prompts', 'POST'), { status: 405, code: 'method_not_allowed' });
  const account = '/admin/api/accounts/' + randomUUID();
  const authorization = 'Bearer ' + adminToken;
  await assert.rejects(call(account, 'PATCH', { authorization, origin: 'http://other.test' }),
    { status: 403, code: 'admin_origin_rejected' });
  await assert.rejects(call(account, 'PATCH', { authorization, 'content-type': 'text/plain' }),
    { status: 415, code: 'invalid_content_type' });
  await assert.rejects(call('/admin', 'GET', {}, ''), { status: 404, code: 'not_found' });
});

test('admin v2 through the normal routes on an isolated PostgreSQL database', { timeout: 120_000 }, async t => {
  const db = await isolatedDatabase(t);
  const api = await start(db, { appId, exchange: async code => code }, { requireActivation: true, activationPepper: 'isolated-pepper' });
  let active = true;
  t.after(async () => { if (active) await api.stop(); });
  let account;
  let otherAccount;
  let customerId;
  let otherCustomer;
  let activeToken;
  let draft;
  let firstVariant;
  let mistake;

  await t.test('migration backfills legacy accounts and leaves the generation-zero session valid', async () => {
    const { rows: [legacy] } = await db.owner.query('SELECT activated_at, session_epoch FROM dispatch.accounts WHERE id = $1', [db.legacyAccount]);
    assert.ok(legacy.activated_at instanceof Date);
    assert.equal(legacy.session_epoch, 0);
    expect(await api.request('/v1/workspace', { token: legacyToken }));
    assert.equal(expect(await api.login('legacy'), 201).remarkName, '');
    const status = expect(await api.admin('/system/status'));
    assert.deepEqual(status.wechat, { configured: true, requireActivation: true });
    assert.equal(status.database.reachable, true);
    assert.equal(status.models.text.configured, false);
    assert.equal(JSON.stringify(status).includes('isolated-pepper'), false);
  });

  await t.test('opens accounts once, with rollback, digest-only storage and race-safe redemption', async () => {
    expect(await api.login('courier'), 403, 'activation_required');
    assert.equal((await db.owner.query("SELECT 1 FROM dispatch.accounts WHERE identity_subject = $1", [appId + ':courier'])).rowCount, 0);
    expect(await api.login('courier', 'invalid'), 403, 'invalid_activation_code');
    const first = await issue(api, '  配送员甲  ', 'issue-first');
    const second = await issue(api, '配送员甲备用');
    assert.match(first.code, /^DZ-[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
    const retry = await issue(api, '配送员甲', 'issue-first');
    assert.equal(retry.code, null);
    assert.equal(retry.record.id, first.record.id);
    expect(await api.admin('/activation-codes', 'POST', { remarkName: '他人', requestId: 'issue-first' }), 409, 'request_conflict');
    const concurrent = await Promise.all([api.login('courier', first.code.toLowerCase().replace(/-/g, ' ')),
      api.login('courier', second.code.slice(3).replace('-', ''))]);
    const sessions = concurrent.map(reply => expect(reply, 201));
    assert.equal(sessions[0].remarkName, sessions[1].remarkName);
    assert.notEqual(sessions[0].token, sessions[1].token);
    activeToken = sessions[0].token;
    const list = expect(await api.admin('/activation-codes')).records;
    const used = list.find(row => row.redeemedAccountId && [first.record.id, second.record.id].includes(row.id));
    const unused = list.find(row => row.status === 'unused' && [first.record.id, second.record.id].includes(row.id));
    assert.ok(used && unused);
    assert.equal(used.redeemedAccountRemark, sessions[0].remarkName);
    assert.equal(list.some(row => 'code' in row || 'codeDigest' in row), false);
    assert.equal(JSON.stringify(list).includes(first.code), false);
    account = used.redeemedAccountId;
    const { rows: [stored] } = await db.owner.query('SELECT code_digest, code_hint FROM dispatch.activation_codes WHERE id = $1', [first.record.id]);
    assert.equal(stored.code_digest.length, 32);
    assert.notEqual(stored.code_hint, first.code);
    expect(await api.admin('/activation-codes/' + used.id + '/revoke', 'POST'), 409, 'activation_code_not_unused');
    const reissued = expect(await api.admin('/activation-codes/' + unused.id + '/reissue', 'POST'));
    assert.equal(reissued.revokedId, unused.id);
    assert.equal(reissued.record.remarkName, unused.remarkName);
    expect(await api.login('revoked', unused.id === first.record.id ? first.code : second.code), 403, 'invalid_activation_code');
    const raced = await Promise.all([api.login('claimant-a', reissued.code), api.login('claimant-b', reissued.code)]);
    assert.deepEqual(raced.map(result => result.status).sort(), [201, 403]);
    const loser = raced[0].status === 403 ? 'claimant-a' : 'claimant-b';
    assert.equal((await db.owner.query('SELECT 1 FROM dispatch.accounts WHERE identity_subject = $1', [appId + ':' + loser])).rowCount, 0);
    const claims = expect(await api.admin('/activation-codes')).records;
    otherAccount = claims.find(row => row.id === reissued.record.id).redeemedAccountId;
    for (let attempt = 0; attempt < 8; attempt++) expect(await api.login('guessing', 'DZ-0000-0000'), 403, 'invalid_activation_code');
    expect(await api.login('guessing', 'DZ-0000-0000'), 429, 'activation_rate_limited');
    const unusedCode = await issue(api, '作废用码');
    assert.equal(expect(await api.admin('/activation-codes/' + unusedCode.record.id + '/revoke', 'POST')).record.status, 'revoked');
  });

  await t.test('linearizes disable before the in-flight cached write and revokes both sessions', async () => {
    const root = '/accounts/' + account;
    const workspace = expect(await api.request('/v1/workspace', { token: activeToken }));
    const command = { requestId: randomUUID(), revision: workspace.draft.revision, customers: workspace.draft.customers };
    const path = '/v1/drafts/' + workspace.draft.id;
    const save = () => api.request(path, { method: 'PUT', token: activeToken, body: command });
    expect(await save());
    const blocker = await db.owner.connect();
    let stopping;
    let saving;
    try {
      await blocker.query('BEGIN');
      await lockAccountActivity(blocker, account);
      stopping = api.admin(root + '/disable', 'POST');
      await waitForAdvisoryWaiter(db.owner, 'ExclusiveLock');
      saving = save();
      await waitForAdvisoryWaiter(db.owner, 'ShareLock');
      await blocker.query('COMMIT');
      assert.equal(expect(await stopping).disabled, true);
      expect(await saving, 403, 'account_disabled');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled([stopping, saving]);
    }
    expect(await api.request('/v1/workspace', { token: activeToken }), 401, 'session_required');
    const spare = await issue(api, '停用账号备用');
    expect(await api.login('courier', spare.code), 403, 'account_disabled');
    const invalidKey = { account, id: randomUUID(), draftId: workspace.draft.id };
    await assert.rejects(new AgentStore(db.app).append(invalidKey, 'step', {}), { code: 'account_disabled' });
    await assert.rejects(new MaterialStore(db.app).append(account, randomUUID(), 0, Buffer.from([1])), { code: 'account_disabled' });
    await db.owner.query(`INSERT INTO dispatch.sessions (token_digest, account_id, expires_at)
      VALUES ($1, $2, now() + interval '1 hour')`, [sha256(activeToken), account]);
    expect(await api.request('/v1/workspace', { token: activeToken }), 403, 'account_disabled');
    assert.equal(expect(await api.admin(root + '/enable', 'POST')).disabled, false);
    expect(await api.request('/v1/workspace', { token: activeToken }), 401, 'session_required');
    activeToken = expect(await api.login('courier', spare.code), 201).token;
    assert.equal(expect(await api.admin('/activation-codes')).records.find(row => row.id === spare.record.id).status, 'unused');
    const store = new DraftStore(db.app);
    await businessSession.run({}, async () => {
      await store.accountFor(activeToken, appId);
      expect(await api.admin(root + '/disable', 'POST'));
      expect(await api.admin(root + '/enable', 'POST'));
      await assert.rejects(writeAccount(db.app, account, randomUUID(), { action: 'stale-test' }, () => {
        assert.fail('a stale generation must not write');
      }), { code: 'session_required' });
    });
    activeToken = expect(await api.login('courier'), 201).token;
    expect(await api.admin(root, 'PATCH', { remarkName: '  甲配送  ' }, { Origin: api.origin }));
    const entry = expect(await api.admin('/accounts')).accounts.find(row => row.id === account);
    assert.equal(entry.remarkName, '甲配送');
    assert.equal(entry.activated, true);
    assert.equal(entry.disabled, false);
    assert.ok(entry.lastActiveAt);
    assert.equal(entry.catalogProductCount, 0);
    assert.equal(entry.openMistakeCount, 0);
    await assert.rejects(db.app.query('UPDATE dispatch.accounts SET identity_subject = identity_subject WHERE id = $1', [account]), { code: '42501' });
    await assert.rejects(db.app.query('DELETE FROM dispatch.accounts WHERE id = $1', [account]), { code: '42501' });
    await assert.rejects(db.app.query('UPDATE dispatch.activation_codes SET remark_name = remark_name'), { code: '42501' });
  });

  await t.test('creates a delivered snapshot through the business API for read-only admin queries', async () => {
    const request = (path, body, method = 'POST') => api.request(path, { method, token: activeToken, body }).then(response => expect(response));
    const current = expect(await api.request('/v1/workspace', { token: activeToken })).draft;
    draft = (await request('/v1/drafts/' + current.id, { requestId: randomUUID(), revision: current.revision,
      customers: [{ id: randomUUID(), customer: '私密安福门店', partyId: null, items: [{ id: randomUUID(), product: '鱼豆腐', brand: '安井',
        specification: '500g', unit: '箱', quantity: '2', price: '17.80' }] }] }, 'PUT')).draft;
    const preview = (await request('/v1/trips/preview', { draftId: draft.id, revision: draft.revision, requestId: randomUUID() })).preview;
    await request('/v1/trips/confirm', { previewId: preview.previewId, requestId: randomUUID() });
    assert.equal(expect(await api.admin('/accounts/' + account + '/dashboard')).pulse.stage, 'delivering');
    await request(`/v1/trips/${draft.id}/sheets/${draft.customers[0].id}/delivery/apply`,
      { requestId: randomUUID(), version: 1, statusRevision: 0, complete: true, edits: [] });
    const home = expect(await api.admin('/accounts/' + account + '/dashboard'));
    assert.equal(home.pulse.stage, 'all_delivered');
    assert.equal(home.pulse.deliveredCount, 1);
    assert.equal(home.pulse.knownAmountCents, 3560);
    const records = expect(await api.admin('/accounts/' + account + '/customers')).customers;
    assert.equal(records.length, 1);
    assert.equal(records[0].deliveredTripCount, 1);
    assert.equal(records[0].lastDeliveredAtBasis, 'delivery_completed_at');
    customerId = records[0].id;
    otherCustomer = randomUUID();
    await db.owner.query('INSERT INTO dispatch.parties (account_id, id, name) VALUES ($1,$2,$3)',
      [account, otherCustomer, '第二门店']);
    await request('/v1/trips/next-draft', { requestId: randomUUID(), draftId: draft.id });
    draft = expect(await api.request('/v1/workspace', { token: activeToken })).draft;
    await protectFormalTables(db.owner);
  });

  await t.test('validates admin method, authorization, origin and JSON at route boundaries', async () => {
    const root = '/accounts/' + account;
    expect(await api.request(apiPrefix + root + '/catalog'), 401, 'admin_auth_required');
    for (const suffix of ['/overview', '/catalog', '/dashboard', '/scopes/' + draft.id,
      '/turns/' + randomUUID() + '/eval-case', '/materials/' + randomUUID() + '/content']) {
      expect(await api.admin(root + suffix, 'POST', {}), 405, 'method_not_allowed');
    }
    expect(await api.admin('/prompts', 'POST'), 405, 'method_not_allowed');
    expect(await api.admin(root + '/catalog/items', 'POST', {}, { 'Content-Type': 'text/plain' }), 415, 'invalid_content_type');
    expect(await api.admin(root, 'PATCH', { remarkName: '外部' }, { Origin: 'http://example.test' }), 403, 'admin_origin_rejected');
    expect(await api.admin(root, 'PATCH', { remarkName: '外部' }, { 'Sec-Fetch-Site': 'same-origin' }), 403, 'admin_origin_rejected');
    expect(await api.admin(root, 'PATCH', { remarkName: '外部' }, { Origin: api.origin, 'Sec-Fetch-Site': 'cross-site' }),
      403, 'admin_origin_rejected');
  });

  await t.test('incremental CSV, version conflicts with manual and CLI updates, Excel safety and query sandbox', async () => {
    const root = '/accounts/' + account + '/catalog';
    const stock = await new CatalogStore(db.owner).importCsv(account, asCsv([baseRow, secondRow]));
    assert.equal(stock.replayed, false);
    const initial = expect(await api.admin(root));
    assert.equal(initial.catalogRevision, 1);
    assert.equal(initial.items.length, 2);
    firstVariant = initial.items.find(row => row.productCode === 'FISH');
    assert.ok(firstVariant.productId && firstVariant.variantId);
    const changedRow = [...baseRow];
    changedRow[9] = '20.20';
    const csv = asCsv([changedRow]);
    const preview = expect(await api.admin(root + '/import/preview', 'POST', { csv }));
    assert.equal(preview.catalogRevision, 1);
    assert.deepEqual(preview.priceChanges.map(row => [row.oldPriceCents, row.newPriceCents]), [[1980, 2020]]);
    assert.equal(preview.missingUnitCount, 1);
    assert.deepEqual(expect(await api.admin(root)), initial);
    const manualPath = root + '/variants/' + firstVariant.variantId;
    expect(await api.admin(manualPath, 'PATCH', { priceCents: 0 }), 400, 'invalid_input');
    const edited = expect(await api.admin(manualPath, 'PATCH', { priceCents: 1999, expectedRevision: 1 }));
    assert.equal(edited.catalogRevision, 2);
    expect(await api.admin(manualPath, 'PATCH', { priceCents: 2000, expectedRevision: 1 }), 409, 'catalog_changed');
    expect(await api.admin(root + '/import/confirm', 'POST', { csv, previewToken: preview.previewToken, requestId: randomUUID() }),
      409, 'catalog_changed');
    const preCli = expect(await api.admin(root + '/import/preview', 'POST', { csv }));
    const importedAgain = [...baseRow];
    importedAgain[9] = '19.88';
    await new CatalogStore(db.owner).importCsv(account, asCsv([importedAgain, secondRow]));
    expect(await api.admin(root + '/import/confirm', 'POST', { csv, previewToken: preCli.previewToken, requestId: randomUUID() }),
      409, 'catalog_changed');
    const previewToken = expect(await api.admin(root + '/import/preview', 'POST', { csv })).previewToken;
    const requestId = randomUUID();
    const confirm = await Promise.all([1, 2].map(() => api.admin(root + '/import/confirm', 'POST', { csv, previewToken, requestId })));
    const result = expect(confirm[0]);
    assert.deepEqual(expect(confirm[1]), result);
    assert.equal(result.catalogRevision, 4);
    const current = expect(await api.admin(root));
    assert.equal(current.items.length, 2);
    assert.equal(current.items.find(row => row.productCode === 'RICE').unit, null);
    assert.equal(current.items.find(row => row.productCode === 'FISH').priceCents, 2020);
    expect(await api.admin('/accounts/' + otherAccount + '/catalog/import/confirm', 'POST', { csv, previewToken, requestId }),
      400, 'invalid_catalog_preview');
    const badRow = [...baseRow];
    for (const formula of ['=SUM(A1:A2)', '+CMD', '-CMD', '@CMD', '\tformula', '\rformula']) {
      badRow[5] = formula;
      expect(await api.admin(root + '/import/preview', 'POST', { csv: asCsv([badRow]) }), 400, 'invalid_catalog_csv');
    }
    const query = expect(await api.admin(root + '/test-query', 'POST', { query: '安井鱼豆腐500g 2箱' }));
    assert.equal(query.status, 'active');
    assert.equal(query.priceCents, 2020);
    assert.equal(query.priceSource, 'catalog');
    assert.equal(expect(await api.admin(root + '/test-query', 'POST', { query: '安井鱼豆腐500g 2箱', customerId })).priceCents, 1780);
    assert.equal(expect(await api.admin(root + '/test-query', 'POST', { query: '安井鱼豆腐500g 2袋' })).priceCents, null);
    assert.equal(expect(await api.admin(root)).catalogRevision, 4);
    const newItem = expect(await api.admin(root + '/items', 'POST', { product: '=演示商品', brand: '安井',
      priceCents: 123, status: 'discontinued', packaging: '300g', aliases: ['手工别名'], remarks: '-保留原样' }));
    assert.equal(newItem.catalogRevision, 5);
    assert.equal(newItem.item.unit, null);
    expect(await api.admin(root + '/items', 'POST', { productId: newItem.item.productId, variantCode: 'SEC',
      priceCents: 234, unit: '箱', status: 'active' }));
    const revised = expect(await api.admin(manualPath, 'PATCH', { priceCents: 2020, unit: null,
      status: 'discontinued', aliases: ['鱼腐新版'], expectedRevision: 6 }));
    assert.equal(revised.item.unit, null);
    assert.deepEqual(revised.item.aliases, ['鱼腐新版']);
    const csvResponse = await api.admin(root + '/export.csv');
    expect(csvResponse);
    assert.equal(csvResponse.raw.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.match(csvResponse.headers.get('content-disposition'), /attachment/);
    const rows = parseCatalogCsv(csvResponse.data);
    assert.equal(rows.find(row => row.product === '=演示商品').remarks, '-保留原样');
    assert.deepEqual(rows.find(row => row.productCode === 'FISH').aliases, ['鱼腐新版']);
    assert.match(csvResponse.data, /"'=演示商品"/);
    const anchors = await db.owner.query("SELECT 1 FROM dispatch.catalog_imports WHERE account_id = $1 AND source = 'manual'", [account]);
    assert.equal(anchors.rowCount, 1);
  });

  await t.test('customer aliases share normalization and protect a rebound alias from stale deletes', async () => {
    const root = '/accounts/' + account;
    const prices = expect(await api.admin(root + '/customers/' + customerId + '/prices'));
    assert.equal(prices.sales.length, 1);
    assert.equal(prices.sales[0].unitPriceCents, 1780);
    const path = root + '/customer-aliases';
    const saved = expect(await api.admin(path, 'POST', { customerId, alias: ' 私密Ａ店 ' }));
    assert.equal(saved.normalizedAlias, '私密a店');
    expect(await api.admin(path, 'POST', { customerId: otherCustomer, alias: '私密a店' }), 409, 'customer_alias_conflict');
    expect(await api.admin(path, 'POST', { customerId, alias: '第二门店' }), 409, 'customer_name_conflict');
    expect(await api.admin(path, 'POST', { customerId: otherCustomer, alias: '私密a店', allowRebind: true }));
    expect(await api.admin(path, 'DELETE', { customerId, alias: '私密Ａ店' }), 409, 'customer_alias_conflict');
    assert.equal(expect(await api.admin(path, 'DELETE', { customerId: otherCustomer, alias: '私密Ａ店' })).removed.customerId, otherCustomer);
    expect(await api.admin(path, 'POST', { customerId, alias: '私密小名' }));
  });

  await t.test('quality metrics and a frozen, consistently redacted mistake snapshot', async () => {
    const root = '/accounts/' + account;
    const text = '私密安福门店简称私密小名，手机号13812345678，要两箱鱼豆腐';
    const turnId = await addTurn(db.owner, account, draft, { text, undone: true, events: [
      ['model', { inputTokens: 1000, outputTokens: 50, model: 'fixture', toolCalls: [{ arguments: JSON.stringify({ customer: '私密安福门店' }) }] }],
      ['tool', { result: { catalog: [{ draftCustomerId: 'x', lineId: '1', price: '20.20', priceSource: 'catalog' },
        { draftCustomerId: 'x', lineId: '2', price: null, priceSource: null }] } }],
      ['questions', { questions: [{ text: '私密小名要选哪个价？' }] }],
      ['end', { elapsedMs: 40 }],
    ] });
    const runningTurn = await addTurn(db.owner, account, draft, { status: 'running', text });
    await addTurn(db.owner, account, draft, { status: 'failed', timestamp: new Date(Date.now() - 9 * 86_400_000) });
    const all = expect(await api.admin(root + '/quality-turns?filter=all&days=all'));
    assert.ok(all.turns.some(row => row.id === runningTurn));
    assert.equal(all.turns.find(row => row.id === turnId).scopeId, draft.id);
    for (const filter of ['attention', 'unpriced', 'question', 'undone']) {
      assert.deepEqual(expect(await api.admin(root + '/quality-turns?filter=' + filter)).turns.map(row => row.id), [turnId]);
    }
    assert.equal(expect(await api.admin(root + '/quality-turns?filter=failed')).turns.length, 0);
    const home = expect(await api.admin(root + '/dashboard'));
    assert.equal(home.pulse.stage, 'draft');
    assert.equal(home.todos.attentionTurnCount7d, 1);
    assert.equal(home.ai7d.avgElapsedMs, 40);
    assert.equal(home.ai7d.inputTokens, 1000);
    assert.equal(home.ai7d.outputTokens, 50);
    assert.deepEqual([home.ai7d.autoPriceHitRate.numerator, home.ai7d.autoPriceHitRate.denominator], [1, 2]);
    assert.equal(home.ai7d.estimatedCostYuan, 0.0024);
    expect(await api.admin(root + '/mistakes', 'POST', { turnId: runningTurn, category: '其他', expectedOutcome: '不应保存' }), 409, 'turn_running');
    const legacy = expect(await api.admin(root + '/turns/' + turnId + '/eval-case'));
    assert.equal(legacy.task.text, text);
    const payload = { turnId, category: '价格没配上', expectedOutcome: '优先熟客成交价', includeCatalog: true };
    const saved = await Promise.all([api.admin(root + '/mistakes', 'POST', payload), api.admin(root + '/mistakes', 'POST', payload)]);
    mistake = expect(saved[0]);
    assert.deepEqual(expect(saved[1]), mistake);
    const serialized = JSON.stringify(mistake.caseJson);
    assert.ok(serialized.includes('门店甲') && serialized.includes('简称') && serialized.includes('联系电话'));
    for (const privateValue of ['私密安福门店', '私密小名', '13812345678']) assert.ok(!serialized.includes(privateValue));
    assert.equal(expect(await api.admin(root + '/dashboard')).todos.openMistakeCount, 1);
    assert.equal(expect(await api.admin(root + '/quality-turns')).turns[0].mistakeStatus, 'open');
    const replay = expect(await api.admin(root + '/mistakes', 'POST', { ...payload, expectedOutcome: '被忽略' }));
    assert.deepEqual(replay, mistake);
    const path = root + '/mistakes/' + turnId;
    expect(await api.admin(path, 'PATCH', { caseJson: {} }), 400, 'invalid_input');
    const patched = expect(await api.admin(path, 'PATCH', { note: '人工复核完成', status: 'resolved' }));
    assert.deepEqual(patched.caseJson, mistake.caseJson);
    assert.equal(expect(await api.admin(root + '/mistakes?status=resolved')).mistakes.length, 1);
    const exported = await api.admin(path + '/export');
    assert.match(exported.headers.get('content-disposition'), /case-.*\.json/);
    const fixture = expect(exported);
    assert.equal(fixture.meta.mistake.status, 'resolved');
    assert.deepEqual(fixture.task, mistake.caseJson.task);
    const scoped = (id, sql, params = []) => transaction(db.app, async client => {
      if (id) await setAccount(client, id);
      return client.query(sql, params);
    });
    await assert.rejects(scoped(account, "UPDATE dispatch.mistake_cases SET case_json = '{}'"), { code: '42501' });
    await assert.rejects(scoped(account, 'DELETE FROM dispatch.mistake_cases'), { code: '42501' });
    for (const id of [null, otherAccount]) {
      assert.equal((await scoped(id, 'SELECT * FROM dispatch.mistake_cases')).rowCount, 0);
      assert.equal((await scoped(id, "UPDATE dispatch.mistake_cases SET note = ''")).rowCount, 0);
    }
    expect(await api.admin('/accounts/' + otherAccount + '/mistakes/' + turnId + '/export'), 404, 'mistake_not_found');
  });

  await t.test('account and activation writes also pass the formal-table mutation guard', async () => {
    const root = '/accounts/' + otherAccount;
    expect(await api.admin(root, 'PATCH', { remarkName: '另一位配送员' }));
    expect(await api.admin(root + '/disable', 'POST'));
    expect(await api.admin(root + '/enable', 'POST'));
    const fresh = await issue(api, '守卫测试');
    const next = expect(await api.admin('/activation-codes/' + fresh.record.id + '/reissue', 'POST'));
    expect(await api.admin('/activation-codes/' + next.record.id + '/revoke', 'POST'));
  });

  active = false;
  await api.stop();
  for (const table of formalTables) {
    await db.owner.query(`DROP TRIGGER IF EXISTS reject_admin_formal_write ON dispatch.${table}`);
  }
  await t.test('development login skips activation and respects disable', async () => {
    const dev = await start(db, undefined, { requireActivation: true });
    try {
      const login = () => dev.request('/v1/session/development', { method: 'POST', body: { account: 'a' } });
      const session = expect(await login(), 201);
      const a = expect(await dev.admin('/accounts')).accounts.find(row => row.provider === 'development');
      assert.equal(a.activated, true);
      expect(await dev.admin('/accounts/' + a.id + '/disable', 'POST'));
      expect(await login(), 403, 'account_disabled');
      expect(await dev.request('/v1/workspace', { token: session.token }), 401, 'session_required');
      expect(await dev.admin('/accounts/' + a.id + '/enable', 'POST'));
      expect(await login(), 201);
    } finally {
      await dev.stop();
    }
  });
});
