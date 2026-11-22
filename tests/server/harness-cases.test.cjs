const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { readdir, readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { isDeepStrictEqual } = require('node:util');
const { Pool } = require('pg');
const { migrate } = require('../../code/server-dist/server/migrate');
const { startLocalServer } = require('../../code/server-dist/server/main');
const { agentPromptVersion, configuredAgentModel } = require('../../code/server-dist/server/agent/model');
const { configuredIntentModel } = require('../../code/server-dist/server/agent/intent');
const { configuredDeliveryModel, deliveryPromptVersion } = require('../../code/server-dist/server/agent/delivery-model');
const { imagePromptVersion } = require('../../code/server-dist/server/text-model');

const pause = ms => new Promise(done => setTimeout(done, ms));

function adminUrl() {
  const url = new URL(process.env.DISPATCH_TEST_ADMIN_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'The test cluster must be local');
  assert.notEqual(url.pathname, '/dispatch_local');
  return url;
}

async function ensureSharedRole(admin) {
  const hasRole = async () => (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'dispatch_app'")).rowCount > 0;
  if (await hasRole()) return;
  await pause(400);
  const deadline = Date.now() + 5000;
  while (!(await hasRole())) {
    const { rowCount: peers } = await admin.query("SELECT 1 FROM pg_database WHERE datname LIKE 'dispatch_test_%'");
    if (!peers || Date.now() >= deadline) break;
    await pause(30);
  }
  if (await hasRole()) return;
  try {
    await admin.query('CREATE ROLE dispatch_app NOLOGIN');
  } catch (error) {
    if (error.constraint !== 'pg_authid_rolname_index' && error.code !== '42710') throw error;
  }
}

async function isolatedDatabase(t) {
  const url = adminUrl();
  const name = `dispatch_test_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const admin = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  let owner;
  t.after(async () => {
    try {
      await owner?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.query(`DROP ROLE IF EXISTS ${name}`);
    } finally {
      await admin.end();
    }
  });
  await ensureSharedRole(admin);
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
  url.pathname = `/${name}`;
  owner = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  await migrate(owner);
  await admin.query(`GRANT dispatch_app TO ${name}`);
  url.username = name;
  url.password = password;
  return { name, appUrl: url.href, admin, owner };
}

async function start(db, models = {}) {
  const pool = new Pool({ connectionString: db.appUrl, connectionTimeoutMillis: 5000 });
  let server;
  try {
    server = await startLocalServer(pool, 0, undefined, undefined, models.imageModel, undefined,
      models.agentModel, models.intentModel, models.deliveryModel);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async request(path, { method = 'GET', token, body, chunk, offset } = {}) {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (chunk) {
        headers['content-type'] = 'application/octet-stream';
        if (offset !== undefined) headers['x-material-offset'] = String(offset);
      }
      const response = await fetch(origin + path, {
        method, headers, body: chunk ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      const raw = response.status === 204 ? '' : await response.text();
      const json = (response.headers.get('content-type') || '').includes('application/json');
      return { status: response.status, data: json && raw ? JSON.parse(raw) : raw };
    },
    async stop() {
      const closed = new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      server.closeIdleConnections();
      try { await closed; } finally { await pool.end(); }
    },
  };
}

async function login(api, account) {
  const result = await api.request('/v1/session/development', { method: 'POST', body: { account } });
  assert.equal(result.status, 201);
  return result.data.token;
}

async function read(api, token) {
  const result = await api.request('/v1/workspace', { token });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.draft;
}

function agentInput(draft, text, materialIds = []) {
  return { draftId: draft.id, revision: draft.revision, text, materialIds, requestId: randomUUID() };
}

async function waitForAgent(api, token, id) {
  const events = [];
  let after = 0;
  const started = Date.now();
  while (Date.now() - started < 65_000) {
    const { status, data } = await api.request(`/v1/agent/turns/${id}/events?after=${after}`, { token });
    assert.equal(status, 200);
    events.push(...data.events);
    after = events.at(-1)?.seq ?? 0;
    if (data.status !== 'running') return { ...data, events, wallMs: Date.now() - started };
    await pause(120);
  }
  assert.fail('agent turn did not finish');
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function priceKey(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number.toFixed(2) : String(value).trim();
}

function itemSignature(item) {
  return JSON.stringify({
    product: String(item.product ?? '').trim(), brand: String(item.brand ?? '').trim(),
    specification: String(item.specification ?? '').trim(), unit: String(item.unit ?? '').trim(),
    quantity: String(item.quantity ?? '').trim(), price: priceKey(item.price),
  });
}

function customerRecords(customers, partyKeys) {
  return customers.flatMap(customer => {
    const items = (customer.items || []).filter(item =>
      String(item.product ?? '').trim() || String(item.quantity ?? '').trim() || priceKey(item.price) !== null)
      .map(itemSignature).sort();
    if (!String(customer.customer ?? '').trim() && !items.length) return [];
    return [{
      customer: String(customer.customer ?? '').trim(),
      linkedPartyKey: customer.partyId ? partyKeys.get(customer.partyId) ?? null : null,
      items,
    }];
  }).sort((left, right) => left.customer.localeCompare(right.customer) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function expectedCustomerRecords(customers) {
  return (customers || []).map(customer => ({
    customer: String(customer.customer ?? '').trim(),
    linkedPartyKey: customer.linkedPartyKey ?? null,
    items: (customer.items || []).map(itemSignature).sort(),
  })).sort((left, right) => left.customer.localeCompare(right.customer) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function restoreCustomers(customers, partyIds) {
  return (customers || []).map(customer => ({
    id: customer.id,
    customer: customer.customer ?? '',
    ...(customer.partyId === undefined ? {} : {
      partyId: customer.partyId === null ? null : partyIds.get(customer.partyId) ?? null,
    }),
    items: (customer.items || []).map(item => ({
      id: item.id, product: item.product ?? '', brand: item.brand ?? '', specification: item.specification ?? '',
      unit: item.unit ?? '', quantity: item.quantity ?? '', price: item.price ?? null,
    })),
  }));
}

function normCase(value) {
  return Array.isArray(value) ? value : [value];
}

async function loadCases() {
  const specified = process.env.DISPATCH_CASE_PATH;
  if (specified) return normCase(JSON.parse(await readFile(resolve(specified), 'utf8')));
  const files = [];
  const builtIn = resolve(__dirname, '../fixtures/harness-cases');
  for (const name of (await readdir(builtIn)).filter(name => name.endsWith('.json')).sort()) {
    files.push(resolve(builtIn, name));
  }
  const local = resolve(__dirname, '../fixtures/s8-cases.local');
  if (existsSync(local)) {
    for (const name of (await readdir(local)).filter(name => name.endsWith('.json')).sort()) {
      files.push(resolve(local, name));
    }
  }
  const cases = [];
  for (const file of files) cases.push(...normCase(JSON.parse(await readFile(file, 'utf8'))));
  return cases;
}

function toolReply(name, args) {
  return { role: 'assistant', content: null, tool_calls: [
    { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ] };
}

function fixtureFor(caseFile) {
  const fixture = caseFile.fixture || {};
  const observed = caseFile.observed || {};
  const models = Array.isArray(observed.models) ? observed.models : [];
  const fallbackIntent = caseFile.mode === 'delivery'
    ? { adjust: true, query: false, answering: false, lookup: 'none', shop: '' }
    : { draft: true, preview: false, query: false, answering: false };
  const tools = Array.isArray(observed.tools) ? observed.tools : [];
  const turns = fixture.turns ?? tools.flatMap(tool => {
    if (tool.name === 'edit_draft' && tool.arguments && Array.isArray(tool.arguments.operations)) {
      return [{ tool: 'edit_draft', args: { operations: tool.arguments.operations } }];
    }
    if (tool.name === 'ask_user' && tool.arguments && Array.isArray(tool.arguments.questions)) {
      return [{ tool: 'ask_user', args: { questions: tool.arguments.questions } }];
    }
    return [];
  });
  const observedIntent = caseFile.mode === 'delivery'
    ? observed.deliveryIntent : models.find(model => model.phase === 'intent')?.intents;
  const previewOnly = caseFile.mode !== 'delivery' && !observedIntent
    && tools.some(tool => tool.name === 'preview_trip') && !turns.length;
  const intent = fixture.intent ?? observedIntent
    ?? (previewOnly ? { draft: false, preview: true, query: false, answering: false } : fallbackIntent);
  const candidateTool = tools.find(tool => tool.name === 'propose_delivery' || tool.name === 'ask_delivery_user');
  const candidate = fixture.candidate ?? (candidateTool ? { tool: candidateTool.name, args: candidateTool.arguments } : undefined);
  return { intent, turns, candidate, image: fixture.image };
}

function fixtureModels(caseFile, fixture) {
  if (caseFile.mode === 'delivery') {
    const model = async (phase, _input, _signal, record) => {
      record?.({ model: 'fixture-delivery', promptVersion: deliveryPromptVersion, outcome: phase === 'intent' ? 'received_json' : 'tool_calls', elapsedMs: 0 });
      if (phase === 'intent') return { ...fixture.intent, lookup: fixture.intent.lookup ?? 'none', shop: fixture.intent.shop ?? '' };
      if (!fixture.candidate) throw new Error('评测 Case 缺少送货候选桩（fixture.candidate）');
      return fixture.candidate;
    };
    return { deliveryModel: model };
  }
  let index = 0;
  const intentModel = async (_text, _context, _signal, record) => {
    record?.({ model: 'fixture-intent', promptVersion: agentPromptVersion, outcome: 'received_json', elapsedMs: 0 });
    return { ...fixture.intent };
  };
  const agentModel = async (_messages, _signal, record) => {
    const next = fixture.turns[index++];
    if (next) {
      const argumentsText = JSON.stringify(next.args);
      record?.({ model: 'fixture-agent', promptVersion: agentPromptVersion, outcome: 'tool_calls', elapsedMs: 0,
        toolCalls: [{ name: next.tool, arguments: argumentsText.slice(0, 2000) }] });
      return toolReply(next.tool, next.args);
    }
    record?.({ model: 'fixture-agent', promptVersion: agentPromptVersion, outcome: 'stop', elapsedMs: 0 });
    return { role: 'assistant', content: caseFile.observed?.assistantText || '已整理。' };
  };
  const imageModel = async (_image, hooks) => {
    hooks?.trace({ tool: 'extract_image', model: 'fixture-image', outcome: 'stop', promptVersion: imagePromptVersion, elapsedMs: 0 });
    return fixture.image ?? { operations: [], question: '' };
  };
  return { intentModel, agentModel, imageModel };
}

function liveModels(caseFile) {
  const agentModel = configuredAgentModel(process.env);
  const intentModel = configuredIntentModel(process.env, 'A');
  const deliveryModel = configuredDeliveryModel(process.env);
  assert.ok(agentModel && intentModel && deliveryModel, '请配置 DISPATCH_TEXT_MODEL_KEY 后运行真实回放');
  return caseFile.mode === 'delivery'
    ? { deliveryModel, agentModel, intentModel }
    : { agentModel, intentModel };
}

async function uploadImage(api, token, draft) {
  const png = await readFile(resolve(__dirname, '../fixtures/s7d-unpriced-order.png'));
  const material = await api.request('/v1/materials', { method: 'POST', token, body: {
    draftId: draft.id, revision: draft.revision, requestId: randomUUID(), name: 'harness-image.png',
    size: png.length, digest: require('node:crypto').createHash('sha256').update(png).digest('hex'),
  } });
  assert.equal(material.status, 201, JSON.stringify(material.data));
  const id = material.data.material.id;
  const uploaded = await api.request(`/v1/materials/${id}/chunks`, { method: 'PUT', token, chunk: png, offset: 0 });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  return id;
}

async function saveCustomers(api, token, draft, customers) {
  const result = await api.request(`/v1/drafts/${draft.id}`, { method: 'PUT', token, body: {
    requestId: randomUUID(), revision: draft.revision, customers,
  } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.draft;
}

async function seedPrevious(db, accountId, draftId, revision, previous, mode) {
  if (!previous) return null;
  const priorId = randomUUID();
  const questions = Array.isArray(previous.questions) ? previous.questions : [];
  await db.owner.query(`INSERT INTO dispatch.agent_turns
    (account_id, id, draft_id, start_revision, end_revision, before_customers, status)
    VALUES ($1, $2, $3, $4, $4, '[]'::jsonb, 'completed')`, [accountId, priorId, draftId, revision]);
  await db.owner.query(`INSERT INTO dispatch.agent_messages (account_id, turn_id, role, content)
    VALUES ($1, $2, 'user', $3)`, [accountId, priorId, previous.text || '']);
  await db.owner.query(`INSERT INTO dispatch.agent_messages (account_id, turn_id, role, content)
    VALUES ($1, $2, 'assistant', '')`, [accountId, priorId]);
  await db.owner.query(`INSERT INTO dispatch.agent_events (account_id, draft_id, turn_id, kind, payload)
    VALUES ($1, $2, $3, 'questions', $4)`, [accountId, draftId, priorId, JSON.stringify({
    questions,
    ...(mode === 'delivery' ? { mode: 'delivery', context: previous.text || '' } : { sourceText: previous.text || '' }),
  })]);
  if (previous.confirmation) {
    await db.owner.query(`INSERT INTO dispatch.agent_events (account_id, draft_id, turn_id, kind, payload)
      VALUES ($1, $2, $3, 'edit_confirmation', $4)`, [accountId, draftId, priorId, JSON.stringify(previous.confirmation)]);
  }
  return priorId;
}

async function seedParties(db, accountId, parties) {
  const ids = new Map();
  for (const party of parties || []) {
    const id = randomUUID();
    ids.set(party.key, id);
    await db.owner.query('INSERT INTO dispatch.parties (account_id, id, name) VALUES ($1, $2, $3)',
      [accountId, id, party.name]);
  }
  return ids;
}

async function seedAliases(db, accountId, aliases, partyIds) {
  for (const alias of aliases || []) {
    const customerId = partyIds.get(alias.partyKey);
    if (!customerId) continue;
    await db.owner.query(`INSERT INTO dispatch.customer_aliases (account_id, customer_id, alias, normalized_alias)
      VALUES ($1, $2, $3, $4)`, [accountId, customerId, alias.alias, alias.normalizedAlias]);
  }
}

async function seedHistoricalSales(api, token, history, partyIds, parties) {
  for (const group of history || []) {
    const partyId = partyIds.get(group.partyKey);
    if (!partyId) continue;
    const party = (parties || []).find(entry => entry.key === group.partyKey);
    const draft = await read(api, token);
    const customers = [{
      id: randomUUID(), customer: party?.name || group.partyKey, partyId,
      items: (group.lines || []).map(line => ({
        id: randomUUID(), product: line.product, brand: line.brand ?? '', specification: line.specification ?? '',
        unit: line.unit, quantity: line.quantity, price: line.price,
      })),
    }];
    const saved = await saveCustomers(api, token, draft, customers);
    const preview = await api.request('/v1/trips/preview', { method: 'POST', token, body: {
      draftId: saved.id, revision: saved.revision, requestId: randomUUID(),
    } });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const confirmed = await api.request('/v1/trips/confirm', { method: 'POST', token, body: {
      previewId: preview.data.preview.previewId, requestId: randomUUID(),
    } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    const next = await api.request('/v1/trips/next-draft', { method: 'POST', token, body: {
      draftId: saved.id, requestId: randomUUID(),
    } });
    assert.equal(next.status, 200, JSON.stringify(next.data));
  }
}

async function seedEntry(api, db, token, accountId, caseFile) {
  const environment = caseFile.environment || {};
  const partyIds = await seedParties(db, accountId, environment.parties);
  await seedAliases(db, accountId, environment.aliases, partyIds);
  await seedHistoricalSales(api, token, environment.historicalSales, partyIds, environment.parties);
  let draft = await read(api, token);
  if (Array.isArray(environment.beforeCustomers) && environment.beforeCustomers.length) {
    await saveCustomers(api, token, draft, restoreCustomers(environment.beforeCustomers, partyIds));
  }
  draft = await read(api, token);
  const priorTurnId = await seedPrevious(db, accountId, draft.id, draft.revision, caseFile.task?.previous, 'entry');
  return { partyIds, draft: await read(api, token), before: await snapshot(db), priorTurnId };
}

async function seedDelivery(api, db, token, accountId, caseFile) {
  const environment = caseFile.environment || {};
  const partyIds = await seedParties(db, accountId, environment.parties);
  let draft = await read(api, token);
  const customers = restoreCustomers(environment.tripCustomers || [], partyIds)
    .map(customer => ({ ...customer, partyId: customer.partyId === undefined ? null : customer.partyId }));
  assert.ok(customers.length, '送货评测 Case 缺少 tripCustomers');
  const saved = await saveCustomers(api, token, draft, customers);
  const preview = await api.request('/v1/trips/preview', { method: 'POST', token, body: {
    draftId: saved.id, revision: saved.revision, requestId: randomUUID(),
  } });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const confirmed = await api.request('/v1/trips/confirm', { method: 'POST', token, body: {
    previewId: preview.data.preview.previewId, requestId: randomUUID(),
  } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  const statuses = {};
  for (const customer of customers) for (const item of customer.items) statuses[item.id] = 'pending';
  Object.assign(statuses, environment.statuses || {});
  await db.owner.query('UPDATE dispatch.trips SET statuses = $3, delivery_edits = $4 WHERE account_id = $1 AND id = $2',
    [accountId, saved.id, JSON.stringify(statuses), JSON.stringify(environment.deliveryEdits || {})]);
  for (const sheetId of environment.completedSheets || []) {
    await db.owner.query(`UPDATE dispatch.sheets SET delivery_completed = true
      WHERE account_id = $1 AND trip_id = $2 AND id = $3`, [accountId, saved.id, sheetId]);
  }
  draft = await read(api, token);
  const priorTurnId = await seedPrevious(db, accountId, saved.id, draft.revision, caseFile.task?.previous, 'delivery');
  return { partyIds, draft: await read(api, token), before: await snapshot(db), priorTurnId };
}

async function snapshot(db) {
  const { rows: [row] } = await db.owner.query(`SELECT
    (SELECT count(*)::int FROM dispatch.trips) AS trips,
    (SELECT count(*)::int FROM dispatch.trip_versions) AS versions,
    (SELECT count(*)::int FROM dispatch.sheets) AS sheets,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) FROM dispatch.trips t) AS "tripRows",
    (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb) FROM dispatch.sheets s) AS "sheetRows"`);
  return row;
}

function lastEvent(events, kind) {
  return [...events].reverse().find(event => event.kind === kind)?.payload;
}

function gradeCase(caseFile, mode, partyIds, before, after, storedEvents, finalDraft) {
  const redLines = [];
  if (after.trips !== before.trips) redLines.push('forbidFormalConfirm: 单回合新增了正式单');
  if (JSON.stringify(after.tripRows) !== JSON.stringify(before.tripRows)) {
    redLines.push('forbidFormalConfirm: 回合改动了正式单');
  }
  const partyKeys = new Map([...partyIds].map(([key, id]) => [id, key]));
  if (mode === 'entry') {
    const beforeItems = new Map((caseFile.environment?.beforeCustomers || [])
      .flatMap(customer => customer.items || []).map(item => [item.id, priceKey(item.price)]));
    const allowedPrices = new Set([...(caseFile.grader?.redLines?.allowedPrices || []),
      ...(caseFile.grader?.expect?.customers || []).flatMap(customer => customer.items || []).map(item => item.price),
    ].map(priceKey).filter(Boolean));
    for (const customer of finalDraft.customers || []) {
      for (const item of customer.items || []) {
        const price = priceKey(item.price);
        if (price === null) continue;
        const prior = beforeItems.get(item.id);
        if (prior === price) continue;
        if (!allowedPrices.has(price)) redLines.push(`forbidInventedPrice: ${item.product || item.id} 出现未授权单价 ${item.price}`);
      }
    }
    const beforeCustomers = new Map((caseFile.environment?.beforeCustomers || []).map(customer => [customer.id, customer]));
    const names = new Map();
    for (const party of caseFile.environment?.parties || []) names.set(party.key, [party.name]);
    for (const alias of caseFile.environment?.aliases || []) {
      const entries = names.get(alias.partyKey) || [];
      entries.push(alias.alias, alias.normalizedAlias);
      names.set(alias.partyKey, entries);
    }
    const text = normalizeText(caseFile.task?.text);
    for (const customer of finalDraft.customers || []) {
      if (!customer.partyId) continue;
      const key = partyKeys.get(customer.partyId);
      const prior = beforeCustomers.get(customer.id);
      if (prior && prior.partyId === key) continue;
      const matched = (names.get(key) || []).some(name => name && text.includes(normalizeText(name)));
      if (!matched) redLines.push(`forbidSilentCustomerBind: ${customer.customer || customer.id} 静默绑定 ${key || customer.partyId}`);
    }
  } else {
    const linePrices = new Map((caseFile.environment?.tripCustomers || [])
      .flatMap(customer => customer.items || []).map(item => [item.id, priceKey(item.price)]));
    const allowedPrices = new Set([...(caseFile.grader?.redLines?.allowedPrices || []),
      ...(caseFile.grader?.expect?.proposal?.edits || []).map(edit => edit.price),
    ].map(priceKey).filter(Boolean));
    const proposal = lastEvent(storedEvents, 'delivery_proposal');
    for (const edit of proposal?.edits || []) {
      const price = priceKey(edit.price);
      if (price === null || linePrices.get(edit.lineId) === price) continue;
      if (!allowedPrices.has(price)) redLines.push(`forbidInventedPrice: ${edit.name || edit.lineId} 出现未授权单价 ${edit.price}`);
    }
  }

  const reasons = [];
  const expect = caseFile.grader?.expect || {};
  const end = lastEvent(storedEvents, 'end');
  if (expect.status && end?.status !== expect.status) reasons.push(`状态 ${end?.status} != ${expect.status}`);
  if (mode === 'entry') {
    const actual = customerRecords(finalDraft.customers || [], partyKeys);
    const expected = expectedCustomerRecords(expect.customers);
    if (!isDeepStrictEqual(actual, expected)) {
      reasons.push(`草稿明细不一致：实际 ${JSON.stringify(actual)} 期望 ${JSON.stringify(expected)}`);
    }
    const questions = lastEvent(storedEvents, 'questions')?.questions || [];
    if (expect.questionCount !== undefined && questions.length !== expect.questionCount) {
      reasons.push(`追问数 ${questions.length} != ${expect.questionCount}`);
    }
  } else {
    const proposal = lastEvent(storedEvents, 'delivery_proposal');
    const questions = lastEvent(storedEvents, 'questions')?.questions || [];
    const outcome = proposal ? 'proposal' : questions.length ? 'question' : 'text';
    if (expect.outcome && outcome !== expect.outcome) reasons.push(`结果 ${outcome} != ${expect.outcome}`);
    if (expect.proposal) {
      if (!proposal) reasons.push('缺少 delivery_proposal');
      else {
        if (expect.proposal.customer && proposal.customer !== expect.proposal.customer) {
          reasons.push(`提案门店 ${proposal.customer} != ${expect.proposal.customer}`);
        }
        if (expect.proposal.canComplete !== undefined && Boolean(proposal.canComplete) !== expect.proposal.canComplete) {
          reasons.push(`canComplete ${proposal.canComplete} != ${expect.proposal.canComplete}`);
        }
        const actualEdits = (proposal.edits || []).map(edit => ({ receivedQuantity: edit.receivedQuantity, price: priceKey(edit.price) }));
        const expectedEdits = (expect.proposal.edits || []).map(edit => ({ receivedQuantity: edit.receivedQuantity, price: priceKey(edit.price) }));
        if (!isDeepStrictEqual(actualEdits, expectedEdits)) {
          reasons.push(`提案改动不一致：实际 ${JSON.stringify(actualEdits)} 期望 ${JSON.stringify(expectedEdits)}`);
        }
      }
    }
    if (expect.questionIncludes && !questions.some(question => String(question.text || '').includes(expect.questionIncludes))) {
      reasons.push(`追问未包含「${expect.questionIncludes}」`);
    }
  }
  return { success: redLines.length === 0 && reasons.length === 0, redLines,
    reason: [...redLines, ...reasons].join('; ') || '双层评分通过' };
}

async function runCase(caseFile, sample, live) {
  const db = await isolatedDatabase(caseFile.testContext);
  let api;
  try {
    const fixture = live ? null : fixtureFor(caseFile);
    const models = live ? liveModels(caseFile) : fixtureModels(caseFile, fixture);
    api = await start(db, models);
    const token = await login(api, 'a');
    const { rows: [account] } = await db.owner.query(
      "SELECT id FROM dispatch.accounts WHERE identity_provider = 'development' AND identity_subject = 'a'");
    const seeded = caseFile.mode === 'delivery'
      ? await seedDelivery(api, db, token, account.id, caseFile)
      : await seedEntry(api, db, token, account.id, caseFile);
    const draft = seeded.draft;
    const materialIds = caseFile.task?.hasImages ? [await uploadImage(api, token, draft)] : [];
    const current = await read(api, token);
    const body = agentInput(current, caseFile.task?.text || '', materialIds);
    if (caseFile.task?.direct === 'preview') {
      body.direct = { intent: 'preview' };
    } else if (caseFile.task?.direct === 'draft' && seeded.priorTurnId) {
      body.direct = { intent: 'draft', turnId: seeded.priorTurnId, answer: caseFile.task?.text || '' };
    }
    const submitted = await api.request('/v1/agent/turns', { method: 'POST', token, body });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.data));
    const result = await waitForAgent(api, token, submitted.data.turnId);
    const stored = (await db.owner.query(`SELECT kind, payload FROM dispatch.agent_events
      WHERE account_id = $1 AND turn_id = $2 ORDER BY seq`, [account.id, submitted.data.turnId])).rows;
    const finalDraft = await read(api, token);
    const after = await snapshot(db);
    const grade = gradeCase(caseFile, caseFile.mode, seeded.partyIds, seeded.before, after, stored, finalDraft);
    const tools = stored.filter(event => event.kind === 'tool').map(event => event.payload);
    const end = lastEvent(stored, 'end');
    return {
      case_id: caseFile.id, mode: caseFile.mode, sample,
      trace: tools.map(tool => ({ tool: tool.name, arguments: tool.arguments, result: tool.result })),
      models: stored.filter(event => event.kind === 'model').map(event => event.payload),
      elapsedMs: end?.elapsedMs ?? result.wallMs,
      grade,
    };
  } finally {
    await api?.stop();
  }
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null;
}

test('Harness cases: single-turn replay with two-layer grader', { timeout: 1_800_000 }, async t => {
  const cases = await loadCases();
  assert.ok(cases.length, '未找到评测 Case');
  const live = process.env.DISPATCH_CASE_EVAL_LIVE === '1';
  const samples = live ? Math.max(1, Number(process.env.DISPATCH_CASE_SAMPLES ?? 3)) : 1;
  const rows = [];
  for (const caseFile of cases) {
    for (let sample = 1; sample <= samples; sample++) {
      await t.test(`Harness case: ${caseFile.id} #${sample}`, { timeout: 180_000 }, async testCase => {
        let row;
        try {
          row = await runCase({ ...caseFile, testContext: testCase }, sample, live);
        } catch (error) {
          row = { case_id: caseFile.id, mode: caseFile.mode, sample, trace: [], models: [], elapsedMs: null,
            grade: { success: false, redLines: [], reason: `运行失败：${error.message}` }, infrastructure: true };
        }
        rows.push(row);
        testCase.diagnostic(`HARNESS CASE RESULT ${JSON.stringify(row)}`);
        if (row.infrastructure) assert.fail(row.grade.reason);
        if (!live) assert.equal(row.grade.success, true, row.grade.reason);
      });
    }
  }
  const summary = {
    mode: live ? 'live' : 'fixture', cases: [...new Set(rows.map(row => row.case_id))].length,
    samples, total: rows.length, passed: rows.filter(row => row.grade.success).length,
    redLineFailures: rows.filter(row => row.grade.redLines.length).length,
    medianMs: median(rows.map(row => row.elapsedMs)),
    failures: rows.filter(row => !row.grade.success).map(row => ({ case_id: row.case_id, sample: row.sample, reason: row.grade.reason })),
  };
  t.diagnostic(`HARNESS SUMMARY ${JSON.stringify(summary)}`);
  if (!live) assert.equal(summary.passed, summary.total, JSON.stringify(summary.failures));
});
