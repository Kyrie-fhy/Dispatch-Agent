const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'code/miniprogram');
const target = path.join(root, 'code/dist');
const s6 = process.argv.includes('--delivery-mvp');
const s5 = s6 || process.argv.includes('--wechat-workspace');
const configuredOrigin = s5 && process.env.DISPATCH_MINIPROGRAM_API_ORIGIN;
let origin;
if (configuredOrigin) {
  const url = new URL(configuredOrigin);
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((!loopback && url.protocol !== 'https:') || url.origin !== configuredOrigin) {
    throw new Error('请提供 HTTPS origin 或本机 HTTP origin（不含路径、账号和结尾斜杠）');
  }
  origin = url.origin;
}
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
if (s5) {
  app.pages = s6 ? ['pages/agent/index', 'pages/workspace/index'] : ['pages/workspace/index'];
  delete app.tabBar;
  fs.writeFileSync(path.join(target, 'app.json'), `${JSON.stringify(app, null, 2)}\n`);
  if (s6 || origin) fs.writeFileSync(path.join(target, 'services/workspace-config.js'),
    `exports.apiOrigin = ${JSON.stringify(origin ?? 'http://127.0.0.1:8787')};\nexports.deliveryMvp = ${s6};\n`);
}
for (const page of app.pages) {
  for (const extension of ['js', 'json', 'wxml', 'wxss']) {
    if (!fs.existsSync(path.join(target, `${page}.${extension}`))) throw new Error(`缺少页面文件 ${page}.${extension}`);
  }
}
console.log(`${s6 ? 'S6 配送 MVP' : s5 ? 'S5 微信工作区' : 'S4 本地演示'} TypeScript 编译及小程序页面资源检查通过。`);
