const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'code/miniprogram');
const target = path.join(root, 'code/dist');
fs.rmSync(target, { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc')], { cwd: root, stdio: 'inherit' });
function copyAssets(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, item.name);
    if (item.isDirectory()) copyAssets(location);
    else if (!item.name.endsWith('.ts')) {
      const output = path.join(target, path.relative(source, location));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(location, output);
    }
  }
}
copyAssets(source);
const app = JSON.parse(fs.readFileSync(path.join(target, 'app.json'), 'utf8'));
for (const page of app.pages) {
  for (const extension of ['js', 'json', 'wxml', 'wxss']) {
    if (!fs.existsSync(path.join(target, `${page}.${extension}`))) throw new Error(`缺少页面文件 ${page}.${extension}`);
  }
}
console.log('TypeScript 编译及小程序页面资源检查通过。');
