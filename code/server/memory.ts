import { Pool, PoolClient } from 'pg';
import {
  collectHistoricalSales, CustomerAlias, CustomerDirectory, DraftPriceCustomer, HistoricalSheet, lookupHistoricalPrice,
  normalizeMemoryText, ProductMention, resolveCustomerMention, suggestDraftCustomerMentions, suggestDraftPrices,
} from '../miniprogram/core/memory';
import { missingDraft, readAccount, readParties, readWorkspace, workspaceDraft, writeAccount } from './account-workspace';
import { HttpError } from './http-error';
import { readCommand, readId, uuidPattern, validSheetKey } from './request-input';

export interface AliasCommand {
  requestId: string;
  alias: string;
}

export interface BindCustomerAliasInput extends AliasCommand {
  customerId: string;
  allowRebind?: boolean;
  allowCanonicalConflict?: boolean;
}

function readAliasCommand(input: AliasCommand) {
  const { requestId } = readCommand(input);
  const { alias } = input;
  const normalizedAlias = typeof alias === 'string' ? normalizeMemoryText(alias) : '';
  if (!validSheetKey(alias) || !normalizedAlias) {
    throw new HttpError(400, 'invalid_customer_alias', '请输入有效的客户简称');
  }
  return { requestId, alias, normalizedAlias };
}

async function readAliases(client: PoolClient, accountId: string): Promise<CustomerAlias[]> {
  const { rows } = await client.query<CustomerAlias>(`
    SELECT customer_id AS "customerId", alias, normalized_alias AS "normalizedAlias"
    FROM dispatch.customer_aliases WHERE account_id = $1 ORDER BY normalized_alias
  `, [accountId]);
  return rows;
}

async function readDirectory(client: PoolClient, accountId: string): Promise<CustomerDirectory> {
  const customers = await readParties(client, accountId);
  const aliases = await readAliases(client, accountId);
  return { customers, aliases };
}

async function readDraft(client: PoolClient, accountId: string, draftId: string) {
  const workspace = await readWorkspace(client, accountId);
  if (workspace.id !== draftId) throw missingDraft();
  return workspaceDraft(workspace);
}

async function readHistoricalSales(client: PoolClient, accountId: string, customerIds: readonly string[]) {
  if (!customerIds.length) return [];
  // The sheet carries party_id even when the version snapshot has no embedded partyId.
  const { rows } = await client.query<HistoricalSheet>(`
    SELECT s.trip_id AS "tripId", s.id AS "sheetId", s.party_id AS "customerId", s.reviewed,
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

      const { rows: [existing] } = await client.query<CustomerAlias>(`
        SELECT customer_id AS "customerId", alias, normalized_alias AS "normalizedAlias"
        FROM dispatch.customer_aliases WHERE account_id = $1 AND normalized_alias = $2
      `, [accountId, normalizedAlias]);
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
    });
  }

  async unbindCustomerAlias(accountId: string, input: AliasCommand): Promise<{ removed: CustomerAlias | null }> {
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
      const customers = draft.customers.map(({ id, partyId: customerId, items }) => ({
        id, customerId,
        items: items.filter(item => item.price === null).map(item => ({
          id: item.id, productName: item.product, brand: item.brand, spec: item.specification, unit: item.unit, unitPriceCents: null,
        })),
      }));
      return { draftId, revision: draft.revision, suggestions: await suggestPrices(client, accountId, customers) };
    });
  }
}
