import { lineAmount, money, OrderLine, unitPrice } from './orders';
import type { CustomerOrder } from './trips';

export interface DeliveryEdit {
  receivedQuantity: number;
  unitPriceCents: number | null;
}

export type DeliveryEdits = Record<string, DeliveryEdit>;

export interface DeliveryLine extends OrderLine {
  originalQuantity: string;
  receivedQuantity: number;
  unitPriceCents: number | null;
}

export function deliveryLines(customer: CustomerOrder, edits: DeliveryEdits = {}): DeliveryLine[] {
  return customer.items.map(item => {
    const edit = Object.prototype.hasOwnProperty.call(edits, item.id) ? edits[item.id] : undefined;
    const receivedQuantity = edit?.receivedQuantity ?? Number(item.quantity);
    const cents = edit ? edit.unitPriceCents
      : item.unitPriceCents === undefined ? unitPrice(item.price) : item.unitPriceCents;
    return {
      ...item, originalQuantity: item.quantity, receivedQuantity, unitPriceCents: cents,
      price: cents === null ? null : edit ? money(cents) : item.price,
      amountCents: lineAmount(receivedQuantity, cents),
    };
  });
}

export function deliverySummary(lines: OrderLine[]) {
  let totalCents = 0;
  let pendingPrices = 0;
  for (const line of lines) {
    if (line.amountCents === null) pendingPrices++;
    else totalCents += line.amountCents;
  }
  if (!Number.isSafeInteger(totalCents)) throw new Error('客户单金额超出可计算范围');
  return { totalCents, pendingPrices };
}
