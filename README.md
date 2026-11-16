# Dispatch Agent

帮助速冻食品配送员完成录单、取货、送货与对账的微信原生 TypeScript 小程序。

接手请先读[开发任务](docs/开发任务.md)，从中确认使用的分支、已经验证的能力和下一项操作。S4 预览是本地演示。S5 微信工作区通过 API 支持手动录单、正式出单和恢复本趟记录。

## 文档入口

- [开发 PRD](docs/PRD.md)
- [当前技术方案](docs/技术方案.md)
- [S1 操作验收](docs/S1验收.md)
- [S2 操作验收](docs/S2验收.md)
- [S3 操作验收](docs/S3验收.md)
- [S4 操作验收](docs/S4验收.md)
- [S5 本地服务联调](docs/S5本地联调.md)
- [S5 微信试用与登录验收](docs/S5微信试用.md)
- [S5 HTTPS 试用部署](docs/S5试用部署.md)
- [开发里程碑](docs/Dispatch%20Agent%20开发里程碑.md)
- [需求分析](docs/需求分析文档.md)
- [项目级 Agent 约定](AGENTS.md)

## 本地检查

```sh
npm ci
npm run check
```

依赖版本由 `package-lock.json` 锁定。GitHub Actions 在 PostgreSQL 18 上运行 `npm run test:server`，覆盖账号隔离、正式单与账目流程及备份恢复。服务启动和本地检查见 [S5 本地联调](docs/S5本地联调.md)。

## 微信预览

```sh
npm run build
```

用微信开发者工具导入项目根目录，运行目录为 `code/dist`。上述命令构建 S4 本地演示。S5 开发分支上运行 `npm run build:s5`，并按 [S5 正式页面本机联调](docs/S5微信试用.md#正式页面本机联调)启动服务。两个命令都写入 `code/dist`，切换后在工具里重新编译。`npm run check` 会重建 S4，检查后如需继续 S5 联调，重新运行 `npm run build:s5`。预览时把微信测试号 AppID 填入本地 `project.private.config.json`。仓库中的 `touristappid` 用于占位。

使用开发者工具 CLI 或自动化时，在项目窗口的 macOS 菜单栏进入「设置 → 安全设置」，开启「服务端口」。也可按 `⌘ + ,` 打开设置后切到「安全」。重置演示数据会清除当前设备的本地原型数据，由用户在页面弹窗中确认。

## 目录

```text
AGENTS.md             项目开发规则
README.md             使用入口
project.config.json   微信项目配置
code/miniprogram/     TypeScript、WXML、WXSS 源码
code/dist/            小程序构建结果，忽略提交
code/server/          S5 本地服务及 PostgreSQL 迁移
docs/                 需求、方案、里程碑和验收
tests/                业务、页面事件和 PostgreSQL 集成检查
scripts/              构建和文档链接检查
```

## 协作

`main` 保存已合并的版本。分支依赖和 PR 交付要求见[项目约定](AGENTS.md#git-与交付)。
