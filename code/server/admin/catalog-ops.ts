import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { catalogKey, exportCatalogCsv, matchCatalogItem, normalizeCatalogSpec, parseCatalogCsv,
  resolveCatalogAutoPrice, type CatalogRow, type CatalogVariant } from '../../miniprogram/core/catalog';
import { type ItemInput, yuanToCents } from '../../miniprogram/core/orders';
import { readAccount, readAccountResult, readWorkspace } from '../account-workspace';
import { brandAliasPrefix, bumpCatalogRevision, catalogImportAnchor, loadCatalog, lockCatalog, saveCatalogRows, summarizeCatalog } from '../catalog';
import { setAccount, transaction } from '../database';
import { HttpError } from '../http-error';
import { readHistoricalSales } from '../memory';
import { validRevision } from '../request-input';
import { type Input, inputText, invalidInput, requireId } from './http';
import { requireAccount } from './store';

const maxCsvBytes = 2 * 1024 * 1024;
export const maxCatalogJsonBytes = 6 * maxCsvBytes + 4096;
const previewLifetimeMs = 10 * 60_000;
const manualAnchor = createHash('sha256').update('dispatch.admin.catalog.manual.v1').digest();

async function revisionFor(client: PoolClient, accountId: string) {
  const { rows: [account] } = await client.query<{ revision: number }>(
    'SELECT catalog_revision AS revision FROM dispatch.accounts WHERE id = $1', [accountId]);
  if (!account) throw new HttpError(404, 'account_not_found', '未找到配送员账号');
  return account.revision;
}

function assertRevision(expected: number, current: number) {
  if (expected !== current) throw new HttpError(409, 'catalog_changed', '货品库已更新，请刷新或重新预演');
}

function rowsForCsv(body: Input) {
  if (typeof body.csv !== 'string') invalidInput('请提供货品 CSV 文本');
  if (Buffer.byteLength(body.csv) > maxCsvBytes) throw new HttpError(413, 'body_too_large', '货品 CSV 须在 2 MiB 以内');
  let rows: CatalogRow[];
  try {
    rows = parseCatalogCsv(body.csv, 5000);
    if (!rows.length) throw new Error('货品 CSV 至少需要一条货品规格');
    if (rows.some(row => Buffer.byteLength(row.productCode) > 800 || Buffer.byteLength(row.variantCode) > 800
      || [...row.aliases, ...(row.brandAliases ?? [])].some(alias => Buffer.byteLength(catalogKey(alias)) > 800))) {
      throw new Error('商品号、规格序号或别名过长');
    }
  } catch (error) {
    throw new HttpError(400, 'invalid_catalog_csv', error instanceof Error ? error.message : '货品 CSV 无法读取');
  }
  return { rows, sha256: createHash('sha256').update(body.csv).digest('hex') };
}

const entryKey = (row: CatalogRow) => JSON.stringify([row.productCode, row.variantCode]);
const productDetails = (row: CatalogRow) => [row.category, row.product, row.brand,
  row.originalName ?? '', row.verificationStatus ?? '', row.remarks ?? ''];

function diffRows(current: CatalogVariant[], incoming: CatalogRow[]) {
  const existing = new Map(current.map(row => [entryKey(row), row]));
  const products = new Set(current.map(row => row.productCode));
  const addedProducts = new Set<string>();
  const priceChanges = [];
  const statusChanges = [];
  const unitChanges = [];
  let addedVariants = 0;
  let unchangedCount = 0;
  const newUnits = new Map(current.map(row => [entryKey(row), row.unit]));
  for (const row of incoming) {
    const key = entryKey(row);
    const prior = existing.get(key);
    const common = { product: row.product, specification: row.specification, productCode: row.productCode,
      variantCode: row.variantCode };
    newUnits.set(key, row.unit);
    if (!products.has(row.productCode)) addedProducts.add(row.productCode);
    if (!prior) {
      addedVariants++;
      continue;
    }
    if (prior.priceCents !== row.priceCents) {
      priceChanges.push({ ...common, oldPriceCents: prior.priceCents, newPriceCents: row.priceCents });
    }
    if (prior.status !== row.status) statusChanges.push({ ...common, oldStatus: prior.status, newStatus: row.status });
    if (prior.unit !== row.unit) unitChanges.push({ ...common, oldUnit: prior.unit, newUnit: row.unit });
    if (prior.priceCents === row.priceCents && prior.status === row.status && prior.unit === row.unit
      && prior.packaging === row.packaging && prior.flavorOrGrade === row.flavorOrGrade
      && prior.specification === row.specification && JSON.stringify(productDetails(prior)) === JSON.stringify(productDetails(row))
      && row.aliases.every(alias => prior.aliases.includes(alias))
      && (row.brandAliases ?? []).every(alias => prior.brandAliases?.includes(alias))) unchangedCount++;
  }
  return { addedProducts: addedProducts.size, addedVariants, priceChanges, statusChanges, unitChanges, unchangedCount,
    missingUnitCount: [...newUnits.values()].filter(unit => unit === null).length, errors: [] };
}

