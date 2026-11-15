import { OrderService } from '../core/orders';
const key = 'dispatch-agent-s1-v1';
let sequence = 0;
export function newId(): string { return `order-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`; }
export const orders = new OrderService({
  read: () => wx.getStorageSync(key),
  write: state => wx.setStorageSync(key, state),
}, newId, () => new Date().toISOString());
