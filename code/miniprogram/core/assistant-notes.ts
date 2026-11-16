import { isObject } from './orders';

export interface QuantityQuestion {
  itemId: string; before: string; requested: string; unit: string; source: string;
}

export interface AssistantNotes {
  aliases: { name: string; partyId: string }[];
  demoPartyId?: string;
  draft?: { id: string; seen: { key: string; itemId: string }[]; quantities: QuantityQuestion[] };
}

export function readAssistantNotes(raw: unknown): AssistantNotes | undefined {
  if (raw === undefined) return undefined;
  const strings = (entry: unknown, fields: string[]) => isObject(entry)
    && fields.every(field => typeof entry[field] === 'string' && entry[field] !== '');
  if (!isObject(raw) || !Array.isArray(raw.aliases)
    || !raw.aliases.every(entry => strings(entry, ['name', 'partyId']))
    || (raw.demoPartyId !== undefined && typeof raw.demoPartyId !== 'string')
    || (raw.draft !== undefined && (!strings(raw.draft, ['id']) || !isObject(raw.draft)
      || !Array.isArray(raw.draft.seen) || !raw.draft.seen.every(entry => strings(entry, ['key', 'itemId']))
      || !Array.isArray(raw.draft.quantities)
      || !raw.draft.quantities.every(entry => strings(entry, ['itemId', 'before', 'requested', 'unit', 'source']))))) {
    throw new Error('本地助手数据无法读取，请保留数据并联系开发者');
  }
  return raw as unknown as AssistantNotes;
}