type CatalogPreview = { accountId: string; sha256: string; catalogRevision: number; mode: 'incremental'; expiresAt: number };

function signature(secret: string, encoded: string) {
  return createHmac('sha256', secret).update('dispatch.admin.catalog.preview.v1:').update(encoded).digest();
}

function signedPreview(secret: string, preview: CatalogPreview) {
  const encoded = Buffer.from(JSON.stringify(preview)).toString('base64url');
  return encoded + '.' + signature(secret, encoded).toString('base64url');
}

function verifiedPreview(secret: string, token: unknown, accountId: string): CatalogPreview {
  const invalid = () => new HttpError(400, 'invalid_catalog_preview', '预演凭证无效，请重新预演');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  const [encoded, mac] = token.split('.');
  const supplied = Buffer.from(mac, 'base64url');
  if (!timingSafeEqual(signature(secret, encoded), supplied)) throw invalid();
  const preview = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CatalogPreview;
  if (preview.accountId !== accountId || preview.mode !== 'incremental') throw invalid();
  return preview;
}

async function catalogWrite<T>(pool: Pool, accountId: string, work: (client: PoolClient, revision: number) => Promise<T>) {
  return transaction(pool, async client => {
    await setAccount(client, accountId);
    await requireAccount(client, accountId);
    await lockCatalog(client, accountId);
    await readWorkspace(client, accountId, true);
    return work(client, await revisionFor(client, accountId));
  });
}

export function readCatalogBoard(pool: Pool, accountId: string) {
  return readAccount(pool, accountId, async client => {
    const catalogRevision = await revisionFor(client, accountId);
    const items = await loadCatalog(client, accountId, true);
    const { rows: [latest] } = await client.query<{ importedAt: Date }>(`
      SELECT imported_at AS "importedAt" FROM dispatch.catalog_imports
      WHERE account_id = $1 AND source <> 'manual' ORDER BY imported_at DESC LIMIT 1
    `, [accountId]);
    return { summary: summarizeCatalog(items), importedAt: latest?.importedAt ?? null, catalogRevision,
      categories: [...new Set(items.map(row => row.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')), items };
  });
}

export function readCatalogCsv(pool: Pool, accountId: string) {
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    return exportCatalogCsv(await loadCatalog(client, accountId, true));
  });
}

export function previewImport(pool: Pool, accountId: string, secret: string, body: Input) {
  const { rows, sha256 } = rowsForCsv(body);
  return readAccount(pool, accountId, async client => {
    const catalogRevision = await revisionFor(client, accountId);
    const current = await loadCatalog(client, accountId, true);
    const expiresAt = Date.now() + previewLifetimeMs;
    const mode = 'incremental';
    return { valid: true, mode, sha256, catalogRevision, expiresAt: new Date(expiresAt).toISOString(),
      ...diffRows(current, rows), previewToken: signedPreview(secret, { accountId, sha256, catalogRevision, mode, expiresAt }) };
  });
}

type ImportResult = ReturnType<typeof diffRows> & { catalogRevision: number; importId: string; mode: 'incremental' };

export function confirmImport(pool: Pool, accountId: string, secret: string, body: Input) {
  const { rows, sha256 } = rowsForCsv(body);
  const requestId = inputText(body.requestId, '请求编号', 200, true);
  const preview = verifiedPreview(secret, body.previewToken, accountId);
  if (preview.sha256 !== sha256) throw new HttpError(400, 'invalid_catalog_preview', 'CSV 与预演内容不同，请重新预演');
  return catalogWrite(pool, accountId, async (client, revision) => {
    const { inputDigest, previous } = await readAccountResult<ImportResult>(client, accountId, requestId,
      { action: 'admin-catalog-import', sha256, mode: preview.mode });
    if (previous) return previous.result;
    if (preview.expiresAt <= Date.now()) throw new HttpError(400, 'invalid_catalog_preview', '预演已过期，请重新预演');
    assertRevision(preview.catalogRevision, revision);
    const diff = diffRows(await loadCatalog(client, accountId, true), rows);
    // Keep CLI replace-mode idempotency independent from web incremental imports of the same bytes.
    const digest = createHash('sha256').update('dispatch.admin.catalog.incremental:').update(sha256).digest();
    const importId = await catalogImportAnchor(client, accountId, digest, 'admin_csv');
    await saveCatalogRows(client, accountId, importId, rows);
    const catalogRevision = await bumpCatalogRevision(client, accountId);
    const result: ImportResult = { ...diff, importId, catalogRevision, mode: preview.mode };
    await client.query(`INSERT INTO dispatch.request_results (account_id, request_id, input_digest, result)
      VALUES ($1, $2, $3, $4)`, [accountId, requestId, inputDigest, JSON.stringify(result)]);
    return result;
  });
}

function aliasesOf(value: unknown, fallback: string[], label: string) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 100) invalidInput(`请提供最多 100 个${label}`);
  const aliases = new Map<string, string>();
  for (const entry of value) {
    const alias = inputText(entry, label, 200, true);
    const key = catalogKey(alias);
    if (!key || Buffer.byteLength(key) > 800) invalidInput(`请提供有效的${label}`);
    aliases.set(key, alias);
  }
  return [...aliases.values()];
}

