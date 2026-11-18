import { createHash } from 'node:crypto';
import { allocateReceipt, customerDebts, Ledger, ReceiptCorrectionPreview,
  ReceiptDistribution, ServerReceipt, Sheet } from '../miniprogram/core/settlement';
import { Trip } from '../miniprogram/core/trips';
import { HttpError } from './http-error';

export function receiptBasis(receipts: ServerReceipt[]) {
  return createHash('sha256').update(JSON.stringify(receipts.map(receipt => receipt.id))).digest('hex');
}

export function effectiveReceipts(history: ServerReceipt[]): ServerReceipt[] {
  const byId = new Map(history.map(receipt => [receipt.id, receipt]));
  // A replacement keeps the original receipt's position when checking subsequent allocations.
  return history.filter(receipt => !receipt.replaces).map(root => {
    let receipt = root;
    while (receipt.reversedBy) receipt = byId.get(receipt.reversedBy)!;
    return receipt;
  });
}

export function planCorrection(state: { ledger: Ledger; trips: Trip[] }, history: ServerReceipt[], sheet: Sheet,
  partyId: string, originalReceiptId: string, cents: number, id: string, dayFor: (day: Date) => string): ReceiptCorrectionPreview {
  const original = history.find(receipt => receipt.id === originalReceiptId);
  if (!original) throw new HttpError(404, 'receipt_not_found', '未找到本客户的收款记录');
  if (original.reversedBy) throw new HttpError(409, 'receipt_reversed', '该收款已冲销，请读取最新账目');
  const active = effectiveReceipts(history);
  const position = active.findIndex(receipt => receipt.id === originalReceiptId);
  const before = customerDebts(state, partyId, dayFor);
  const earlier = { ...state, ledger: { ...state.ledger, receipts: active.slice(0, position) } };
  const debts = customerDebts(earlier, partyId, dayFor);
  const byId = new Map(debts.map(debt => [debt.id, debt]));

  function allocate(amount: number) {
    const result = allocateReceipt(debts, amount);
    for (const { debtId, cents: applied, remaining } of result.allocations) {
      const debt = byId.get(debtId)!;
      debt.remaining = remaining;
      debt.paid += applied;
    }
    return result;
  }

  const replacement = allocate(cents);
  const laterChanges: ReceiptCorrectionPreview['laterChanges'] = [];
  for (const receipt of active.slice(position + 1)) {
    const replay = allocate(receipt.cents);
    const existing: ReceiptDistribution = {
      pendingCents: receipt.pendingCents ?? 0,
      allocations: receipt.allocations.map(allocation => ({
        ...allocation, label: byId.get(allocation.debtId)?.label ?? '原单据',
      })),
    };
    const proposed: ReceiptDistribution = {
      pendingCents: replay.pendingCents,
      allocations: replay.allocations.map(({ debtId, cents, label }) => ({ debtId, cents, label })),
    };
    const key = (entry: ReceiptDistribution) => JSON.stringify([
      entry.pendingCents, entry.allocations.map(({ debtId, cents }) => [debtId, cents]),
    ]);
    if (key(existing) !== key(proposed)) {
      laterChanges.push({ id: receipt.id, savedAt: receipt.savedAt, cents: receipt.cents, before: existing, after: proposed });
    }
  }
  const impacts = before.flatMap(debt => {
    const after = byId.get(debt.id)!;
    if (debt.paid === after.paid && debt.remaining === after.remaining) return [];
    return [{ debtId: debt.id, label: debt.label, beforePaid: debt.paid, afterPaid: after.paid,
      beforeRemaining: debt.remaining, afterRemaining: after.remaining }];
  });
  const basis = createHash('sha256').update(JSON.stringify([
    sheet, partyId, receiptBasis(history),
    before.map(debt => [debt.id, debt.time, debt.day, debt.revision, debt.cents, debt.paid]),
  ])).digest('hex');
  return {
    id, sheet, partyId, cents, originalReceiptId, originalCents: original.cents, basis,
    ...replacement, impacts, laterChanges, canConfirm: laterChanges.length === 0,
  };
}
