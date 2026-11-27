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

function clipText(text: string, limit: number): string {
  return Array.from(text)
    .slice(0, limit)
    .join('')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

export function clipDecisions(list: readonly ControlDecision[]): ControlDecision[] {
  return list.slice(0, maxControlDecisions).map(({ ruleId, decision, layer, reason, target }) => {
    const clippedTarget = target ? clipText(target, 120) : '';
    return {
      ruleId,
      decision,
      layer,
      reason: clipText(reason, 200),
      ...(clippedTarget ? { target: clippedTarget } : {}),
    };
  });
}
