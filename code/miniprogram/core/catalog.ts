import { lookupDeliveredPrice, normalizeMemoryText, type HistoricalSale } from './memory';
import { spokenNumbers } from './spoken-numbers';
import { money, nullablePrice, yuanToCents, type ItemInput } from './orders';

export const catalogCsvColumns = [
  '总商品号', '规格序号', '分类', '原商品名', '品牌', '标准品名', '包装规格', '售卖规格', '计价单位',
  '挂牌价(元)', '销售状态', '详情核实状态', '备注/纠偏线索',
] as const;

export interface CatalogRow {
  productCode: string;
  variantCode: string;
  category: string;
  product: string;
  brand: string;
  packaging: string;
  flavorOrGrade: string | null;
  specification: string;
  unit: string | null;
  priceCents: number;
  status: 'active' | 'discontinued';
  aliases: string[];
  brandAliases?: string[];
}

export interface CatalogVariant extends CatalogRow {
  productId: string;
  variantId: string;
}

export function catalogKey(value: string | null | undefined): string {
  return normalizeMemoryText(value?.normalize('NFKC')).replace(/\s+/g, '').replace(/[‐‑–—－]/g, '-');
}

export function normalizeCatalogSpec(value: string): string {
  return value.trim().normalize('NFKC').replace(/\s*\(\s*(?:原写|原标|原记)[^()]*\)/g, '').trim()
    .replace(/(\d)\s*(千克|公斤|克|kg|g|ml|l)(?![a-z])/gi,
      (_, number: string, unit: string) => number + ({ 千克: 'kg', 公斤: 'kg', 克: 'g' }[unit] ?? unit.toLowerCase()))
    .replace(/[‐‑–—－]/g, '-');
}

