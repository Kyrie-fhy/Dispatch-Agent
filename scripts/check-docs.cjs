const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = ['README.md', 'AGENTS.md', ...fs.readdirSync(path.join(root, 'docs')).filter(file => file.endsWith('.md')).map(file => `docs/${file}`)];
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (/^(https?:|#|mailto:)/.test(link)) continue;
    const target = path.resolve(root, path.dirname(file), decodeURIComponent(link.split('#')[0]));
    if (!fs.existsSync(target)) throw new Error(`${file} 中的链接不存在：${link}`);
  }
}
console.log(`${files.length} 份文档的本地链接检查通过。`);
