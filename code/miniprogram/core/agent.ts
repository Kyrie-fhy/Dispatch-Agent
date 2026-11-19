import type { TripPreview } from './trips';

export type AgentStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type Question = { customer: string; text: string; options: string[] };
export type DirectIntent = { intent: 'preview' } | { intent: 'draft'; turnId: string; answer: string };
export type StepState = 'pending' | 'running' | 'done' | 'needs_input' | 'failed' | 'skipped';
export type PlanStep = { id: string; text: string };
export type AgentEvent =
  | { seq: number; kind: 'progress'; payload: { text: string; done: boolean; step: number } }
  | { seq: number; kind: 'plan'; payload: { steps: PlanStep[] } }
  | { seq: number; kind: 'step'; payload: { id: string; state: StepState; result?: string } }
  | { seq: number; kind: 'questions'; payload: { questions: Question[] } }
  | { seq: number; kind: 'preview'; payload: { preview: TripPreview } }
  | { seq: number; kind: 'change'; payload: { lines: string[] } }
  | { seq: number; kind: 'undo'; payload: { revision: number } }
  | { seq: number; kind: 'end'; payload: { status: AgentStatus; text: string; revision: number; elapsedMs?: number } };

export interface AgentTurn {
  id: string;
  status: AgentStatus;
  events: AgentEvent[];
  text: string;
  materialIds: string[];
  revision: number;
}
