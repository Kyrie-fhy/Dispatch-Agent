import { Pool, PoolClient } from 'pg';
import {
  collectHistoricalSales, CustomerAlias, CustomerDirectory, DraftPriceCustomer, draftCustomersForPriceSuggestions,
  HistoricalSheet, lookupHistoricalPrice, normalizeMemoryText, ProductMention, resolveCustomerMention,
  suggestDraftCustomerMentions, suggestDraftPrices,
} from '../miniprogram/core/memory';
import { isObject, money } from '../miniprogram/core/orders';
import { missingDraft, readAccount, readParties, readWorkspace, workspaceDraft, writeAccount } from './account-workspace';
import { checkDraft } from './agent/store';
import { clearCatalogIdentity, itemIdentityChanged, readSaveDraft } from './draft-input';
import { HttpError } from './http-error';
import { readCommand, readId, readPreviewInput, uuidPattern, validSheetKey } from './request-input';
import { catalogPriceUpdate, loadCatalog, suggestCatalogChoices, summarizeCatalog, type CatalogPriceUpdate } from './catalog';
import { matchCatalogItem, resolveCatalogAutoPrice } from '../miniprogram/core/catalog';
import { sameOrSimilarProduct } from './text-orders';
import type { CustomerDraft } from '../miniprogram/core/trips';

export interface AliasCommand {
  requestId: string;
  alias: string;
}

export interface BindCustomerAliasInput extends AliasCommand {
  customerId: string;
  allowRebind?: boolean;
  allowCanonicalConflict?: boolean;
}

export interface CustomerChoiceResult {
  revision: number;
  remembered: boolean | null;
  rememberIssue?: 'name_conflict';
  priceUpdates?: CatalogPriceUpdate[];
}

type CustomerChoice = 'existing' | 'new' | 'unlink';
type ParsedCustomerChoice = {
  requestId: string;
  draftId: string;
  revision: number;
  draftCustomerId: string;
  choice: CustomerChoice;
  customerId?: string;
  remember?: boolean;
  spoken?: string;
  merge?: 'append' | 'keep_existing';
};
type ParsedPriceAdoptLine = {
  draftCustomerId: string;
  lineId: string;
  unitPriceCents: number;
  variant?: { brand: string; spec: string };
};

function invalidCustomerChoice() {
  return new HttpError(400, 'invalid_customer_choice', '请选择有效的客户处理方式');
}

function readCustomerChoice(value: unknown): ParsedCustomerChoice {
  const basis = readPreviewInput(value);
  const body = value as Record<string, unknown>;
  const draftCustomerId = body.draftCustomerId;
  const merge = body.merge;
  if (!validSheetKey(draftCustomerId)) throw invalidCustomerChoice();
  if (body.choice === 'existing') {
    if (merge !== undefined && merge !== 'append' && merge !== 'keep_existing') throw invalidCustomerChoice();
    return { ...basis, draftCustomerId, choice: 'existing', customerId: readId(body.customerId, '客户编号'),
      remember: body.remember === true, merge };
  }
  if (merge !== undefined) throw invalidCustomerChoice();
  if (body.choice === 'unlink') {
    const spoken = body.spoken;
    if (typeof spoken !== 'string' || spoken.length > 200 || !spoken.trim()) throw invalidCustomerChoice();
    return { ...basis, draftCustomerId, choice: 'unlink', spoken: spoken.trim() };
  }
  if (body.choice === 'new') return { ...basis, draftCustomerId, choice: 'new' };
  throw invalidCustomerChoice();
}

function invalidPriceAdopt() {
  return new HttpError(400, 'invalid_price_adopt', '请选择有效的沿用价格');
}

function priceSuggestionChanged() {
  return new HttpError(409, 'price_suggestion_changed', '这一行的上次价有变化，请刷新后再选。');
}

function priceNotSuggested() {
  return new HttpError(409, 'price_not_suggested', '这个价格不在历史成交价里，请刷新后再选。');
}

