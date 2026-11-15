import { money } from '../../core/orders';
import { orders } from '../../services/orders';
Page({
  data: { list: [] as { id: string; customer: string; total: string; confirmedAt: string }[], error: '' },
  onShow() {
    try {
      this.setData({ list: orders.load().orders.map(order => ({ id: order.id, customer: order.customer, total: money(order.totalCents), confirmedAt: order.confirmedAt })), error: '' });
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : '读取失败' }); }
  },
});
