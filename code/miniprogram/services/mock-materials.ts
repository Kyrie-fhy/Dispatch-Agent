import { images } from '../core/mock-assistant';

// Simulate the recognition boundary so expiry and retries follow the same page path.
export async function readMaterials(ids: string[], text: string, retry: boolean): Promise<string[]> {
  await new Promise<void>(resolve => setTimeout(resolve, ids.length ? 380 : 100));
  if (ids.includes('failure') && !retry) throw new Error('模拟识别失败，原材料仍在，可以重试');
  return [...ids.map(id => images.find(image => image.id === id)?.text ?? ''), text]
    .flatMap(part => part.split(/\r?\n/)).map(part => part.trim()).filter(Boolean);
}
