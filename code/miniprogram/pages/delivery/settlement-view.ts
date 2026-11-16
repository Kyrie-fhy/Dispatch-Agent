import { money } from '../../core/orders';
import { accountFor, customerDebts, localDay, sheetBalance, sumCents } from '../../core/settlement';
import { latest, Trip, TripState } from '../../core/trips';
import { partyOptions } from '../order-view';

export function balanceView(values: ReturnType<typeof sheetBalance>) {
  return { due: money(values.due), paid: money(values.paid), remaining: money(values.remaining),
    excess: money(values.excess), hasExcess: values.excess > 0 };
}

export function settlementView(state: TripState, trip: Trip, sheetId: string) {
  const account = accountFor(state.ledger, { tripId: trip.id, sheetId });
  const customer = latest(trip).customers.find(order => order.id === sheetId)!;
  const parties = partyOptions(state);
  const party = parties.find(entry => entry.id === account?.partyId);
  const debts = party ? customerDebts(state, party.id) : [];
  const others = debts.filter(debt => debt.sheet?.tripId !== trip.id || debt.sheet.sheetId !== sheetId);
  const labels = new Map(debts.map(debt => [debt.id, debt.label]));
  const unreviewed = account ? state.ledger.accounts
    .filter(entry => entry.partyId === account.partyId && !entry.reviewed && (entry.tripId !== trip.id || entry.sheetId !== sheetId))
    .map(entry => {
      const otherTrip = state.trips.find(candidate => candidate.id === entry.tripId)!;
      return { ...entry, label: `${localDay(new Date(otherTrip.versions[0].savedAt))} · 待核对` };
    }) : [];
  return {
    party: party?.label ?? '',
    parties: parties.filter(entry => !state.ledger.accounts.some(link => link.tripId === trip.id && link.partyId === entry.id)),
    reviewed: account?.reviewed ?? false,
    ...balanceView(sheetBalance(state.ledger, trip, customer)),
    historic: money(sumCents(others.map(debt => debt.remaining))),
    available: money(sumCents(debts.map(debt => debt.remaining))),
    canReceive: !!account?.reviewed && debts.some(debt => debt.remaining > 0),
    debts: others.map(debt => ({ ...debt, ...balanceView(debt) })),
    unreviewed,
    receipts: party ? state.ledger.receipts.filter(receipt => receipt.partyId === party.id).slice().reverse().map(receipt => ({
      id: receipt.id, day: localDay(new Date(receipt.savedAt)), amount: money(receipt.cents),
      allocations: receipt.allocations.map(allocation => ({ ...allocation, label: labels.get(allocation.debtId) ?? allocation.debtId,
        amount: money(allocation.cents) })),
    })) : [],
  };
}
