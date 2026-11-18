import { ItemInput, yuanToCents } from './orders';
import { TripDraft } from './trips';

export const textOrderLimit = 1600;
export const textFields = ['product', 'brand', 'specification', 'unit', 'quantity', 'price'] as const;
type TextField = typeof textFields[number];
const labels: Record<TextField, string> = {
  product: '货品', brand: '品牌', specification: '规格', unit: '单位', quantity: '有效数量', price: '有效单价',
};

export function validTextField(field: TextField, value: string): boolean {
  if (!value.trim()) return false;
  if (field === 'quantity') return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  if (field === 'price') {
    const cents = yuanToCents(value);
    return cents > 0 && Number.isSafeInteger(cents);
  }
  return true;
}

export function textOrderQuestions(draft: TripDraft) {
  return draft.customers.flatMap((customer, index) => {
    const name = customer.customer.trim();
    const issues = name
      ? customer.partyId === undefined ? ['请选择已有客户或明确新建'] : []
      : ['请填写客户名称'];
    const lines = customer.items.flatMap((line: ItemInput, i) => {
      const fields = textFields.filter(field => !validTextField(field, line[field])).map(field =>
        field === 'quantity' ? '有效数量（正整数）' : field === 'price' && !line.price ? '单价' : labels[field]);
      return fields.length ? [`${line.product || '第 ' + (i + 1) + ' 条'}：请补齐${fields.join('、')}`] : [];
    });
    return issues.length || lines.length
      ? [{ id: customer.id, name: name || `第 ${index + 1} 位客户`, issues: [...issues, ...lines] }]
      : [];
  });
}
