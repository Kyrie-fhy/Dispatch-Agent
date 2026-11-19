import type { DeliveryLine } from './delivery-execution';
import { unitPrice } from './orders';
import { spokenNumbers } from './spoken-numbers';

export const deliveryMessageLimit = 200;
const digits = '[一二两俩三仨四五六七八九]';
const tens = `(?:${digits}?十${digits}?|${digits})`;
const hundreds = `${digits}百(?:零${digits}|${digits}十${digits}?|${digits})?`;
const chineseInteger = `(?:${digits}千(?:零${tens}|${hundreds}|${digits})?|${hundreds}|${tens}|[零〇])`;
const integer = `(?:0|[1-9][0-9]*|${chineseInteger})`;
const quantityPattern = new RegExp(`^(.*?)\\s*(?:实收(?:数量)?|只收(?:了)?|收了)\\s*(?:改成|改为|为|是|:)?\\s*(${integer})\\s*([^0-9零〇一二两俩三仨四五六七八九十百千万亿点.\\s]*)$`);
const pricePattern = /^(.*?)\s*(?:单价|补价)\s*(?:改成|改为|为|是|:)?\s*(.+)$/;
const spokenPrice = new RegExp(`^${chineseInteger}(?:点[零〇一二三四五六七八九]{1,2}(?:元|块)?|[元块](?:${digits}[角毛分]?)?)?$`);
const numericPrice = /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?(?:元|块)?$/;

type Edit = { target: string; unit?: string; receivedQuantity?: number; price?: string };

function spokenValue(text: string) {
  const [token, extra] = spokenNumbers(text);
  if (!token || extra || token.start !== 0 || token.end !== text.length || token.value === null) {
    throw new Error('请说清楚具体数量或单价。');
  }
  return token.value;
}

function field(text: string): Edit {
  const zero = /^(.*?)\s*(?:没收|未收|不收)$/.exec(text);
  if (zero) return { target: zero[1], receivedQuantity: 0 };
  const quantity = quantityPattern.exec(text);
  if (quantity) {
    const [, target, amount, unit] = quantity;
    const receivedQuantity = spokenValue(amount);
    if (!Number.isSafeInteger(receivedQuantity)) throw new Error('实收数量超出可计算范围。');
    return { target, unit, receivedQuantity };
  }
  const price = pricePattern.exec(text);
  if (price) {
    const [, target, amount] = price;
    const raw = amount.replace(/\s+(?=[元块角毛分])/g, '');
    const numeric = numericPrice.exec(raw);
    const value = numeric ? `${numeric[1]}${numeric[2] ?? ''}` : spokenPrice.test(raw) ? spokenValue(raw).toFixed(2) : '';
    if (!value) throw new Error('请填写单价（元），例如 12.35 元。');
    unitPrice(value);
    return { target, price: value };
  }
  throw new Error('请说出货品和要改的内容，例如「水饺实收三箱，单价 12.35 元」。');
}

export function parseDeliveryMessage(message: string) {
  const text = message.normalize('NFKC').trim().replace(/[。.!！]$/, '');
  if (!text || message.length > deliveryMessageLimit) throw new Error('请输入 200 字以内的配送修改。');
  if (/^(?:(?:去|我要|帮我)?确认送达|去送达确认)$/.test(text)) return { kind: 'complete' } as const;
  const [first, second, ...rest] = text.split(/[,、;\n]+/).map(part => part.trim());
  if (rest.length) throw new Error('请每次修改一条货品的实收或单价。');
  const edit = field(first);
  if (second !== undefined) {
    const extra = field(second);
    if (extra.target || (edit.receivedQuantity !== undefined && extra.receivedQuantity !== undefined) ||
        (edit.price !== undefined && extra.price !== undefined)) {
      throw new Error('请每次修改一条货品的实收或单价。');
    }
    return { kind: 'edit', edit: { ...edit, ...extra, target: edit.target } } as const;
  }
  return { kind: 'edit', edit } as const;
}

function normalizedLabel(value: string) {
  return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export function deliveryCandidates<T extends DeliveryLine>(lines: T[], edit: Edit) {
  const target = normalizedLabel(edit.target);
  const named = lines.filter(({ product, brand, specification }) => !target ||
    [product, brand + product, product + specification, brand + product + specification]
      .some(name => normalizedLabel(name) === target));
  if (!named.length) throw new Error('当前客户单里没有找到这个货品，请核对名称。');
  const matching = named.filter(line => !edit.unit || normalizedLabel(line.unit) === normalizedLabel(edit.unit));
  if (!matching.length) throw new Error('实收单位与客户单不符，请按配送明细里的原单位填写。');
  return matching;
}
