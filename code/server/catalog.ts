import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  catalogKey, matchCatalogChoice, matchCatalogItem, normalizeCatalogSpec, parseCatalogCsv, quotedLinePrices, resolveCatalogAutoPrice,
  type CatalogMatch, type CatalogVariant,
} from '../miniprogram/core/catalog';
import { money, nullablePrice, yuanToCents, type ItemInput } from '../miniprogram/core/orders';
import type { CustomerDraft, TripDraft } from '../miniprogram/core/trips';
import { readAccount, workspaceDraft, writeAccount } from './account-workspace';
import { checkDraft } from './agent/store';
import { setAccount, transaction } from './database';
import { itemIdentityChanged } from './draft-input';
import { HttpError } from './http-error';
import { readDirectory, readHistoricalSales } from './memory';
import { readId, readPreviewInput, uuidPattern, validSheetKey } from './request-input';

export type CatalogPriceUpdate = {
  draftCustomerId: string;
  lineId: string;
  product: string;
  beforePrice: string | null;
  beforeSource: ItemInput['priceSource'];
  price: string | null;
  priceSource: ItemInput['priceSource'];
  text: string;
};

export function catalogPriceUpdate(customer: CustomerDraft, before: ItemInput, item: ItemInput): CatalogPriceUpdate | null {
  if (nullablePrice(before.price) === item.price && (before.priceSource ?? null) === item.priceSource) return null;
  const labels = { catalog: '库内价', customer_history: '熟客价', spoken: '原话价', manual: '手改价' };
  const describe = (line: ItemInput) => line.price ? `${line.priceSource ? labels[line.priceSource] + ' ' : ''}¥${line.price}` : '待补价';
  return {
    draftCustomerId: customer.id, lineId: item.id, product: item.product,
    beforePrice: nullablePrice(before.price), beforeSource: before.priceSource ?? null,
    price: item.price, priceSource: item.priceSource ?? null,
    text: `${item.product}：${describe(before)} → ${describe(item)}`,
  };
}

const brandAliasPrefix = 'brand:';

export async function loadCatalog(client: PoolClient, accountId: string): Promise<CatalogVariant[]> {
  const { rows } = await client.query<CatalogVariant & { priceCents: string | number }>(`
    SELECT p.id AS "productId", p.product_code AS "productCode", p.category, p.product, p.brand,
           v.id AS "variantId", v.variant_code AS "variantCode", v.packaging, v.flavor_or_grade AS "flavorOrGrade",
           v.canonical_spec AS specification, v.unit, v.price_cents AS "priceCents", v.status,
           ARRAY(SELECT a.alias FROM dispatch.catalog_aliases a WHERE a.account_id = p.account_id
             AND a.product_id = p.id AND NOT starts_with(a.normalized_alias, $2) ORDER BY a.normalized_alias) AS aliases,
           ARRAY(SELECT a.alias FROM dispatch.catalog_aliases a WHERE a.account_id = p.account_id
             AND a.product_id = p.id AND starts_with(a.normalized_alias, $2) ORDER BY a.normalized_alias) AS "brandAliases"
    FROM dispatch.catalog_products p JOIN dispatch.catalog_variants v
      ON v.account_id = p.account_id AND v.product_id = p.id
    WHERE p.account_id = $1 AND NOT p.archived AND NOT v.archived
    ORDER BY p.product_code, v.variant_code
  `, [accountId, brandAliasPrefix]);
  return rows.map(row => ({ ...row, priceCents: Number(row.priceCents) }));
}

export function summarizeCatalog(catalog: readonly CatalogVariant[]) {
  return {
    productCount: new Set(catalog.map(variant => variant.productId)).size,
    variantCount: catalog.length,
    activeVariantCount: catalog.filter(variant => variant.status === 'active').length,
    discontinuedVariantCount: catalog.filter(variant => variant.status === 'discontinued').length,
    missingUnitVariantCount: catalog.filter(variant => variant.unit === null).length,
  };
}

