import type { Sheet } from '../core/settlement';

let selected: Sheet | null = null;
export function selectDeliverySheet(sheet: Sheet) { selected = sheet; }
export function clearDeliverySheet() { selected = null; }
export function takeDeliverySheet(): Sheet | null {
  const sheet = selected;
  clearDeliverySheet();
  return sheet;
}
