import { ItemInput, money, OrderLine } from '../core/orders';
import { CustomerOrder, DeliveryStatus, TripVersion } from '../core/trips';

const fields = [
  { key: 'product', label: '货品', type: 'text', max: 100 },
  { key: 'brand', label: '品牌', type: 'text', max: 100 },
  { key: 'specification', label: '规格', type: 'text', max: 100 },
  { key: 'unit', label: '单位', type: 'text', max: 20 },
  { key: 'quantity', label: '数量', type: 'number', max: 12 },
  { key: 'price', label: '单价（元）', type: 'digit', max: 14 },
] as const;

export function formLines(items: ItemInput[]) {
  return items.map(item => ({ id: item.id, fields: fields.map(field => ({ ...field, value: item[field.key] })) }));
}

export function editLines(items: ItemInput[], id: string, field: string, value: string): ItemInput[] {
  if (!fields.some(entry => entry.key === field)) return items;
  return items.map(item => item.id === id ? { ...item, [field]: value } : item);
}

export const deliveryLabel: Record<DeliveryStatus, string> = { pending: '未配送', delivered: '已送达', unrecorded: '未记录' };

export function lineView(line: OrderLine) {
  return { ...line, amount: money(line.amountCents) };
}

export function customerView(customer: CustomerOrder) {
  return { ...customer, items: customer.items.map(lineView), total: money(customer.totalCents) };
}

export function tripView(version: Pick<TripVersion, 'customers' | 'totalCents'>) {
  return { customers: version.customers.map(customerView), total: money(version.totalCents) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试';
}
