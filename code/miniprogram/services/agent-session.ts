import type { TripDraft } from '../core/trips';

export const agentSession = {
  token: '',
  unsaved: null as { draft: TripDraft; activeId?: string } | null,
};