function readPriceAdoptInput(value: unknown) {
  const basis = readPreviewInput(value);
  const linesInput = (value as Record<string, unknown>).lines;
  if (!Array.isArray(linesInput) || linesInput.length < 1 || linesInput.length > 64) throw invalidPriceAdopt();
  const seen = new Set<string>();
  const lines = linesInput.map(raw => {
    if (!isObject(raw)) throw invalidPriceAdopt();
    const { draftCustomerId, lineId, unitPriceCents, variant } = raw;
    if (!validSheetKey(draftCustomerId) || !validSheetKey(lineId)) throw invalidPriceAdopt();
    if (typeof unitPriceCents !== 'number' || !Number.isSafeInteger(unitPriceCents) || unitPriceCents <= 0) {
      throw invalidPriceAdopt();
    }
    const key = `${draftCustomerId}\u0000${lineId}`;
    if (seen.has(key)) throw invalidPriceAdopt();
    seen.add(key);
    if (variant === undefined) return { draftCustomerId, lineId, unitPriceCents };
    if (!isObject(variant) || typeof variant.brand !== 'string' || typeof variant.spec !== 'string'
      || variant.brand.length > 200 || variant.spec.length > 200) throw invalidPriceAdopt();
    return { draftCustomerId, lineId, unitPriceCents, variant: { brand: variant.brand, spec: variant.spec } };
  });
  return { ...basis, lines } as { requestId: string; draftId: string; revision: number; lines: ParsedPriceAdoptLine[] };
}

function fillEmptyVariant(item: { brand: string; specification: string }, brand: string, spec: string) {
  if (!item.brand.trim() && brand.trim()) item.brand = brand.trim();
  if (!item.specification.trim() && spec.trim()) item.specification = spec.trim();
}

function readAliasCommand(value: unknown) {
  const input = readCommand(value);
  const { alias } = input;
  const normalizedAlias = typeof alias === 'string' ? normalizeMemoryText(alias) : '';
  if (!validSheetKey(alias) || !normalizedAlias) {
    throw new HttpError(400, 'invalid_customer_alias', '请输入有效的客户简称');
  }
  return { requestId: input.requestId, alias, normalizedAlias };
}

async function readAliases(client: PoolClient, accountId: string): Promise<CustomerAlias[]> {
  const { rows } = await client.query<CustomerAlias>(`
    SELECT customer_id AS "customerId", alias, normalized_alias AS "normalizedAlias"
    FROM dispatch.customer_aliases WHERE account_id = $1 ORDER BY normalized_alias
  `, [accountId]);
  return rows;
}

export async function readDirectory(client: PoolClient, accountId: string): Promise<CustomerDirectory> {
  const customers = await readParties(client, accountId);
  const aliases = await readAliases(client, accountId);
  return { customers, aliases };
}

export function overlappingItems(existing: CustomerDraft, incoming: CustomerDraft) {
  return incoming.items.filter(candidate => existing.items.some(item => sameOrSimilarProduct(item, candidate)));
}

type AliasWrite = {
  alias: string;
  normalizedAlias: string;
  customerId: string;
  allowRebind: boolean;
  allowCanonicalConflict: boolean;
};

async function findAlias(client: PoolClient, accountId: string, normalizedAlias: string) {
  const { rows: [existing] } = await client.query<CustomerAlias>(`
    SELECT customer_id AS "customerId", alias, normalized_alias AS "normalizedAlias"
    FROM dispatch.customer_aliases WHERE account_id = $1 AND normalized_alias = $2
  `, [accountId, normalizedAlias]);
  return existing;
}