function manualRow(body: Input, base?: CatalogVariant, creating = false): CatalogRow {
  const field = (name: keyof CatalogRow, label: string, limit = 200, required = false) =>
    inputText(body[name] === undefined ? base?.[name] ?? '' : body[name], label, limit, required);
  const { priceCents } = body;
  if (typeof priceCents !== 'number' || !Number.isSafeInteger(priceCents) || priceCents <= 0) {
    invalidInput('挂牌价须为大于零的整数分');
  }
  const status = body.status === undefined && !creating ? base?.status : body.status;
  if (status !== 'active' && status !== 'discontinued') invalidInput('销售状态须为 active 或 discontinued');
  const productCode = base?.productCode ?? (body.productCode === undefined ? 'M-' + randomUUID() : field('productCode', '总商品号', 200, true));
  const variantCode = creating
    ? (body.variantCode === undefined ? 'V-' + randomUUID() : field('variantCode', '规格序号', 200, true))
    : base!.variantCode;
  const packaging = normalizeCatalogSpec(field('packaging', '包装规格'));
  const flavorOrGrade = (body.flavorOrGrade === null ? '' : normalizeCatalogSpec(field('flavorOrGrade', '售卖规格'))) || null;
  const specification = body.specification !== undefined ? normalizeCatalogSpec(field('specification', '标准规格'))
    : !creating && body.packaging === undefined && body.flavorOrGrade === undefined ? base!.specification
      : [packaging, flavorOrGrade].filter(Boolean).join('·');
  const rawUnit = body.unit === undefined ? base?.unit : body.unit;
  const unit = rawUnit == null ? null : catalogKey(inputText(rawUnit, '计价单位', 200, true));
  if (specification.length > 200 || packaging.length > 200 || (flavorOrGrade?.length ?? 0) > 200 || (unit?.length ?? 0) > 200) {
    invalidInput('规格或计价单位过长');
  }
  if (unit === '') invalidInput('计价单位须非空或为 null');
  return { productCode, variantCode, packaging, flavorOrGrade, specification, unit, priceCents, status,
    category: field('category', '分类'), product: field('product', '品名', 200, true), brand: field('brand', '品牌'),
    originalName: field('originalName', '原商品名', 1000), verificationStatus: field('verificationStatus', '详情核实状态'),
    remarks: field('remarks', '备注', 4000), aliases: aliasesOf(body.aliases, base?.aliases ?? [], '货品别名'),
    brandAliases: aliasesOf(body.brandAliases, base?.brandAliases ?? [], '品牌别名') };
}

