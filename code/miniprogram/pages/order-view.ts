import { deliverySummary } from '../core/delivery-execution';
import { ItemInput, money, OrderLine } from '../core/orders';
import { localDay } from '../core/settlement';
import { CustomerOrder, DeliveryStatus, latest, TripState, TripVersion } from '../core/trips';

const fields = [
  { key: 'product', label: '货品', type: 'text', max: 100 },
  { key: 'brand', label: '品牌', type: 'text', max: 100 },
  { key: 'specification', label: '规格', type: 'text', max: 100 },
  { key: 'unit', label: '单位', type: 'text', max: 20 },
  { key: 'quantity', label: '数量', type: 'number', max: 12 },
  { key: 'price', label: '单价（元）', type: 'digit', max: 14 },
] as const;

export function formLines(items: ItemInput[]) {
  return items.map(item => ({ id: item.id, pendingPrice: !item.price?.trim(),
    fields: fields.map(field => ({ ...field, value: item[field.key] ?? '' })) }));
}

export function productLabel(item: Pick<ItemInput, 'product' | 'brand' | 'specification'>) {
  return [[item.brand, item.product].filter(Boolean).join(' '), item.specification].filter(Boolean).join(' · ');
}

export function lineNameOnly(item: Pick<ItemInput, 'product'>) {
  return (item.product ?? '').trim() || '未命名货品';
}

export function lineMetaLabel(item: Pick<ItemInput, 'brand' | 'specification'>) {
  return [item.brand ?? '', item.specification ?? ''].map(value => value.trim()).filter(Boolean).join(' · ');
}

export function amountLabel(cents: number, pendingPrices: number, label: string) {
  return pendingPrices ? `已算金额 ¥${money(cents)} · 含 ${pendingPrices} 项待补价` : `${label} ¥${money(cents)}`;
}

export function priceSourceLabel(source: ItemInput['priceSource']): string {
  if (source === 'customer_history') return '熟客价';
  if (source === 'catalog') return '库内价';
  return '';
}

export function catalogHintText(priceHint: string | null | undefined, discontinued: boolean): string {
  const text = (priceHint ?? '').trim();
  if (!text) return '';
  return discontinued && text === '已下架，请核实库存' ? '' : text;
}

export function editLines(items: ItemInput[], id: string, field: string, value: string): ItemInput[] {
  if (!fields.some(entry => entry.key === field)) return items;
  return items.map(item => item.id === id ? { ...item, [field]: value } : item);
}

export const deliveryLabel: Record<DeliveryStatus, string> = { pending: '未配送', delivered: '已送达', unrecorded: '未记录' };

export function lineView(line: OrderLine) {
  const discontinued = line.catalogStatus === 'discontinued';
  return { ...line, productLabel: productLabel(line), nameOnly: lineNameOnly(line), metaLabel: lineMetaLabel(line),
    priceLabel: line.price === null ? '待补价' : `¥${line.price}`,
    amount: line.amountCents === null ? '待补价' : money(line.amountCents),
    amountLabel: line.amountCents === null ? '待补价' : `¥${money(line.amountCents)}`,
    priceSourceLabel: priceSourceLabel(line.priceSource), discontinued,
    priceHint: line.priceHint ?? '', catalogHint: catalogHintText(line.priceHint, discontinued) };
}

function customerView(customer: CustomerOrder) {
  const { totalCents, pendingPrices } = deliverySummary(customer.items);
  return { ...customer, items: customer.items.map(lineView), total: money(customer.totalCents),
    totalLabel: amountLabel(totalCents, pendingPrices, '订单金额') };
}

export function tripView(version: Pick<TripVersion, 'customers' | 'totalCents'>) {
  const pendingPrices = version.customers.reduce((total, customer) => total + deliverySummary(customer.items).pendingPrices, 0);
  return { customers: version.customers.map(customerView), total: money(version.totalCents),
    totalLabel: amountLabel(version.totalCents, pendingPrices, '整趟订单金额') };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试';
}

export function partyOptions(state: TripState) {
  const trips = new Map(state.trips.map(trip => [trip.id, trip]));
  const recentByParty = new Map<string, { time: number; summary: string }>();
  for (const account of state.ledger.accounts) {
    const trip = trips.get(account.tripId)!;
    const time = Date.parse(trip.versions[0].savedAt);
    if ((recentByParty.get(account.partyId)?.time ?? -Infinity) > time) continue;
    const line = latest(trip).customers.find(entry => entry.id === account.sheetId)!.items[0];
    recentByParty.set(account.partyId, { time, summary: ` · ${localDay(new Date(time))} ${line.brand} ${line.product}` });
  }
  return state.ledger.parties.map((party, index) => {
    const recent = recentByParty.get(party.id)?.summary ?? '';
    return { ...party, number: index + 1, label: `${party.name} · 客户 ${index + 1}${recent}` };
  });
}
