export type ControlDecisionKind = 'modify' | 'confirm' | 'block';
export type ControlDecisionLayer = 'edit' | 'customer_link' | 'catalog' | 'delivery' | 'voice';

export type ControlDecision = {
  ruleId: string;
  decision: ControlDecisionKind;
  layer: ControlDecisionLayer;
  reason: string;
  target?: string;
};

export const maxControlDecisions = 32;

export function clipDecisions(list: readonly ControlDecision[]): ControlDecision[] {
  return list.slice(0, maxControlDecisions).map(({ ruleId, decision, layer, reason, target }) => ({
    ruleId,
    decision,
    layer,
    reason: reason.slice(0, 200),
    ...(target ? { target: target.slice(0, 120) } : {}),
  }));
}
