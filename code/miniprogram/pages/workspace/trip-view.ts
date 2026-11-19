import { deliveryLines, deliverySummary } from '../../core/delivery-execution';
import { deliveredBalance } from '../../core/settlement';
import { latest, PickingChange, PickingLine, pickingChanges } from '../../core/trips';
import type { FormalTrip } from '../../services/workspace';
import { amountLabel, deliveryLabel, lineView, tripView } from '../order-view';

export type FormalView = ReturnType<typeof tripView> & {
  id: string;
  version: number;
  statuses: Record<string, string>;
  picking: PickingLine[];
  changes: PickingChange[];
  unfinished: string[];
  deliveryRows: { totalLabel: string; completed: boolean; lines: (ReturnType<typeof lineView> & {
    originalQuantity: string;
  })[] }[];
};

export function formalTripView({ trip, picking, deliveryEdits, sheets = [] }: FormalTrip): FormalView {
  const version = latest(trip);
  const previous = trip.versions[trip.versions.length - 2];
  const statuses = Object.fromEntries(Object.entries(trip.statuses).map(([id, status]) => [id, deliveryLabel[status]]));
  const deliveryRows = version.customers.map(customer => {
    const lines = deliveryLines(customer, deliveryEdits);
    const { totalCents, pendingPrices } = deliverySummary(lines);
    const sheet = sheets.find(sheet => sheet.sheetId === customer.id);
    const reviewed = sheet?.reviewed;
    const due = reviewed ? deliveredBalance({ ...customer, items: lines }, trip.statuses, 0).due : totalCents;
    return { lines: lines.map(line => ({ ...lineView({ ...line, quantity: String(line.receivedQuantity) }), originalQuantity: line.originalQuantity })),
      completed: Boolean(sheet?.deliveryCompleted),
      totalLabel: amountLabel(due, pendingPrices, reviewed ? '本次应收' : '预计应收') };
  });
  return { ...tripView(version), deliveryRows, id: trip.id, version: version.version, picking, statuses,
    unfinished: version.customers.filter((_, index) => !deliveryRows[index].completed).map(customer => customer.customer),
    changes: previous ? pickingChanges(previous.customers, version.customers) : [] };
}
