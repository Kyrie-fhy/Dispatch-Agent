import type { TripDraft } from '../core/trips';
import type { Sheet } from '../core/settlement';

export const agentSession = {
  token: '',
  remarkName: '',
  disabledMessage: '',
  unsaved: null as { draft: TripDraft; activeId?: string } | null,
  deliveryCustomer: null as { tripId: string; name: string } | null,
  deliveryTarget: null as Sheet | null,
};

// 统一清空本机会话与草稿上下文，避免停用或退出后仍有残留数据可继续操作。
export function clearAgentSession(disabledMessage = ''): void {
  agentSession.token = '';
  agentSession.remarkName = '';
  agentSession.unsaved = null;
  agentSession.deliveryCustomer = null;
  agentSession.deliveryTarget = null;
  agentSession.disabledMessage = disabledMessage;
}
