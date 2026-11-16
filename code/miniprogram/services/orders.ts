import { TripService } from '../core/trips';
import { newId } from './ids';

const key = 'dispatch-agent-s1-v1';
export const trips = new TripService({
  read: () => wx.getStorageSync(key),
  write: state => {
    try { wx.setStorageSync(key, state); }
    catch { throw new Error('保存失败，请重试'); }
  },
}, newId, () => new Date().toISOString());
