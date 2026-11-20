import type { TripDraft } from '../core/trips';
import type { Sheet } from '../core/settlement';

export const agentSession = {
  token: '',
  unsaved: null as { draft: TripDraft; activeId?: string } | null,
  deliveryCustomer: null as { tripId: string; name: string } | null,
  deliveryTarget: null as Sheet | null,
};
