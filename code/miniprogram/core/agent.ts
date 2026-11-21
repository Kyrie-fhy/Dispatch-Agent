import type { TripPreview } from './trips';

export type AgentStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type Question = { customer: string; text: string; options: string[] };
export type DirectIntent = { intent: 'preview' } | { intent: 'draft'; turnId: string; answer: string };
export type StepState = 'pending' | 'running' | 'done' | 'needs_input' | 'failed' | 'skipped';
export type PlanStep = { id: string; text: string };
export type DeliveryProposal = {
  tripId: string; sheetId: string; customer: string; version: number; statusRevision: number;
  edits: { lineId: string; name: string; originalQuantity: string; beforeQuantity: number; beforePrice: string | null;
    receivedQuantity: number; price: string | null }[];
  totalCents: number; pendingPriceNames: string[]; canComplete: boolean;
};
export type DeliveryCardState = 'saved' | 'completed' | 'cancelled';
export type DeliveryProgress = { tripId: string; version: number; statusRevision: number;
  shops: { sheetId: string; customer: string; locked: boolean; totalCents: number; pendingPrices: number }[] };
export type CustomerLink = { draftCustomerId: string; spoken: string; customerId: string; canonicalName: string;
  matchedBy: 'canonical' | 'alias'; merged: boolean };
export type AgentEvent =
  | { seq: number; kind: 'progress'; payload: { text: string; done: boolean; step: number } }
  | { seq: number; kind: 'plan'; payload: { steps: PlanStep[] } }
  | { seq: number; kind: 'step'; payload: { id: string; state: StepState; result?: string } }
  | { seq: number; kind: 'questions'; payload: { questions: Question[] } }
  | { seq: number; kind: 'preview'; payload: { preview: TripPreview } }
  | { seq: number; kind: 'change'; payload: { lines: string[] } }
  | { seq: number; kind: 'undo'; payload: { revision: number } }
  | { seq: number; kind: 'delivery_proposal'; payload: DeliveryProposal }
  | { seq: number; kind: 'delivery_applied'; payload: { status: DeliveryCardState } }
  | { seq: number; kind: 'customer_links'; payload: { links: CustomerLink[] } }
  | { seq: number; kind: 'end'; payload: { status: AgentStatus; text: string; revision: number; elapsedMs?: number } };

export interface AgentTurn {
  id: string;
  status: AgentStatus;
  events: AgentEvent[];
  text: string;
  materialIds: string[];
  revision: number;
}
