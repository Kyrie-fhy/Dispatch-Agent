import { deliveryLines, deliverySummary } from '../../core/delivery-execution';
import { money } from '../../core/orders';
import { deliveredBalance } from '../../core/settlement';
import { latest, PickingChange, PickingLine, pickingChanges, pickingKey } from '../../core/trips';
import type { FormalTrip } from '../../services/workspace';
import { amountLabel, deliveryLabel, lineView, tripView } from '../order-view';

export type FormalView = ReturnType<typeof tripView> & {
  id: string;
  version: number;
  statuses: Record<string, string>;
  picking: PickingLine[];
  pickingRows: (PickingLine & { title: string; specMeta: string; isBox: boolean })[];
  pickingKindCount: number;
  pickingTotalQty: number;
  changes: PickingChange[];
  unfinished: string[];
  deliveredCount: number;
  deliveryTotalCents: number;
  deliveryPendingCount: number;
  deliveryAllPending: boolean;
  deliveryTotalTitle: string;
  deliveryTotalAmount: string;
  deliveryProgressPercent: number;
  deliveryRows: {
    id: string;
    customer: string;
    lineCount: number;
    pendingPrices: number;
    pendingPriceOnly: boolean;
    amountTitle: string;
    dueLabel: string;
    totalLabel: string;
    completed: boolean;
    actionHint: string;
    lines: (ReturnType<typeof lineView> & { originalQuantity: string })[];
  }[];
};

export function formalTripView({ trip, picking, deliveryEdits, sheets = [] }: FormalTrip): FormalView {
  const version = latest(trip);
  const previous = trip.versions[trip.versions.length - 2];
  const statuses = Object.fromEntries(Object.entries(trip.statuses).map(([id, status]) => [id, deliveryLabel[status]]));
  const shopsForKey = new Map<string, Set<string>>();
  for (const customer of version.customers) {
    for (const item of customer.items) {
      const key = pickingKey(item);
      const shops = shopsForKey.get(key) ?? new Set<string>();
      shops.add(customer.id);
      shopsForKey.set(key, shops);
    }
  }
  const pickingRows = picking.map(row => {
    const shopCount = shopsForKey.get(pickingKey({ ...row, quantity: String(row.quantity), price: null }))?.size ?? 0;
    return {
      ...row,
      title: row.brand ? `${row.brand} ${row.product}` : row.product,
      specMeta: [row.specification, shopCount > 0 ? `${shopCount} 家要货` : ''].filter(Boolean).join(' · '),
      isBox: row.unit.trim() === '箱',
    };
  });
  const pickingTotalQty = picking.reduce((sum, row) => sum + row.quantity, 0);
  let deliveryTotalCents = 0;
  let deliveryPendingCount = 0;
  const deliveryRows = version.customers.map(customer => {
    const lines = deliveryLines(customer, deliveryEdits);
    const { totalCents, pendingPrices } = deliverySummary(lines);
    const sheet = sheets.find(sheet => sheet.sheetId === customer.id);
    const reviewed = sheet?.reviewed;
    const due = reviewed ? deliveredBalance({ ...customer, items: lines }, trip.statuses, 0).due : totalCents;
    const pendingPriceOnly = pendingPrices > 0 && due === 0;
    const completed = Boolean(sheet?.deliveryCompleted);
    deliveryTotalCents += due;
    deliveryPendingCount += pendingPrices;
    return {
      id: customer.id, customer: customer.customer, lineCount: lines.length, pendingPrices, pendingPriceOnly,
      amountTitle: reviewed ? '本次应收' : (pendingPrices > 0 && due > 0 ? '已算金额' : '预计应收'),
      dueLabel: pendingPriceOnly ? '待补价' : '¥' + money(due),
      lines: lines.map(line => ({ ...lineView({ ...line, quantity: String(line.receivedQuantity) }), originalQuantity: line.originalQuantity })),
      completed,
      actionHint: completed ? '已锁账' : '点进核对',
      totalLabel: amountLabel(due, pendingPrices, reviewed ? '本次应收' : '预计应收') };
  });
  if (!Number.isSafeInteger(deliveryTotalCents)) throw new Error('整趟送货金额超出可计算范围');
  const deliveredCount = deliveryRows.filter(row => row.completed).length;
  const deliveryAllPending = deliveryPendingCount > 0 && deliveryTotalCents === 0;
  return { ...tripView(version), deliveryRows, deliveredCount,
    deliveryTotalCents, deliveryPendingCount, deliveryAllPending,
    deliveryTotalTitle: deliveryAllPending ? '待补价' : (deliveryPendingCount > 0 ? '已算金额' : '预计应收'),
    deliveryTotalAmount: deliveryAllPending ? '待补价' : '¥' + money(deliveryTotalCents),
    deliveryProgressPercent: deliveryRows.length ? Math.round((deliveredCount / deliveryRows.length) * 100) : 0,
    pickingRows, pickingKindCount: picking.length, pickingTotalQty,
    id: trip.id, version: version.version, picking, statuses,
    unfinished: version.customers.filter((_, index) => !deliveryRows[index].completed).map(customer => customer.customer),
    changes: previous ? pickingChanges(previous.customers, version.customers) : [] };
}
