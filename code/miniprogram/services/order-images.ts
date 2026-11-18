import { deliverySummary } from '../core/delivery-execution';
import { amountLabel, lineView } from '../pages/order-view';
import { CustomerOrder } from '../core/trips';

type Context = WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D;
const width = 840;
const padding = 48;
const contentWidth = width - padding * 2;
const maxHeight = 1440;
const titleFont = '600 42px sans-serif';
const bodyFont = '30px sans-serif';
const smallFont = '24px sans-serif';

function wrap(context: Context, value: string, font: string): string[] {
  context.font = font;
  const result: string[] = [];
  let line = '';
  for (const character of value) {
    if (character === '\n' || (line && context.measureText(line + character).width > contentWidth)) {
      result.push(line);
      line = '';
    }
    if (character !== '\n') line += character;
  }
  if (line) result.push(line);
  return result;
}

function layout(context: Context, customer: CustomerOrder, version: number) {
  const title = wrap(context, customer.customer, titleFont);
  const reference = wrap(context, `单据 ${customer.id} · 第 ${version} 版`, smallFont);
  const headerHeight = padding + title.length * 55 + reference.length * 34 + 24;
  const total = wrap(context, amountLabel(customer.totalCents, deliverySummary(customer.items).pendingPrices, '订单金额'), titleFont);
  const footerHeight = total.length * 55 + 60;
  const rows = customer.items.map(item => {
    const line = lineView(item);
    const product = wrap(context, line.productLabel, bodyFont);
    const amount = wrap(context, `${line.quantity} ${line.unit} × ${line.priceLabel} = ${line.amountLabel}`, bodyFont);
    return { product, amount, height: (product.length + amount.length) * 42 + 30 };
  });
  const pages: { rows: typeof rows; height: number }[] = [];
  let page: typeof pages[number] = { rows: [], height: headerHeight };
  rows.forEach((row, index) => {
    const foot = index === rows.length - 1 ? footerHeight : 60;
    if (headerHeight + row.height + foot > maxHeight) throw new Error('明细文字过长，无法生成可读图片');
    if (page.height + row.height + foot > maxHeight) {
      pages.push({ ...page, height: page.height + 60 });
      page = { rows: [], height: headerHeight };
    }
    page.rows.push(row);
    page.height += row.height;
  });
  pages.push({ ...page, height: page.height + footerHeight });
  return { title, reference, total, pages };
}

function exportCanvas(canvas: WechatMiniprogram.Canvas, height: number): Promise<string> {
  return new Promise((resolve, reject) => wx.canvasToTempFilePath({
    canvas, x: 0, y: 0, width, height, destWidth: width, destHeight: height, fileType: 'png',
    success: result => resolve(result.tempFilePath),
    fail: () => reject(new Error('图片生成失败，请重试')),
  }));
}

export async function generateOrderImages(canvas: WechatMiniprogram.Canvas, customer: CustomerOrder, version: number): Promise<string[]> {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法打开图片画布，请重试');
  const { title, reference, total, pages } = layout(context, customer, version);
  const files: string[] = [];
  for (const [index, page] of pages.entries()) {
    canvas.width = width;
    canvas.height = page.height;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, page.height);
    context.textBaseline = 'top';
    let y = padding;
    function lines(values: string[], font: string, color: string, height: number) {
      context.font = font;
      context.fillStyle = color;
      for (const value of values) {
        context.fillText(value, padding, y);
        y += height;
      }
    }
    lines(title, titleFont, '#18362b', 55);
    lines(reference, smallFont, '#63716b', 34);
    y += 24;
    for (const row of page.rows) {
      context.fillStyle = '#e2e9e5';
      context.fillRect(padding, y, contentWidth, 1);
      y += 15;
      lines(row.product, bodyFont, '#18362b', 42);
      lines(row.amount, bodyFont, '#18362b', 42);
      y += 15;
    }
    if (index === pages.length - 1) lines(total, titleFont, '#12664d', 55);
    lines([`第 ${index + 1} / ${pages.length} 页`], smallFont, '#63716b', 34);
    files.push(await exportCanvas(canvas, page.height));
  }
  return files;
}

export function saveOrderImage(path: string): Promise<void> {
  return new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({
    filePath: path, success: () => resolve(), fail: reject,
  }));
}