function csvCells(csv: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let value = '';
  let quoted = false;
  let closed = false;
  const finish = () => {
    fields.push(value.trim());
    value = '';
    closed = false;
  };
  const endRow = () => {
    const present = fields.length > 0 || Boolean(value.trim()) || closed;
    finish();
    if (present) rows.push(fields);
    fields = [];
  };
  for (let offset = 0; offset < csv.length; offset++) {
    const char = csv[offset];
    if (quoted) {
      if (char !== '"') value += char;
      else if (csv[offset + 1] === '"') { value += '"'; offset++; }
      else { quoted = false; closed = true; }
    } else if (char === '"') {
      if (closed || value) throw new Error('CSV 引号格式不正确');
      quoted = true;
    } else if (char === ',') finish();
    else if (char === '\r' || char === '\n') {
      endRow();
      if (char === '\r' && csv[offset + 1] === '\n') offset++;
    } else {
      if (closed) throw new Error('CSV 引号后须为分隔符或换行');
      value += char;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  endRow();
  return rows;
}

function catalogAliasClues(remarks: string) {
  const clues: { label: string; value: string }[] = [];
  const cue = /(?:(?:品牌|厂牌)(?:似为|全称|名称|名|为|是)?|包装(?:上)?(?:的)?(?:全称|名称|品名|(?:实际|实|上)?印(?:有|着)?|标(?:注|为)?|写(?:着|为)?)|(?:建议|可)?(?:添加|加|补充|补|增加|新增|设为|记为|用作)(?:一个)?别名|别名(?:为|是)?|原(?:商品)?名(?:原)?(?:写|标|为|叫|是)(?:作|为)?|原(?:写|标|记|称|叫|作)(?:为|作)?|(?:实际|实为|应为|更正为|纠正为|正确(?:品名|名称)为|应写作|误写为|俗称|又称|也叫|简称(?:为)?))/g;
  const quotedPattern = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|《[^》]*》|‘[^’]*’|'[^']*'/g;
  const searchable = remarks.replace(quotedPattern, value => ' '.repeat(value.length));
  let match: RegExpExecArray | null;
  while ((match = cue.exec(searchable))) {
    const remainder = remarks.slice(match.index + match[0].length).trim();
    const tail = remainder.replace(/^[:：=]\s*/, '');
    const quoted = tail.match(/^[「『“"《‘']([^」』”"》’']+)[」』”"》’']/);
    if (/^(品牌|厂牌)$/.test(match[0]) && !quoted && !/^[:：=]/.test(remainder)) continue;
    const raw = quoted?.[1] ?? tail.split(/[；;，,。\r\n（(]|(?:并非|而非|应为|实为|实际|建议|原写|原名|包装)/)[0].trim();
    if (raw && !/^[-\d.]+(?:[a-z%]+)?$/i.test(raw)) clues.push({ label: match[0], value: raw });
  }
  return clues;
}

function uniqueAliases(values: readonly string[]) {
  const seen = new Set<string>();
  return values.map(value => value.trim()).filter(value => {
    const key = catalogKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractCatalogAliases(original: string, remarks: string): string[] {
  return uniqueAliases([original, ...catalogAliasClues(remarks).map(clue => clue.value)]);
}

export function parseCatalogCsv(input: string): CatalogRow[] {
  if (input.includes('\0') || input.includes('\uFFFD')) throw new Error('CSV 须使用有效的 UTF-8 文本');
  const [header, ...records] = csvCells(input.replace(/^\uFEFF/, ''));
  if (!header || header.length !== catalogCsvColumns.length || !catalogCsvColumns.every((name, i) => name === header[i])) {
    throw new Error('货品 CSV 表头须为标准 13 列');
  }
  if (!records.length) throw new Error('货品 CSV 至少需要一条货品规格');
  const seen = new Set<string>();
  const products = new Map<string, string>();
  return records.map((cells, index) => {
    const invalid = (reason: string): never => { throw new Error(`货品 CSV 第 ${index + 2} 行：${reason}`); };
    if (cells.length !== catalogCsvColumns.length) invalid('必须包含 13 列');
    const [productCode, variantCode, category, original, brand, product, rawSpec, saleSpec, rawUnit, price, status, , remarks] = cells;
    if (!productCode || !variantCode || !product) invalid('总商品号、规格序号和标准品名必填');
    if ([product, brand, rawSpec, saleSpec, rawUnit].some(field => field.length > 200)) invalid('规格字段过长');
    const key = JSON.stringify([productCode, variantCode]);
    if (seen.has(key)) invalid('总商品号与规格序号重复');
    seen.add(key);
    const productIdentity = JSON.stringify([product, brand, category]);
    if (products.has(productCode) && products.get(productCode) !== productIdentity) invalid('同一总商品号的标准品名、品牌和分类须一致');
    products.set(productCode, productIdentity);
    const priceCents = yuanToCents(price);
    if (!Number.isSafeInteger(priceCents) || priceCents <= 0) invalid('挂牌价须为大于零且最多两位小数的金额');
    if (status !== '在售' && status !== '已下架') invalid('销售状态须为在售或已下架');
    const packaging = normalizeCatalogSpec(rawSpec);
    const sale = normalizeCatalogSpec(saleSpec);
    const flavorOrGrade = !sale || /^(?:单规格|未点开(?:\(.*\))?|\d*\s*[箱袋盒包板卷件桶瓶个支提盘条只组份](?:\s*[/／]\s*[箱袋盒包板卷件桶瓶个支提盘条只组份])?)$/.test(sale)
      ? null : sale;
    const specification = [packaging, flavorOrGrade].filter(Boolean).join('·');
    if (specification.length > 200) invalid('标准规格过长');
    const aliases = [original];
    const brandAliases: string[] = [];
    for (const { label, value } of catalogAliasClues(remarks)) {
      const isBrandClue = /^(?:品牌|厂牌)|^包装(?:上)?(?:的)?全称$/.test(label);
      const namesProduct = specKey(value).includes(specKey(product));
      (isBrandClue && !namesProduct ? brandAliases : aliases).push(value);
    }
    return {
      productCode, variantCode, category, product, brand, packaging, flavorOrGrade, specification,
      unit: rawUnit ? catalogKey(rawUnit) : null, priceCents,
      status: status === '在售' ? 'active' : 'discontinued', aliases: uniqueAliases(aliases), brandAliases: uniqueAliases(brandAliases),
    };
  });
}

type MatchFields = Pick<ItemInput, 'product' | 'brand' | 'specification' | 'unit' | 'catalogProductId' | 'catalogVariantId' | 'catalogStatus' | 'priceHint'>;
export type CatalogMatch =
  | { status: 'active' | 'discontinued'; variant: CatalogVariant }
  | { status: 'unit_mismatch'; candidates: CatalogVariant[]; hint: string; selectedVariant?: CatalogVariant }
  | { status: 'ambiguous' | 'unmatched' | 'external'; candidates: CatalogVariant[]; hint?: string };

function specKey(value: string) { return catalogKey(normalizeCatalogSpec(value)); }

function variantKeys(variant: CatalogVariant) {
  const { brand, brandAliases = [], product, aliases, packaging, flavorOrGrade, specification } = variant;
  const brands = new Set([brand, ...brandAliases].map(catalogKey).filter(Boolean));
  const productKey = specKey(product);
  const names = new Set([product, ...aliases].map(specKey).filter(name => name && !brands.has(name)));
  for (const name of [...names]) {
    if (name !== productKey && [...brands].some(key => name.startsWith(key))) continue;
    for (const key of brands) if (!name.startsWith(key)) names.add(key + name);
  }
  const details = new Set([packaging, flavorOrGrade ?? '', specification,
    flavorOrGrade ? packaging + flavorOrGrade : ''].map(specKey).filter(Boolean));
  const combined = new Set<string>();
  for (const name of names) for (const detail of details) {
    if (flavorOrGrade && detail === specKey(packaging)) continue;
    combined.add(name + detail);
    combined.add(name + '·' + detail);
    combined.add(detail + name);
  }
  return { names, details, combined, brands };
}

function unitMismatch(item: MatchFields, candidates: CatalogVariant[]): Extract<CatalogMatch, { status: 'unit_mismatch' }> {
  const unit = item.unit.trim();
  const prices = [...new Set(candidates.map(variant => variant.unit
    ? `${variant.unit} ¥${money(variant.priceCents)}`
    : `¥${money(variant.priceCents)}（未标${unit ? unit + '价' : '计价单位'}）`))];
  return { status: 'unit_mismatch', candidates, hint: `库内仅记 ${prices.join(' / ')}` };
}

export function matchCatalogChoice(item: MatchFields, variant: CatalogVariant): CatalogMatch {
  if (variant.unit !== null && variant.unit === catalogKey(item.unit)) return { status: variant.status, variant };
  return { ...unitMismatch(item, [variant]), selectedVariant: variant };
}

export function matchCatalogItem(item: MatchFields, catalog: readonly CatalogVariant[]): CatalogMatch {
  if (item.catalogStatus === 'external') return { status: 'external', candidates: [] };
  const name = specKey(item.product);
  const brand = catalogKey(item.brand);
  const detail = specKey(item.specification);
  if (!name) return { status: 'unmatched', candidates: [] };
  const candidates = catalog.filter(variant => {
    if (item.catalogProductId && variant.productId !== item.catalogProductId) return false;
    if (item.catalogVariantId && variant.variantId !== item.catalogVariantId) return false;
    const keys = variantKeys(variant);
    return (!brand || keys.brands.has(brand)) && (!detail || keys.details.has(detail)) &&
      (keys.names.has(name) || keys.combined.has(name));
  }).sort((a, b) => Number(a.status === 'discontinued') - Number(b.status === 'discontinued')
      || a.productCode.localeCompare(b.productCode) || a.variantCode.localeCompare(b.variantCode));
  if (!candidates.length) return { status: 'unmatched', candidates: [] };
  if (item.catalogProductId && !item.catalogVariantId
    && (item.catalogStatus === 'unit_mismatch' || item.catalogStatus === 'discontinued')) {
    // A selection without a compatible unit identifies the product only.
    const mismatch = unitMismatch(item, candidates);
    return { ...mismatch, hint: item.priceHint || mismatch.hint };
  }
  // A sales unit may distinguish packaging, but cannot choose between different products or flavors.
  if (new Set(candidates.map(variant => JSON.stringify([variant.productId, variant.flavorOrGrade]))).size > 1) {
    return { status: 'ambiguous', candidates, hint: '库内有多款货品或规格，请选定后核对单价' };
  }
  const unit = catalogKey(item.unit);
  const exact = candidates.filter(variant => variant.unit !== null && variant.unit === unit);
  if (exact.length === 1) return { status: exact[0].status, variant: exact[0] };
  if (exact.length > 1) return { status: 'ambiguous', candidates, hint: '库内有多个相同计价单位的规格，请选定' };
  return unitMismatch(item, candidates);
}

export function resolveCatalogAutoPrice(item: ItemInput, match: CatalogMatch, customerId?: string | null,
  sales: readonly HistoricalSale[] = []): ItemInput {
  const price = nullablePrice(item.price);
  // Older drafts did not record provenance, so preserve their non-empty prices as manual.
  const source = item.priceSource ?? (price === null ? null : 'manual');
  const protectedPrice = price !== null && (source === 'spoken' || source === 'manual');
  const next: ItemInput = {
    ...item, price: protectedPrice ? price : null, priceSource: protectedPrice ? source : null,
    catalogProductId: null, catalogVariantId: null, catalogStatus: match.status, priceHint: null,
  };
  if (!('variant' in match)) {
    next.priceHint = match.hint ?? null;
    if (match.status === 'unit_mismatch') {
      if (match.selectedVariant) {
        const { product, brand, specification, productId } = match.selectedVariant;
        Object.assign(next, { product, brand, specification, catalogProductId: productId });
      } else if (item.catalogProductId && match.candidates.some(variant => variant.productId === item.catalogProductId)) {
        next.catalogProductId = item.catalogProductId;
      }
      const discontinued = (next.catalogProductId && next.catalogProductId === item.catalogProductId
        && !item.catalogVariantId && item.catalogStatus === 'discontinued')
        || match.candidates.every(variant => variant.status === 'discontinued');
      if (discontinued) {
        next.catalogStatus = 'discontinued';
        if (!match.hint.startsWith('已下架')) next.priceHint = `已下架，请核实库存。 ${match.hint}`;
      }
    }
    return next;
  }
  const { variant } = match;
  Object.assign(next, {
    product: variant.product, brand: variant.brand, specification: variant.specification, unit: variant.unit ?? item.unit,
    catalogProductId: variant.productId, catalogVariantId: variant.variantId,
  });
  if (match.status === 'discontinued') {
    next.priceHint = '已下架，请核实库存';
    return next;
  }
  if (protectedPrice) return next;
  const history = customerId ? lookupDeliveredPrice(sales, customerId, {
    catalogVariantId: variant.variantId, productName: variant.product, brand: variant.brand,
    spec: variant.specification, unit: variant.unit,
  }) : { status: 'no_match' as const };
  if (history.status === 'conflict') {
    next.priceHint = '最近一张已送达单据有多个成交价，请核对';
  } else if (history.status === 'matched') {
    next.price = money(history.unitPriceCents);
    next.priceSource = 'customer_history';
  } else {
    next.price = money(variant.priceCents);
    next.priceSource = 'catalog';
  }
  return next;
}

export interface QuotedPriceLine {
  products: readonly string[];
  customers?: readonly string[];
  specifications?: readonly string[];
  unit: string;
  requireProductMention?: boolean;
}

export function quotedLinePrices(text: string, line: QuotedPriceLine,
  candidates: readonly QuotedPriceLine[] = [line]): number[] {
  const source = text.normalize('NFKC').toLowerCase();
  const boundary = /[。;；!！?？\r\n]/;
  const measures = '[箱袋盒包板卷件桶瓶个支提盘条只组份斤]|公斤|千克';
  const prices = new Set<number>();
  for (const token of spokenNumbers(source)) {
    if (token.value === null) continue;
    const cents = yuanToCents(String(token.value));
    if (!Number.isSafeInteger(cents) || cents <= 0) continue;
    const before = source.slice(0, token.start);
    const after = source.slice(token.end);
    const quoted = source.slice(token.start, token.end);
    const local = before.split(boundary).pop() ?? '';
    const priceLabel = /(?:单价|价格|每(?:箱|袋|盒|包|斤|公斤|件|个))\s*(?:是|算|定|报价|改成|改为|调到|为)?\s*$/.test(local);
    const perUnit = after.match(new RegExp(`^\\s*(?:元|块)?\\s*(?:[/／每一1])\\s*(${measures})`));
    if (perUnit && line.unit && catalogKey(perUnit[1]) !== catalogKey(line.unit)) continue;
    const marked = /[元块]/.test(quoted) || /[¥￥]\s*$/.test(local) || priceLabel;
    if (!marked && !perUnit) continue;
    if (/(?:不是|不要按|别按)\s*[¥￥]?\s*$/.test(local)) continue;

    const segment = local || (before.slice(0, -1).split(boundary).pop() ?? '');
    const localAfter = after.split(boundary)[0];
    // Reuse the closest preceding mention, and allow a leading price when this clause names the row afterwards.
    const nearest = (terms: readonly string[], preceding: string, following: string) =>
      terms.reduce((score, raw) => {
        const term = raw.normalize('NFKC').trim().toLowerCase();
        if (!term) return score;
        const index = preceding.lastIndexOf(term);
        if (index >= 0) return Math.max(score, (index + term.length) * 1000 + term.length);
        const followingIndex = following.indexOf(term);
        return followingIndex < 0 ? score : Math.max(score, -100000 - followingIndex * 1000 + term.length);
      }, -Infinity);
    const compatible = candidates.filter(candidate =>
      !perUnit || !candidate.unit || catalogKey(candidate.unit) === catalogKey(perUnit[1]));
    const productScore = (row: QuotedPriceLine) => nearest(row.products, segment, localAfter);
    const product = productScore(line);
    if (line.requireProductMention && product === -Infinity) continue;
    if (compatible.some(row => productScore(row) > product)) continue;
    const possible = compatible.filter(row => productScore(row) === product);
    const scores = (row: QuotedPriceLine) => [
      nearest(row.customers ?? [], before, localAfter),
      nearest(row.specifications ?? [], segment, localAfter),
    ];
    const [customer, spec] = scores(line);
    const competing = possible.some(row => {
      if (row === line) return false;
      const [otherCustomer, otherSpec] = scores(row);
      return otherCustomer > customer || (otherCustomer === customer && otherSpec >= spec);
    });
    if (!competing) prices.add(cents);
  }
  return [...prices];
}

export function hasQuotedLinePrice(text: string, cents: number, line: QuotedPriceLine,
  candidates?: readonly QuotedPriceLine[]): boolean {
  return quotedLinePrices(text, line, candidates).includes(cents);
}