export function suggestCatalogChoices(draft: TripDraft, catalog: readonly CatalogVariant[]) {
  if (!catalog.length) return [];
  return draft.customers.flatMap(customer => customer.items.flatMap(item => {
    if (!item.product.trim()) return [];
    const match = matchCatalogItem(item, catalog);
    if (match.status !== 'ambiguous') return [];
    return [{ draftCustomerId: customer.id, lineId: item.id, status: match.status, priceHint: match.hint ?? null,
      candidates: match.candidates.map(({ productId, variantId, product, brand, specification, unit, priceCents, status }) =>
        ({ productId, variantId, product, brand, specification, unit, priceCents, status })) }];
  }));
}

function groundedCatalogDetails(item: ItemInput, previous: ItemInput | undefined, source: string,
  catalog: readonly CatalogVariant[]): { item: ItemInput; unitGrounded: boolean } {
  const brand = catalogKey(item.brand);
  const specification = catalogKey(normalizeCatalogSpec(item.specification));
  const brandMentioned = (name: string) => Boolean(name && source.includes(name));
  const brandFamilyMentioned = (target: string) => brandMentioned(target) || catalog.some(variant => {
    const names = [variant.brand, ...(variant.brandAliases ?? [])].map(catalogKey).filter(Boolean);
    return names.includes(target) && names.some(brandMentioned);
  });
  const hasBrand = !brand || item.brand === previous?.brand || brandFamilyMentioned(brand);
  // Strip an ungrounded catalog brand prefix glued onto product (e.g. "秋丰鸭血" when source only says "鸭血").
  let product = item.product;
  if (product && product !== previous?.product) {
    const productKey = catalogKey(product);
    const catalogBrands = [...new Set(catalog.flatMap(variant => [variant.brand, ...(variant.brandAliases ?? [])])
      .filter(Boolean))].sort((a, b) => b.length - a.length);
    for (const candidateBrand of catalogBrands) {
      const candidateKey = catalogKey(candidateBrand);
      if (!candidateKey || brandFamilyMentioned(candidateKey) || !productKey.startsWith(candidateKey)) continue;
      const stripped = product.trim().replace(new RegExp(`^${candidateBrand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
      if (stripped && stripped.length < product.trim().length && source.includes(catalogKey(stripped))) {
        product = stripped;
        break;
      }
    }
  }
  // A package such as 500g must not match the tail of 1500g or 1.500g.
  const escapedSpec = specification.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasSpec = !specification || item.specification === previous?.specification ||
    new RegExp((/^\d/.test(specification) ? '(?<![\\d.])' : '') + escapedSpec).test(source);
  const unitKey = catalogKey(item.unit);
  const unitGrounded = !unitKey || item.unit === previous?.unit || source.includes(unitKey);
  return {
    item: { ...item, product, brand: hasBrand ? item.brand : '', specification: hasSpec ? item.specification : '' },
    unitGrounded,
  };
}

export async function applyCatalogToDraft(client: PoolClient, accountId: string, draft: TripDraft, before: TripDraft,
  catalog?: readonly CatalogVariant[], sourceText?: string) {
  const lines: string[] = [];
  const changes: { draftCustomerId: string; lineId: string; product: string; status: ItemInput['catalogStatus'];
    priceSource: ItemInput['priceSource'];
    price: string | null; priceHint: string | null;
    input: Pick<ItemInput, 'product' | 'brand' | 'specification' | 'unit'> }[] = [];
  const previously = new Map(before.customers.flatMap(customer =>
    customer.items.map(item => [item.id, { item, partyId: customer.partyId, customer: customer.customer }] as const)));
  const changed = draft.customers.flatMap(customer => customer.items.flatMap((item, index) => {
    if (!item.product.trim() && (sourceText !== undefined || nullablePrice(item.price) === null)) return [];
    const prior = previously.get(item.id);
    if (prior?.partyId === customer.partyId && prior?.item && JSON.stringify(prior.item) === JSON.stringify(item)) return [];
    return [{ customer, item, index }];
  }));
  if (!changed.length) return { lines, changes };
  const variants = catalog ?? await loadCatalog(client, accountId);
  if (!variants.length) return { lines, changes };
  const sales = await readHistoricalSales(client, accountId, [...new Set(changed.flatMap(({ customer }) =>
    customer.partyId ? [customer.partyId] : []))]);
  const directory = sourceText ? await readDirectory(client, accountId) : undefined;
  const normalizedSource = sourceText === undefined ? undefined : catalogKey(normalizeCatalogSpec(sourceText));
  const changedItems = new Set(changed.map(row => row.item));
  const targets = draft.customers.flatMap(customer => customer.items.filter(item => item.product.trim() || changedItems.has(item)).map(item => {
    const previous = previously.get(item.id);
    const aliases = directory?.aliases.filter(alias => alias.customerId === customer.partyId) ?? [];
    const grounded = normalizedSource !== undefined && changedItems.has(item)
      ? groundedCatalogDetails(item, previous?.item, normalizedSource, variants)
      : { item, unitGrounded: true };
    const input = grounded.item;
    const rawMatch = matchCatalogItem(input, variants);
    const match: CatalogMatch = !grounded.unitGrounded && 'variant' in rawMatch
      ? { status: 'unit_mismatch', candidates: [rawMatch.variant], hint: '原话未提到该计价单位，请核对单位后再配价' }
      : rawMatch;
    const matchedVariants = 'variant' in match ? [match.variant] : match.candidates;
    return { item, input, match, quote: {
      products: [input.product, previous?.item.product ?? '', ...matchedVariants.flatMap(variant => variant.aliases)],
      customers: [customer.customer, previous?.customer ?? '', ...aliases.map(alias => alias.alias)],
      specifications: [input.specification, input.brand,
        ...('variant' in match && match.variant.flavorOrGrade ? [match.variant.flavorOrGrade] : [])], unit: input.unit,
      requireProductMention: !previous?.item.product.trim(),
    } };
  }));
  const quotes = targets.map(row => row.quote);
  const byItem = new Map(targets.map(row => [row.item, row]));
  for (const { customer, item, index } of changed) {
    const { input, match, quote } = byItem.get(item)!;
    const previous = previously.get(item.id)?.item;
    const incomingPrice = nullablePrice(input.price);
    const freshPrice = incomingPrice !== null && (input.priceSource == null || input.priceSource === 'spoken')
      && (nullablePrice(previous?.price ?? null) !== incomingPrice || previous?.unit !== input.unit
        || (input.priceSource === 'spoken' && previous?.priceSource !== 'spoken'));
    const quoted = sourceText ? quotedLinePrices(sourceText, quote, quotes) : [];
    const imagePrice = sourceText === undefined && freshPrice;
    let candidate = input;
    if (imagePrice) {
      candidate = { ...input, price: null, priceSource: null };
    } else if (freshPrice && quoted.includes(yuanToCents(incomingPrice))) {
      candidate = { ...input, priceSource: 'spoken' };
    } else if (freshPrice) {
      const protectPrevious = previous && !itemIdentityChanged(input, previous)
        && (previous.priceSource == null || previous.priceSource === 'manual' || previous.priceSource === 'spoken');
      candidate = { ...input, price: protectPrevious ? previous.price : null,
        priceSource: protectPrevious ? previous.priceSource : null };
    }
    const next = resolveCatalogAutoPrice(candidate, match, customer.partyId, sales);
    if (imagePrice && next.price === null && yuanToCents(incomingPrice) > 0) {
      next.priceHint = [next.priceHint, `图片疑似标价 ¥${incomingPrice}（未自动填入，请核对）`].filter(Boolean).join(' · ');
    }
    if (quoted.length > 1 && (next.priceSource === 'catalog' || next.priceSource === 'customer_history')) {
      next.price = null;
      next.priceSource = null;
      next.priceHint = '原话有多个单价，请核对';
    }
    customer.items[index] = next;
    const update = catalogPriceUpdate(customer, previous ?? { ...item, price: null, priceSource: null }, next);
    if (!update && JSON.stringify(next) === JSON.stringify(item)) continue;
    const aligned = [next.product, next.brand, next.specification].join(' ') !== [item.product, item.brand, item.specification].join(' ');
    if (aligned) lines.push(`${customer.customer} ${item.product} → ${[next.brand, next.product, next.specification].filter(Boolean).join(' ')}`.trim());
    if (update) lines.push(update.text);
    if (next.priceHint) lines.push(`${next.product}：${next.priceHint}`);
    changes.push({ draftCustomerId: customer.id, lineId: item.id, product: next.product,
      status: next.catalogStatus, priceSource: next.priceSource, price: next.price, priceHint: next.priceHint ?? null,
      input: { product: input.product, brand: input.brand, specification: input.specification, unit: input.unit } });
  }
  return { lines, changes };
}

export class CatalogStore {
  constructor(private readonly pool: Pool) {}

  summary(accountId: string) {
    return readAccount(this.pool, accountId, async client => summarizeCatalog(await loadCatalog(client, accountId)));
  }

  async importCsv(account: string, csv: string | Buffer) {
    const sha256 = createHash('sha256').update(csv).digest();
    const rows = parseCatalogCsv(csv.toString());
    return transaction(this.pool, async client => {
      const { rows: [target] } = await client.query<{ id: string }>(uuidPattern.test(account)
        ? 'SELECT id FROM dispatch.accounts WHERE id = $1'
        : "SELECT id FROM dispatch.accounts WHERE identity_provider = 'development' AND identity_subject = $1",
      [account.replace(/^dev:/, '')]);
      if (!target) throw new Error('未找到目标账号，请先创建账号');
      const accountId = target.id;
      await setAccount(client, accountId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`dispatch.catalog:${accountId}`]);
      const batch = { accountId, sha256: sha256.toString('hex'),
        productCount: new Set(rows.map(row => row.productCode)).size, variantCount: rows.length,
        activeVariantCount: rows.filter(row => row.status === 'active').length,
        discontinuedVariantCount: rows.filter(row => row.status === 'discontinued').length,
        missingUnitVariantCount: rows.filter(row => row.unit === null).length };
      const { rows: [previous] } = await client.query<{ id: string }>(
        'SELECT id FROM dispatch.catalog_imports WHERE account_id = $1 AND sha256 = $2', [accountId, sha256]);
      if (previous) return { ...batch, importId: previous.id, replayed: true };
      // Draft writes lock the same workspace before consuming a catalog snapshot.
      await client.query('SELECT 1 FROM dispatch.workspaces WHERE account_id = $1 FOR UPDATE', [accountId]);
      const importId = randomUUID();
      await client.query('INSERT INTO dispatch.catalog_imports (account_id, id, sha256) VALUES ($1, $2, $3)',
        [accountId, importId, sha256]);
      const productIds = new Map<string, string>();
      const aliases = new Map<string, { productId: string; normalizedAlias: string; alias: string }>();
      for (const { productCode, category, product, brand } of rows) {
        if (productIds.has(productCode)) continue;
        const { rows: [saved] } = await client.query<{ id: string }>(`
          INSERT INTO dispatch.catalog_products (account_id, id, product_code, category, product, brand, import_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (account_id, product_code) DO UPDATE SET category = excluded.category,
            product = excluded.product, brand = excluded.brand, import_id = excluded.import_id, archived = false
          RETURNING id
        `, [accountId, randomUUID(), productCode, category, product, brand, importId]);
        productIds.set(productCode, saved.id);
      }
      for (const row of rows) {
        const productId = productIds.get(row.productCode)!;
        await client.query(`
          INSERT INTO dispatch.catalog_variants (account_id, id, product_id, variant_code, packaging,
            flavor_or_grade, canonical_spec, unit, price_cents, status, import_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (account_id, product_id, variant_code) DO UPDATE SET packaging = excluded.packaging,
            flavor_or_grade = excluded.flavor_or_grade, canonical_spec = excluded.canonical_spec, unit = excluded.unit,
            price_cents = excluded.price_cents, status = excluded.status, import_id = excluded.import_id, archived = false
        `, [accountId, randomUUID(), productId, row.variantCode, row.packaging, row.flavorOrGrade,
          row.specification, row.unit, row.priceCents, row.status, importId]);
        for (const [prefix, values] of [['product:', row.aliases], [brandAliasPrefix, row.brandAliases ?? []]] as const) {
          for (const alias of values) {
            const normalizedAlias = prefix + catalogKey(alias);
            aliases.set(JSON.stringify([productId, normalizedAlias]), { productId, normalizedAlias, alias });
          }
        }
      }
      await client.query('DELETE FROM dispatch.catalog_aliases WHERE account_id = $1', [accountId]);
      await client.query(`
        INSERT INTO dispatch.catalog_aliases (account_id, product_id, normalized_alias, alias)
        SELECT $1, a."productId", a."normalizedAlias", a.alias
        FROM jsonb_to_recordset($2::jsonb) AS a("productId" uuid, "normalizedAlias" text, alias text)
      `, [accountId, JSON.stringify([...aliases.values()])]);
      await client.query('UPDATE dispatch.catalog_variants SET archived = true WHERE account_id = $1 AND import_id <> $2 AND NOT archived',
        [accountId, importId]);
      await client.query('UPDATE dispatch.catalog_products SET archived = true WHERE account_id = $1 AND import_id <> $2 AND NOT archived',
        [accountId, importId]);
      return { ...batch, importId, replayed: false };
    });
  }

  chooseDraftCatalog(accountId: string, value: unknown) {
    const basis = readPreviewInput(value);
    const { choice, draftCustomerId, lineId, variantId } = value as Record<string, unknown>;
    if ((choice !== 'variant' && choice !== 'external') || !validSheetKey(draftCustomerId) || !validSheetKey(lineId)
      || (choice === 'external' && variantId !== undefined)) {
      throw new HttpError(400, 'invalid_catalog_choice', '请选择库内规格或按库外新货保留');
    }
    const selected = choice === 'variant' ? readId(variantId, '货品规格编号') : undefined;
    return writeAccount(this.pool, accountId, basis.requestId,
      { action: 'agent-catalog-choice', ...basis, choice, draftCustomerId, lineId, variantId: selected }, async (client, workspace) => {
        checkDraft(workspace, basis.draftId, basis.revision, true);
        const running = await client.query("SELECT 1 FROM dispatch.agent_turns WHERE account_id = $1 AND status = 'running'", [accountId]);
        if (running.rowCount) throw new HttpError(429, 'agent_busy', '助手正在处理上一条消息，请稍后再选。');
        const draft = workspaceDraft(workspace);
        const customer = draft.customers.find(entry => entry.id === draftCustomerId);
        const index = customer?.items.findIndex(entry => entry.id === lineId) ?? -1;
        if (!customer || index < 0 || !customer.items[index].product.trim()) {
          throw new HttpError(404, 'draft_line_not_found', '未找到这条草稿明细');
        }
        const item = customer.items[index];
        const catalog = await loadCatalog(client, accountId);
        if (!catalog.length) throw new HttpError(409, 'catalog_choice_changed', '账号尚无可选货品，请刷新草稿');
        const available = matchCatalogItem(item, catalog);
        let match: CatalogMatch = { status: 'external', candidates: [] };
        if (selected) {
          const variant = available.status === 'ambiguous' && available.candidates.find(candidate => candidate.variantId === selected);
          if (!variant) throw new HttpError(409, 'catalog_choice_changed', '候选规格已更新，请刷新后重新选择');
          match = matchCatalogChoice(item, variant);
        }
        const sales = match.status === 'active' && customer.partyId ? await readHistoricalSales(client, accountId, [customer.partyId]) : [];
        const next = { ...resolveCatalogAutoPrice(item, match, customer.partyId, sales), unit: item.unit };
        customer.items[index] = next;
        const revision = basis.revision + 1;
        const update = catalogPriceUpdate(customer, item, next);
        const priceUpdates = update ? [update] : [];
        await client.query('UPDATE dispatch.workspaces SET draft_revision = $2, draft_customers = $3 WHERE account_id = $1',
          [accountId, revision, JSON.stringify(draft.customers)]);
        await client.query(`INSERT INTO dispatch.agent_events (account_id, draft_id, kind, payload)
          VALUES ($1, $2, 'card', $3)`, [accountId, basis.draftId, JSON.stringify({
          action: 'catalog-choice', choice, draftCustomerId, lineId, variantId: selected, priceUpdates,
        })]);
        return { revision, item: next, priceUpdates };
      });
  }
}
