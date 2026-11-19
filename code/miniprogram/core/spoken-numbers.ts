const digits: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 仨: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const smallUnits: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const largeUnits: Record<string, number> = { 万: 10_000, 亿: 100_000_000 };
const atom = '[0-9]+(?:\\.[0-9]+)?|[零〇一二两俩三仨四五六七八九十百千万亿几点]+';
const measure = '[公斤斤箱袋件个包提盒份条瓶只桶支盘组]';
const tokenPattern = () => new RegExp(`(${atom})(?:\\s*[元块](?:钱?\\s*([0-9零〇一二两俩三仨四五六七八九])([角毛分])?(?!${measure}))?)?`, 'g');

function chineseInteger(word: string) {
  if (!word || word.includes('几')) return NaN;
  if ([...word].every(char => char in digits)) return Number([...word].map(char => digits[char]).join(''));
  let total = 0;
  let group = 0;
  let digit: number | undefined;
  let lastUnit = 1;
  let zero = false;
  for (const char of word) {
    if (char in digits) {
      digit = digits[char];
      if (digit === 0) zero = true;
    } else if (char in smallUnits) {
      lastUnit = smallUnits[char];
      group += (digit ?? 1) * lastUnit;
      digit = undefined;
      zero = false;
    } else if (char in largeUnits) {
      lastUnit = largeUnits[char];
      total += (group + (digit ?? 0)) * lastUnit;
      group = 0;
      digit = undefined;
      zero = false;
    } else return NaN;
  }
  return total + group + (digit ?? 0) * (lastUnit > 10 && !zero ? lastUnit / 10 : 1);
}

function numberValue(raw: string) {
  if (/^\d/.test(raw)) return Number(raw);
  const [whole, fraction] = raw.split('点');
  if (fraction === undefined) return chineseInteger(whole);
  if (!fraction || ![...fraction].every(char => char in digits)) return NaN;
  return chineseInteger(whole) + Number('0.' + [...fraction].map(char => digits[char]).join(''));
}

export interface SpokenNumber { value: number | null; start: number; end: number }

export function spokenNumbers(text: string): SpokenNumber[] {
  const normalized = text.normalize('NFKC');
  const pattern = tokenPattern();
  const numbers: SpokenNumber[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized))) {
    const [, word, change, coin] = match;
    const end = match.index + match[0].length;
    const nextIsMeasure = new RegExp('^' + measure).test(normalized.slice(end));
    const separateOne = change === undefined && nextIsMeasure && /[十百千万亿].*[一二三四五六七八九]一$/.test(word);
    const base = numberValue(separateOne ? word.slice(0, -1) : word);
    const cent = change === undefined ? 0 : (digits[change] ?? Number(change)) * (coin === '分' ? 1 : 10);
    numbers.push({ value: Number.isFinite(base) ? (cent ? (base * 100 + cent) / 100 : base) : null,
      start: match.index, end: separateOne ? end - 1 : end });
    if (separateOne) numbers.push({ value: 1, start: end - 1, end });
  }
  return numbers;
}

export function hasSpokenNumber(text: string, expected: string) {
  return /^\d+(?:\.\d+)?$/.test(expected) && spokenNumbers(text).some(token => token.value === Number(expected));
}
