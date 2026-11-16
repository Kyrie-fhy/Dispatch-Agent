import { currentTrip, latest, pickingChanges, pickingList, PickingChange, PickingLine } from '../../core/trips';
import { trips } from '../../services/orders';
import { errorMessage } from '../order-view';

Page({
  data: { rows: [] as PickingLine[], changes: [] as PickingChange[], version: 0, error: '' },
  onShow() {
    try {
      const trip = currentTrip(trips.load());
      const current = trip ? latest(trip) : null;
      const previous = trip?.versions[trip.versions.length - 2];
      this.setData({ rows: current ? pickingList(current.customers) : [], version: current?.version ?? 0,
        changes: previous && current ? pickingChanges(previous.customers, current.customers) : [], error: '' });
    } catch (error) { this.setData({ error: errorMessage(error), rows: [], version: 0, changes: [] }); }
  },
});
