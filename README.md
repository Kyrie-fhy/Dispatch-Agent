# Dispatch Agent

帮助速冻食品配送员完成录单、取货、送货与对账的微信原生 TypeScript 小程序。

当前为工程准备及 S1 本地录单原型。已实现手动草稿、多条货品、预览修改、确认出单、本地保存及正式单列表。取货与送货状态、收款、真实登录及 AI 能力按后续里程碑推进。

## 文档入口

- [开发 PRD](docs/PRD.md)
- [当前技术方案](docs/技术方案.md)
- [开发任务和验证状态](docs/开发任务.md)
- [S1 操作验收](docs/S1验收.md)
- [开发里程碑](docs/Dispatch%20Agent%20开发里程碑.md)
- [需求分析](docs/需求分析文档.md)
- [项目级 Agent 约定](AGENTS.md)

## 本地检查

```sh
npm ci
npm run check
```

使用 npm 和仓库内 package-lock.json。已核验本地 Node 18.15.0、npm 9.5.0，待启用的远端 CI 模板配置 Node 22。当前 GitHub 凭证缺少 workflow 权限，模板位于 scripts/templates/github-actions-check.yml；授权后移动到 .github/workflows/check.yml 并提交即可启用。

## 微信预览

```sh
npm run build
```

用微信开发者工具导入本项目根目录，运行目录由 project.config.json 指向 code/dist。修改源码后重新执行构建。需准备自己的有效 AppID 与开发者权限，当前 touristappid 是占位配置。

本机尚未安装微信开发者工具，用户尚未准备 AppID 和安卓测试条件。当前通过的是代码编译、业务检查与页面事件模拟，微信页面视觉和真机体验待验收。

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

main 保存检查通过且完成相应验收的版本，每项工作从 main 新建短期分支，提交后创建 PR，写清改动与检查结果。当前工作在 chore/project-foundation，微信页面体验尚待验证，PR 作为可审查交付保留。

重置演示数据会清除当前设备的本地原型数据，需要在页面弹窗中确认。账户隔离与远端保存到 S5 实现。