async function writeAlias(client: PoolClient, accountId: string, input: AliasWrite,
  customers: readonly { id: string; name: string }[]): Promise<CustomerAlias> {
  const { alias, normalizedAlias, customerId, allowRebind, allowCanonicalConflict } = input;
  // Conflict detection stays entirely in JS and runs before any INSERT/UPDATE so callers can
  // ignore customer_name_conflict without leaving the transaction aborted.
  const existing = await findAlias(client, accountId, normalizedAlias);
  if (existing?.customerId === customerId) return existing;
  if (existing && !allowRebind) {
    throw new HttpError(409, 'customer_alias_conflict', '该简称已关联其他客户，请确认是否换绑');
  }
  if (!allowCanonicalConflict && customers.some(customer => customer.id !== customerId
    && normalizeMemoryText(customer.name) === normalizedAlias)) {
    throw new HttpError(409, 'customer_name_conflict', '该简称与其他客户的正式店名相同，请核对客户');
  }

  if (existing) {
    await client.query(`
      UPDATE dispatch.customer_aliases SET customer_id = $3, alias = $4, updated_at = clock_timestamp()
      WHERE account_id = $1 AND normalized_alias = $2
    `, [accountId, normalizedAlias, customerId, alias]);
  } else {
    await client.query(`
      INSERT INTO dispatch.customer_aliases (account_id, normalized_alias, customer_id, alias)
      VALUES ($1, $2, $3, $4)
    `, [accountId, normalizedAlias, customerId, alias]);
  }
  return { customerId, alias, normalizedAlias };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readDraft(client: PoolClient, accountId: string, draftId: string) {
  const workspace = await readWorkspace(client, accountId);
  if (workspace.id !== draftId) throw missingDraft();
  return workspace;
}

export async function readHistoricalSales(client: PoolClient, accountId: string, customerIds: readonly string[]) {
  if (!customerIds.length) return [];
  // The sheet carries party_id even when the version snapshot has no embedded partyId.
  const { rows } = await client.query<HistoricalSheet>(`
    SELECT s.trip_id AS "tripId", s.id AS "sheetId", s.party_id AS "customerId", s.reviewed, s.delivery_completed AS "deliveryCompleted",
           t.statuses, t.delivery_edits AS edits, sheet.customer,
           to_char(issued.saved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "issuedAt"
    FROM dispatch.sheets s
    JOIN dispatch.trips t ON t.account_id = s.account_id AND t.id = s.trip_id
    JOIN dispatch.trip_versions issued ON issued.account_id = s.account_id
      AND issued.trip_id = s.trip_id AND issued.version = 1
    CROSS JOIN LATERAL (
      SELECT customers FROM dispatch.trip_versions
      WHERE account_id = s.account_id AND trip_id = s.trip_id ORDER BY version DESC LIMIT 1
    ) head
    CROSS JOIN LATERAL jsonb_array_elements(head.customers) AS sheet(customer)
    WHERE s.account_id = $1 AND s.party_id = ANY($2::uuid[]) AND sheet.customer->>'id' = s.id
  `, [accountId, customerIds]);
  return collectHistoricalSales(rows);
}

async function suggestPrices(client: PoolClient, accountId: string, customers: readonly DraftPriceCustomer[]) {
  const requestedIds = [...new Set(customers.flatMap(({ customerId, items }) =>
    customerId && uuidPattern.test(customerId) && items.some(item => item.unitPriceCents === null) ? [customerId] : []))];
  if (!requestedIds.length) {
    return suggestDraftPrices([], customers.map(customer => ({ ...customer, customerId: null })));
  }

  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM dispatch.parties WHERE account_id = $1 AND id = ANY($2::uuid[])', [accountId, requestedIds]);
  const knownIds = new Set(rows.map(row => row.id));
  const sales = await readHistoricalSales(client, accountId, [...knownIds]);
  return suggestDraftPrices(sales, customers.map(customer =>
    customer.customerId && knownIds.has(customer.customerId) ? customer : { ...customer, customerId: null }));
}

export class MemoryStore {
  constructor(private readonly pool: Pool) {}

  customerDirectory(accountId: string): Promise<CustomerDirectory> {
    return readAccount(this.pool, accountId, client => readDirectory(client, accountId));
  }

  listCustomerAliases(accountId: string): Promise<CustomerAlias[]> {
    return readAccount(this.pool, accountId, client => readAliases(client, accountId));
  }

  aliasList(accountId: string) {
    return readAccount(this.pool, accountId, async client => {
      const aliases = await readAliases(client, accountId);
      const customers = await readParties(client, accountId);
      const names = new Map(customers.map(customer => [customer.id, customer.name]));
      return { aliases: aliases.map(alias => ({
        alias: alias.alias, normalizedAlias: alias.normalizedAlias, customerId: alias.customerId,
        canonicalName: names.get(alias.customerId) ?? '',
      })).sort((left, right) => compareText(left.canonicalName, right.canonicalName)
        || compareText(left.normalizedAlias, right.normalizedAlias)) };
    });
  }

  async resolveCustomerMention(accountId: string, rawInput: string) {
    return resolveCustomerMention(await this.customerDirectory(accountId), rawInput);
  }

  suggestDraftCustomers(accountId: string, draftId: string) {
    return readAccount(this.pool, accountId, async client => {
      const draft = await readDraft(client, accountId, draftId);
      const directory = await readDirectory(client, accountId);
      return { draftId, revision: draft.revision, suggestions: suggestDraftCustomerMentions(draft.customers, directory) };
    });
  }

  agentMemory(accountId: string, draftId: string) {
    return readAccount(this.pool, accountId, async client => {
      const workspace = await readDraft(client, accountId, draftId);
      const directory = await readDirectory(client, accountId);
      const draft = workspaceDraft(workspace);
      const confirmed = workspace.currentTripId === draftId;
      const catalog = await loadCatalog(client, accountId);
      return {
        catalogSummary: summarizeCatalog(catalog),
        catalogChoices: confirmed ? [] : suggestCatalogChoices(draft, catalog),
        draftId, revision: workspace.revision, confirmed,
        customers: directory.customers.map(({ id, name }) => ({ id, name })),
        mentions: confirmed ? [] : suggestDraftCustomerMentions(draft.customers, directory),
        prices: confirmed ? [] : await suggestPrices(client, accountId, draftCustomersForPriceSuggestions(draft.customers)),
      };
    });
  }

  async chooseDraftCustomer(accountId: string, value: unknown): Promise<CustomerChoiceResult> {
    const input = readCustomerChoice(value);
    const { requestId, draftId, revision, draftCustomerId, choice } = input;
    const command = { action: 'agent-customer-choice', draftId, revision, draftCustomerId, choice,
      customerId: input.customerId, remember: input.remember, spoken: input.spoken, merge: input.merge };
    return writeAccount(this.pool, accountId, requestId, command, async (client, workspace) => {
      checkDraft(workspace, draftId, revision, true);
      const running = await client.query(
        "SELECT 1 FROM dispatch.agent_turns WHERE account_id = $1 AND status = 'running'", [accountId]);
      if (running.rowCount) throw new HttpError(429, 'agent_busy', '助手正在处理上一条消息，请稍后再选。');
      const draft = workspaceDraft(workspace);
      const customer = draft.customers.find(entry => entry.id === draftCustomerId);
      if (!customer) throw new HttpError(404, 'draft_customer_not_found', '未找到草稿里的这位客户');
      const customers = await readParties(client, accountId);
      const alreadyLinked = typeof customer.partyId === 'string';
      let remembered: boolean | null = null;
      let rememberIssue: 'name_conflict' | undefined;
      let pricedCustomer = customer;

      if (choice === 'existing') {
        if (alreadyLinked) throw new HttpError(409, 'customer_already_linked', '这位客户已关联熟客');
        const customerId = input.customerId!;
        const party = customers.find(entry => entry.id === customerId);
        if (!party) throw new HttpError(404, 'customer_not_found', '未找到本账号的客户');
        const spoken = customer.customer.trim();
        const sibling = draft.customers.find(entry => entry !== customer && entry.partyId === party.id);
        const overlap = sibling ? overlappingItems(sibling, customer) : [];
        if (overlap.length && !input.merge) {
          const names = [...new Set(overlap.map(item => item.product.trim()))].slice(0, 3).join('、');
          throw new HttpError(409, 'customer_merge_review', `「${party.name}」已有同款或相似明细（${names}），请选择如何合并。`);
        }
        if (!overlap.length && input.merge) {
          throw new HttpError(409, 'draft_changed', '待合并的明细已变化，请核对草稿后重新选择。');
        }
        if (sibling) {
          const items = input.merge === 'keep_existing' ? customer.items.filter(item => !overlap.includes(item)) : customer.items;
          sibling.items.push(...items);
          pricedCustomer = sibling;
          draft.customers = draft.customers.filter(entry => entry !== customer);
        } else {
          customer.customer = party.name;
          customer.partyId = party.id;
        }
        const normalizedAlias = normalizeMemoryText(spoken);
        const canonical = normalizedAlias === normalizeMemoryText(party.name);
        const staleAlias = input.remember && canonical ? await findAlias(client, accountId, normalizedAlias) : undefined;
        if (input.remember && normalizedAlias && (!canonical || (staleAlias && staleAlias.customerId !== party.id))) {
          try {
            await writeAlias(client, accountId, {
              alias: spoken, normalizedAlias, customerId: party.id,
              allowRebind: true, allowCanonicalConflict: false,
            }, customers);
            remembered = true;
          } catch (error) {
            if (!(error instanceof HttpError) || error.code !== 'customer_name_conflict') throw error;
            remembered = false;
            rememberIssue = 'name_conflict';
          }
        }
      } else if (choice === 'new') {
        if (alreadyLinked) throw new HttpError(409, 'customer_already_linked', '这位客户已关联熟客');
        if (!customer.customer.trim()) throw new HttpError(400, 'invalid_customer_choice', '请先填写客户名称');
        customer.partyId = null;
      } else {
        if (!alreadyLinked) throw new HttpError(409, 'customer_not_linked', '这位客户还没有关联熟客');
        customer.customer = input.spoken!;
        delete customer.partyId;
      }

      const priceUpdates: CatalogPriceUpdate[] = [];
      if (choice === 'existing' || choice === 'unlink') {
        const catalog = await loadCatalog(client, accountId);
        const sales = choice === 'existing' && catalog.length
          ? await readHistoricalSales(client, accountId, [input.customerId!]) : [];
        pricedCustomer.items = pricedCustomer.items.map(item => {
          let updated = item;
          if (choice === 'existing' && item.catalogVariantId
            && (item.priceSource === 'catalog' || (!item.price && !item.priceSource))) {
            const match = matchCatalogItem(item, catalog);
            const next = resolveCatalogAutoPrice(item, match, input.customerId, sales);
            if (next.priceSource !== 'catalog') updated = next;
          } else if (choice === 'unlink' && item.priceSource === 'customer_history') {
            updated = resolveCatalogAutoPrice(item, matchCatalogItem(item, catalog));
            if (!catalog.length) updated = { ...item, price: null, priceSource: null };
          }
          const update = updated === item ? null : catalogPriceUpdate(pricedCustomer, item, updated);
          if (update) priceUpdates.push(update);
          return updated;
        });
      }

      const { draft: saved } = readSaveDraft(draftId, { ...draft, revision, requestId });
      const nextRevision = revision + 1;
      await client.query('UPDATE dispatch.workspaces SET draft_revision = $2, draft_customers = $3 WHERE account_id = $1',
        [accountId, nextRevision, JSON.stringify(saved.customers)]);
      await client.query(`INSERT INTO dispatch.agent_events (account_id, draft_id, kind, payload)
        VALUES ($1, $2, 'card', $3)`, [accountId, draftId,
        JSON.stringify({ action: 'customer-choice', choice, remembered, merge: input.merge,
          ...(priceUpdates.length ? { priceUpdates } : {}) })]);
      return { revision: nextRevision, remembered, ...(rememberIssue ? { rememberIssue } : {}),
        ...(priceUpdates.length ? { priceUpdates } : {}) };
    });
  }

  async adoptDraftPrices(accountId: string, value: unknown): Promise<{ revision: number; adopted: number }> {
    const { requestId, draftId, revision, lines } = readPriceAdoptInput(value);
    const command = { action: 'agent-price-adopt', draftId, revision, lines };
    return writeAccount(this.pool, accountId, requestId, command, async (client, workspace) => {
      checkDraft(workspace, draftId, revision, true);
      const running = await client.query(
        "SELECT 1 FROM dispatch.agent_turns WHERE account_id = $1 AND status = 'running'", [accountId]);
      if (running.rowCount) throw new HttpError(429, 'agent_busy', '助手正在处理上一条消息，请稍后再选。');
      const draft = workspaceDraft(workspace);
      const suggestions = await suggestPrices(client, accountId, draftCustomersForPriceSuggestions(draft.customers));
      const byLine = new Map(suggestions.map(suggestion =>
        [`${suggestion.draftCustomerId}\u0000${suggestion.lineId}`, suggestion]));
      for (const line of lines) {
        const suggestion = byLine.get(`${line.draftCustomerId}\u0000${line.lineId}`);
        if (!suggestion || suggestion.status === 'unresolved_customer') throw priceSuggestionChanged();
        const customer = draft.customers.find(entry => entry.id === line.draftCustomerId);
        const item = customer?.items.find(entry => entry.id === line.lineId);
        if (!item) throw priceSuggestionChanged();
        const previous = { ...item };
        if (suggestion.status === 'exact_match' || suggestion.status === 'unique_variant_match') {
          const accepted = suggestion.unitPriceCents === line.unitPriceCents
            || suggestion.previousDistinctPrice?.unitPriceCents === line.unitPriceCents;
          if (!accepted || line.variant) throw priceNotSuggested();
          item.price = money(line.unitPriceCents);
          if (suggestion.status === 'unique_variant_match') {
            fillEmptyVariant(item, suggestion.brand, suggestion.spec);
          }
        } else if (suggestion.status === 'ambiguous_variants') {
          const variant = line.variant;
          const match = variant && suggestion.candidates.find(candidate =>
            candidate.brand === variant.brand && candidate.spec === variant.spec
            && candidate.unitPriceCents === line.unitPriceCents);
          if (!match) throw priceNotSuggested();
          item.price = money(line.unitPriceCents);
          fillEmptyVariant(item, match.brand, match.spec);
        } else {
          throw priceNotSuggested();
        }
        if (itemIdentityChanged(item, previous)) clearCatalogIdentity(item);
        item.priceSource = 'customer_history';
      }
      const { draft: saved } = readSaveDraft(draftId, { ...draft, revision, requestId });
      const nextRevision = revision + 1;
      await client.query('UPDATE dispatch.workspaces SET draft_revision = $2, draft_customers = $3 WHERE account_id = $1',
        [accountId, nextRevision, JSON.stringify(saved.customers)]);
      await client.query(`INSERT INTO dispatch.agent_events (account_id, draft_id, kind, payload)
        VALUES ($1, $2, 'card', $3)`, [accountId, draftId,
        JSON.stringify({ action: 'price-adopt', count: lines.length })]);
      return { revision: nextRevision, adopted: lines.length };
    });
  }

  async bindCustomerAlias(accountId: string, input: BindCustomerAliasInput): Promise<CustomerAlias> {
    const { requestId, alias, normalizedAlias } = readAliasCommand(input);
    const customerId = readId(input.customerId, '客户编号');
    const allowRebind = input.allowRebind === true;
    const allowCanonicalConflict = input.allowCanonicalConflict === true;
    const command = { action: 'bind-customer-alias', alias, customerId, allowRebind, allowCanonicalConflict };
    return writeAccount(this.pool, accountId, requestId, command, async client => {
      const customers = await readParties(client, accountId);
      if (!customers.some(customer => customer.id === customerId)) {
        throw new HttpError(404, 'customer_not_found', '未找到本账号的客户');
      }
      return writeAlias(client, accountId, { alias, normalizedAlias, customerId, allowRebind, allowCanonicalConflict }, customers);
    });
  }

  async unbindCustomerAlias(accountId: string, input: unknown): Promise<{ removed: CustomerAlias | null }> {
    const { requestId, alias, normalizedAlias } = readAliasCommand(input);
    return writeAccount(this.pool, accountId, requestId, { action: 'unbind-customer-alias', alias }, async client => {
      const { rows: [removed] } = await client.query<CustomerAlias>(`
        DELETE FROM dispatch.customer_aliases WHERE account_id = $1 AND normalized_alias = $2
        RETURNING customer_id AS "customerId", alias, normalized_alias AS "normalizedAlias"
      `, [accountId, normalizedAlias]);
      return { removed: removed ?? null };
    });
  }

  async lookupHistoricalPrice(accountId: string, customerId: string, product: ProductMention) {
    const id = readId(customerId, '客户编号');
    return readAccount(this.pool, accountId, async client =>
      lookupHistoricalPrice(await readHistoricalSales(client, accountId, [id]), id, product));
  }

  suggestCustomerPrices(accountId: string, customers: readonly DraftPriceCustomer[]) {
    return readAccount(this.pool, accountId, client => suggestPrices(client, accountId, customers));
  }

  suggestDraftPrices(accountId: string, draftId: string) {
    return readAccount(this.pool, accountId, async client => {
      const draft = await readDraft(client, accountId, draftId);
      const customers = draftCustomersForPriceSuggestions(draft.customers);
      return { draftId, revision: draft.revision, suggestions: await suggestPrices(client, accountId, customers) };
    });
  }
}
