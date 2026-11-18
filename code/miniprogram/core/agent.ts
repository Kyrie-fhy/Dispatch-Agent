import type { TripPreview } from './trips';

export type AgentStatus = 'running' | 'completed' | 'failed' | 'interrupted';
export type Question = { customer: string; text: string; options: string[] };
export type AgentEvent =
  | { seq: number; kind: 'progress'; payload: { text: string; done: boolean; step: number } }
  | { seq: number; kind: 'questions'; payload: { questions: Question[] } }
  | { seq: number; kind: 'preview'; payload: { preview: TripPreview } }
  | { seq: number; kind: 'change'; payload: { lines: string[] } }
  | { seq: number; kind: 'undo'; payload: { revision: number } }
  | { seq: number; kind: 'end'; payload: { status: AgentStatus; text: string; revision: number } };

export interface AgentTurn {
  id: string;
  status: AgentStatus;
  events: AgentEvent[];
  text: string;
  materialIds: string[];
  revision: number;
}
