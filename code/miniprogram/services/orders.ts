import { TripService } from '../core/trips';
const key = 'dispatch-agent-s1-v1';
let sequence = 0;
export function newId(): string { return `order-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`; }
export const trips = new TripService({
  read: () => wx.getStorageSync(key),
  write: state => {
    try { wx.setStorageSync(key, state); }
    catch { throw new Error('保存失败，请重试'); }
  },
}, newId, () => new Date().toISOString());
