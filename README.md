# Dispatch Agent

面向速冻食品配送员的微信原生 TypeScript 小程序。当前 MVP 聚焦录单、取货、按客户送货和本次应收。

接手请先读[开发任务](docs/开发任务.md)，确认分支、验收范围和下一步。配送 MVP 使用微信会话和 PostgreSQL 工作区，支持文字、图片和可编辑语音转写录单。

## 文档入口

- 当前交付范围见 [MVP 实施顺序](docs/Dispatch%20Agent%20开发里程碑.md#mvp-实施顺序)。历史业务规则与原型规划见[开发 PRD](docs/PRD.md)和[需求分析](docs/需求分析文档.md)。
- 工程结构和本地规则见[技术方案](docs/技术方案.md)及[项目约定](AGENTS.md)。
- S5 按用途查[本地 API 联调](docs/S5本地联调.md)、[微信真机验收](docs/S5微信试用.md#手机验收)或[异地 HTTPS 部署](docs/S5试用部署.md)。
- S6 查[文字录单与评测](docs/S6文字录单.md)，包括模型配置、评测运行和验收证据。
- S7 查[图片录单](docs/S7a图片录单.md)、[录音转写](docs/S7b语音录单.md)和[混合录单](docs/S7c混合录单.md)，包括入口、接口和验收。
- 历史操作验收见 [S1](docs/S1验收.md)、[S2](docs/S2验收.md)、[S3](docs/S3验收.md)和 [S4](docs/S4验收.md)。

## 本地检查

```sh
npm ci
npm run check
```

依赖版本由 `package-lock.json` 锁定。`npm run check` 检查 TypeScript 类型、S4 页面构建、业务与页面事件及本地文档链接。检查通过后，`code/dist` 可直接用于当前配送 MVP 的微信预览。GitHub Actions 还在 PostgreSQL 18 上运行 `npm run test:server`。服务启动、检查范围和本地运行方式见 [S5 本地联调](docs/S5本地联调.md#5-运行集成检查)。

## 微信预览

```sh
npm run build
```

上述命令构建配送 MVP。用微信开发者工具导入项目根目录，运行目录为 `code/dist`。把测试号 AppID 填入本地 `project.private.config.json`，仓库里的 `touristappid` 用于占位。启动服务时配置 PostgreSQL、微信会话和 DeepSeek。迁移、模型配置及同网手机预览从 [S7b 启动和验收](docs/S7b语音录单.md#启动和验收)进入。

`npm run build:s4` 构建 S4 本地模拟原型。`npm run build:s5` 构建含对账与收款入口的 S5 工作区。`npm run build:s6` 是配送 MVP 默认构建的兼容别名。各命令共用 `code/dist`，运行 `npm run build` 可切回配送 MVP。

使用开发者工具 CLI 或自动化时，在项目窗口的 macOS 菜单栏进入「设置 → 安全设置」，开启「服务端口」。也可按 `⌘ + ,` 打开设置后切到「安全」。重置演示数据会清除当前设备的本地原型数据，由用户在页面弹窗中确认。

## 目录

```text
AGENTS.md             项目开发规则
README.md             使用入口
project.config.json   微信项目配置
code/miniprogram/     TypeScript、WXML、WXSS 源码
code/dist/            小程序构建结果，忽略提交
code/server/          工作区 API、DeepSeek 接入和 PostgreSQL 迁移
docs/                 需求、方案、里程碑和验收
tests/                业务、页面事件和 PostgreSQL 集成检查
scripts/              构建和文档链接检查
```

## 协作

`main` 已合入截至 S7c 的配送 MVP。PR #19 作为独立的账务扩展草稿保留。当前分支基线和待验事项见[开发任务](docs/开发任务.md#远端与试用)，PR 交付要求见[项目约定](AGENTS.md#git-与交付)。
