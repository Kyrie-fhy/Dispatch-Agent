import { money, OrderLine } from '../../core/orders';
import { customerDebts, deliveredBalance, localDay, OpeningPreview, orderDebtId, ReceiptCorrectionPreview,
  ReceiptDistribution, ServerReceipt, ServerReceiptPreview, Sheet } from '../../core/settlement';
import { DeliveryStatus, LineChange, PickingChange } from '../../core/trips';
import { balanceView } from '../delivery/settlement-view';
import { deliveryLabel, lineView } from '../order-view';

type Amounts = ReturnType<typeof deliveredBalance>;
export type DeliveryMark = 'pending' | 'delivered';
export type SheetAction = 'review' | 'delivery' | 'opening' | 'receipt' | 'receipt-correction' | 'amendment';

export interface ServerSheet extends Sheet {
  customer: string;
  reviewed: boolean;
  version: number;
  statusRevision: number;
  amounts: Amounts;
  orderCents: number;
  lines: (OrderLine & { status: DeliveryStatus })[];
}

export interface ServerLedger {
  debts: ReturnType<typeof customerDebts>;
  receipts: ServerReceipt[];
  pendingCents?: number;
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

export function sheetView(sheet: ServerSheet, ledger: ServerLedger) {
  const labels = new Map(ledger.debts.map(debt => [debt.id, debt.label]));
  return {
    ...sheet, balance: balanceView(sheet.amounts), total: money(sheet.orderCents),
    lines: sheet.lines.map(line => ({ ...lineView(line), status: line.status, statusLabel: deliveryLabel[line.status] })),
    pending: sheet.lines.filter(line => line.status !== 'delivered').map(lineView),
    hasUnrecorded: sheet.lines.some(line => line.status === 'unrecorded'),
    otherRemaining: money(ledger.otherRemainingCents),
    available: money(ledger.remainingCents),
    pendingAmount: ledger.pendingCents ? money(ledger.pendingCents) : '',
    debts: ledger.debts.filter(debt => debt.id !== orderDebtId(sheet))
      .map(debt => ({ ...debt, balance: balanceView({ ...debt, due: debt.cents }) })),
    receipts: [...ledger.receipts].reverse().map(receipt => ({
      id: receipt.id, date: localDay(new Date(receipt.savedAt)), total: money(receipt.cents),
      reversed: Boolean(receipt.reversedBy), replacement: Boolean(receipt.replaces),
      pendingAmount: receipt.pendingCents ? money(receipt.pendingCents) : '',
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

function distributionView(distribution: ReceiptDistribution) {
  const rows = distribution.allocations.map(row => `${row.label} ¥${money(row.cents)}`);
  if (distribution.pendingCents) rows.push(`待处理 ¥${money(distribution.pendingCents)}`);
  return rows.join('、');
}

export function settlementPreview(result: OpeningPreview | ServerReceiptPreview | ReceiptCorrectionPreview) {
  return {
    id: result.id, total: money(result.cents),
    day: 'day' in result ? result.day : '',
    source: 'source' in result ? result.source : '',
    allocations: 'allocations' in result
      ? result.allocations.map(row => ({ ...row, amount: money(row.cents), balance: money(row.remaining) }))
      : [],
    pendingAmount: 'pendingCents' in result && result.pendingCents ? money(result.pendingCents) : '',
    correction: 'originalReceiptId' in result ? {
      original: money(result.originalCents), canConfirm: result.canConfirm,
      impacts: result.impacts.map(row => ({ debtId: row.debtId, label: row.label,
        beforePaid: money(row.beforePaid), afterPaid: money(row.afterPaid),
        beforeRemaining: money(row.beforeRemaining), afterRemaining: money(row.afterRemaining) })),
      laterChanges: result.laterChanges.map(row => ({
        id: row.id, date: localDay(new Date(row.savedAt)), amount: money(row.cents),
        before: distributionView(row.before), after: distributionView(row.after),
      })),
    } : null,
  };
}