export function saveManualItem(pool: Pool, accountId: string, body: Input, variantId?: string) {
  const expected = body.expectedRevision;
  if (expected !== undefined && !validRevision(expected)) invalidInput('请提供有效的货品库版本号');
  return catalogWrite(pool, accountId, async (client, revision) => {
    if (typeof expected === 'number') assertRevision(expected, revision);
    const catalog = await loadCatalog(client, accountId, true);
    const productId = body.productId === undefined ? null : requireId(body.productId, '货品编号');
    const existing = variantId ? catalog.find(row => row.variantId === variantId)
      : catalog.find(row => productId ? row.productId === productId : row.productCode === body.productCode);
    if ((variantId || productId) && !existing) throw new HttpError(404, 'catalog_item_not_found', '未找到本账号的货品或规格');
    const row = manualRow(body, existing, !variantId);
    if (!variantId) {
      const { rowCount } = await client.query(`SELECT 1 FROM dispatch.catalog_products p
        JOIN dispatch.catalog_variants v ON v.account_id = p.account_id AND v.product_id = p.id
        WHERE p.account_id = $1 AND p.product_code = $2 AND v.variant_code = $3`, [accountId, row.productCode, row.variantCode]);
      if (rowCount) throw new HttpError(409, 'catalog_variant_exists', '此商品已有相同规格序号');
    }
    const importId = await catalogImportAnchor(client, accountId, manualAnchor, 'manual');
    if (existing && (body.aliases !== undefined || body.brandAliases !== undefined)) {
      await client.query(`DELETE FROM dispatch.catalog_aliases WHERE account_id = $1 AND product_id = $2
        AND (($3 AND NOT starts_with(normalized_alias, $5)) OR ($4 AND starts_with(normalized_alias, $5)))`,
      [accountId, existing.productId, body.aliases !== undefined, body.brandAliases !== undefined, brandAliasPrefix]);
    }
    const [savedId] = await saveCatalogRows(client, accountId, importId, [row]);
    return { catalogRevision: await bumpCatalogRevision(client, accountId),
      item: (await loadCatalog(client, accountId, true)).find(item => item.variantId === savedId)! };
  });
}

function queryFields(body: Input, catalog: CatalogVariant[]) {
  const query = body.query === undefined ? '' : inputText(body.query, '试查语句', 200);
  const prepared = query.normalize('NFKC').replace(/\s+/gu, '');
  const quantity = prepared.match(/(\d+)(公斤|千克|[箱袋盒包板卷件桶瓶个支提盘条只组份斤])$/u);
  const unit = quantity?.[2] ?? '';
  const phrase = quantity?.index === undefined ? prepared : prepared.slice(0, quantity.index);
  const brands = [...new Set(catalog.flatMap(row => [row.brand, ...(row.brandAliases ?? [])]).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const brand = brands.find(value => catalogKey(phrase).startsWith(catalogKey(value))) ?? '';
  const withoutBrand = brand ? catalogKey(phrase).slice(catalogKey(brand).length) : phrase;
  const spec = withoutBrand.match(/\d+(?:\.\d+)?(?:千克|公斤|克|毫升|升|kg|g|ml|l)(?=$|[^a-z])/iu);
  const product = spec?.index === undefined ? withoutBrand : withoutBrand.slice(0, spec.index) + withoutBrand.slice(spec.index + spec[0].length);
  return {
    product: inputText(body.product ?? product, '品名', 200, true),
    brand: inputText(body.brand ?? brand, '品牌', 200),
    specification: inputText(body.specification ?? spec?.[0] ?? '', '规格', 200),
    unit: inputText(body.unit ?? unit, '计价单位', 200),
  };
}

export function testCatalogQuery(pool: Pool, accountId: string, body: Input) {
  const customerId = body.customerId === undefined || body.customerId === null ? null : requireId(body.customerId, '客户编号');
  return readAccount(pool, accountId, async client => {
    await requireAccount(client, accountId);
    const catalog = await loadCatalog(client, accountId);
    const fields = queryFields(body, catalog);
    const item: ItemInput = { ...fields, id: '', price: null, quantity: '' };
    if (customerId && !(await client.query('SELECT 1 FROM dispatch.parties WHERE account_id = $1 AND id = $2', [accountId, customerId])).rowCount) {
      throw new HttpError(404, 'customer_not_found', '未找到本账号的客户');
    }
    const match = matchCatalogItem(item, catalog);
    const line = resolveCatalogAutoPrice(item, match, customerId,
      customerId ? await readHistoricalSales(client, accountId, [customerId]) : []);
    return { fields, status: line.catalogStatus, matchMethod: match.matchMethod ?? null,
      item: 'variant' in match ? match.variant : null, candidates: 'variant' in match ? [match.variant] : match.candidates,
      priceCents: line.price === null ? null : yuanToCents(line.price), priceSource: line.priceSource,
      discontinued: line.catalogStatus === 'discontinued',
      reason: line.price === null ? line.priceHint ?? '库内未找到可用的对应货品，请核对品名、规格和单位' : null };
  });
}
