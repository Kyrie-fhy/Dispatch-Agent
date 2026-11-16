# Dispatch Agent

帮助速冻食品配送员完成录单、取货、送货与对账的微信原生 TypeScript 小程序。

S2 扩展为同趟多客户录单、取货汇总、明细送达、正式单更正与客户明细图导出。收款、真实登录及 AI 能力按后续里程碑推进。

## 文档入口

- [开发 PRD](docs/PRD.md)
- [当前技术方案](docs/技术方案.md)
- [开发任务和验证状态](docs/开发任务.md)
- [S1 操作验收](docs/S1验收.md)
- [S2 操作验收](docs/S2验收.md)
- [开发里程碑](docs/Dispatch%20Agent%20开发里程碑.md)
- [需求分析](docs/需求分析文档.md)
- [项目级 Agent 约定](AGENTS.md)

## 本地检查

```sh
npm ci
npm run check
```

使用 npm 和仓库内 package-lock.json。已核验本地 Node 18.15.0、npm 9.5.0，GitHub Actions 配置使用 Node 22，工作流位于 .github/workflows/check.yml，在推送和 PR 更新时执行同一套检查。远端启用和运行结果见开发任务记录。

## 微信预览

```sh
npm run build
```

用微信开发者工具导入本项目根目录，运行目录由 project.config.json 指向 code/dist。修改源码后重新执行构建。预览可以用自己的微信小程序测试号，将 AppID 填入本地 project.private.config.json，仓库配置中的 touristappid 是占位值。

S1 已通过模拟器录单和 iQOO Z11 退出恢复验收。S2 已通过模拟器主流程和导图检查，安卓真机待验收。[S1 验收记录](docs/S1验收.md) · [S2 验收记录](docs/S2验收.md)

## 目录

```text
AGENTS.md             项目开发规则
README.md             使用入口
project.config.json   微信项目配置
code/miniprogram/     TypeScript、WXML、WXSS 源码
code/dist/            本地构建结果，忽略提交
docs/                 需求、方案、里程碑和验收
tests/                业务与页面事件检查
scripts/              构建和文档链接检查
```

## 协作

`main` 保存已合并的版本。每项工作从 `main` 新建短期分支，通过 PR 汇总改动与检查结果。

重置演示数据会清除当前设备的本地原型数据，需要在页面弹窗中确认。账户隔离与远端保存到 S5 实现。
