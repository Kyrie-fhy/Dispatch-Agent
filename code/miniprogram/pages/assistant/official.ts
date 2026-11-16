import { Official, OfficialTarget, describeItem, officialTargets } from '../../core/mock-assistant';
import { money } from '../../core/orders';
import { ReceiptPreview } from '../../core/settlement';
import { Amendment, DeliveryPreview } from '../../core/trips';
import { trips } from '../../services/orders';

type Operation = { kind: 'receipt'; preview: ReceiptPreview } | { kind: 'amend'; preview: Amendment }
  | { kind: 'deliver'; preview: DeliveryPreview };
export type OfficialCard = Operation & { title: string; label: string; details: string[]; target: OfficialTarget };

function amounts(balance: { due: number; paid: number; remaining: number; excess: number }) {
  return `应收 ¥${money(balance.due)} · 实收 ¥${money(balance.paid)} · 欠款 ¥${money(balance.remaining)} · 多收 ¥${money(balance.excess)}`;
}

export function prepareOfficial(intent: Official, expected: OfficialTarget): OfficialCard {
  const target = officialTargets(trips.load(), intent).find(entry => entry.tripId === expected.tripId && entry.id === expected.id);
  if (!target || target.basis !== expected.basis) throw new Error('单据或对账状态已变化，请重新发送并核对目标');
  const sheet = { tripId: target.tripId, sheetId: target.sheetId };
  const base = { target, label: target.label };
  if (intent.kind === 'receipt') {
    const preview = trips.previewReceipt(sheet, intent.amount);
    return { ...base, kind: 'receipt', title: `确认收到 ¥${money(preview.cents)}`, preview,
      details: preview.allocations.map(entry => `${entry.label}：分配 ¥${money(entry.cents)}，剩欠 ¥${money(entry.remaining)}`) };
  }
  if (intent.kind === 'deliver') {
    const preview = trips.previewDelivery({ ...sheet, version: target.version, lineId: null, status: 'delivered' });
    return { ...base, kind: 'deliver', title: '确认整单送达', preview,
      details: ['这张客户单的全部明细将标为已送达。', `原账目：${amounts(preview.before)}`, `送达后：${amounts(preview.after)}`] };
  }
  const preview = trips.startAmendment(target.tripId, target.sheetId);
  preview.customer.items = preview.customer.items.map(item => item.id === target.lineId ? { ...item, [intent.field]: intent.value } : item);
  const result = trips.previewAmendment(preview);
  const change = result.changes[0];
  return { ...base, kind: 'amend', title: '确认更正预览', preview, details: [
    `原明细：${describeItem(change.before!)} · ¥${change.before!.price}/${change.before!.unit}`,
    `更正后：${describeItem(change.after!)} · ¥${change.after!.price}/${change.after!.unit}`,
    `客户订单金额：¥${money(result.original.totalCents)} → ¥${money(result.customer.totalCents)}`,
    `原账目：${amounts(result.before)}`, `更正后：${amounts(result.after)}`,
    ...result.picking.map(entry => `取货：${entry.brand} ${entry.product} ${entry.specification} ${entry.before} → ${entry.after} ${entry.unit}`),
    ...result.unchecked.map(item => `未送达：${describeItem(item)}`),
  ] };
}

export function confirmOfficial(card: OfficialCard): string {
  if (card.kind === 'amend') {
    const version = trips.confirmAmendment(card.preview);
    return `${card.target.name} 已保存第 ${version.version} 版`;
  }
  if (card.kind === 'receipt') {
    const receipt = trips.confirmReceipt(card.preview);
    return `${card.target.name} 已记收款 ¥${money(receipt.cents)}`;
  }
  trips.confirmDelivery(card.preview);
  return `${card.target.name} 已标记整单送达`;
}
