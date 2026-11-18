import { DeliveryLine, deliverySummary } from '../../core/delivery-execution';
import { money, OrderLine } from '../../core/orders';
import { customerDebts, deliveredBalance, localDay, OpeningPreview, orderDebtId, Receipt, ReceiptPreview, Sheet } from '../../core/settlement';
import { DeliveryStatus, LineChange, PickingChange } from '../../core/trips';
import { balanceView } from '../delivery/settlement-view';
import { amountLabel, deliveryLabel, lineView } from '../order-view';

type Amounts = ReturnType<typeof deliveredBalance>;
export type DeliveryMark = 'pending' | 'delivered';
export type SheetAction = 'review' | 'delivery' | 'opening' | 'receipt' | 'amendment';

export interface ServerSheet extends Sheet {
  customer: string;
  reviewed: boolean;
  version: number;
  statusRevision: number;
  amounts: Amounts;
  orderCents: number;
  lines: (DeliveryLine & { status: DeliveryStatus })[];
  execution: ReturnType<typeof deliverySummary>;
  deliveryCompleted: boolean;
}

export interface ServerLedger {
  debts: ReturnType<typeof customerDebts>;
  receipts: Receipt[];
  remainingCents: number;
  otherRemainingCents: number;
}

export interface DeliveryPreview {
  previewId: string;
  before: Amounts;
  after: Amounts;
}

export interface AmendmentPreview extends DeliveryPreview {
  changes: LineChange[];
  picking: PickingChange[];
  unchecked: OrderLine[];
  orderCents: { before: number; after: number };
}

export function sheetPath({ tripId, sheetId }: Sheet) {
  return `/trips/${encodeURIComponent(tripId)}/sheets/${encodeURIComponent(sheetId)}`;
}

export function sheetView(sheet: ServerSheet, ledger: ServerLedger = { debts: [], receipts: [], remainingCents: 0, otherRemainingCents: 0 }) {
  const labels = new Map(ledger.debts.map(debt => [debt.id, debt.label]));
  const execution = sheet.execution ?? deliverySummary(sheet.lines);
  return {
    ...sheet, executionLabel: amountLabel(execution.totalCents, execution.pendingPrices, '预计应收'),
    balance: balanceView(sheet.amounts), total: money(sheet.orderCents),
    lines: sheet.lines.map(line => ({ ...line, ...lineView(line), statusLabel: deliveryLabel[line.status] })),
    pending: sheet.lines.filter(line => line.status !== 'delivered').map(lineView),
    hasUnrecorded: sheet.lines.some(line => line.status === 'unrecorded'),
    otherRemaining: money(ledger.otherRemainingCents),
    available: money(ledger.remainingCents),
    canReceive: sheet.reviewed && ledger.remainingCents > 0,
    debts: ledger.debts.filter(debt => debt.id !== orderDebtId(sheet))
      .map(debt => ({ ...debt, balance: balanceView({ ...debt, due: debt.cents }) })),
    receipts: [...ledger.receipts].reverse().map(receipt => ({
      id: receipt.id, date: localDay(new Date(receipt.savedAt)), total: money(receipt.cents),
      allocations: receipt.allocations.map(allocation => ({
        ...allocation, label: labels.get(allocation.debtId) ?? '原单据', amount: money(allocation.cents),
      })),
    })),
  };
}

export function balanceChange(before: Amounts, after: Amounts) {
  const previous = balanceView(before);
  const next = balanceView(after);
  return [
    { label: '应收', before: previous.due, after: next.due },
    { label: '实收', before: previous.paid, after: next.paid },
    { label: '欠款', before: previous.remaining, after: next.remaining },
    { label: '多收', before: previous.excess, after: next.excess },
  ];
}

export function settlementPreview(result: OpeningPreview | ReceiptPreview) {
  return {
    id: result.id, total: money(result.cents),
    day: 'day' in result ? result.day : '',
    source: 'source' in result ? result.source : '',
    allocations: 'allocations' in result
      ? result.allocations.map(row => ({ ...row, amount: money(row.cents), balance: money(row.remaining) }))
      : [],
  };
}
