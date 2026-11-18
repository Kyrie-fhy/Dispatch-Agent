# Dispatch Agent 技术选型与开源调研

> 调研日期 2026-11-15（Asia/Shanghai）。场景依据为[《需求分析文档》](./需求分析文档.md)和[项目访谈记录](./Dispatch%20Agent%20项目访谈记录.md)。仓库与官方文档通过 GitHub、Context7 和联网检索核验。链接指向本轮抽查的文件和文档。对比基于源码与文档，未部署候选项目、未做真机跑分或识别准确率测试。
> 本文保留选型时的建议。已采用的依赖、结构与运行方式见[当前技术方案](技术方案.md)。

> 本文保留选型依据，实际采用的结构和运行方式见[技术方案](技术方案.md)。

## 1. 要选的是配送员工作台

一人从微信材料录单，预览后正式出单，跨客户汇总取货，按客户及明细送达，最后录一笔收款并分配到旧单和本单。客户不会在小程序购物或在线支付。首轮交付模拟识别的可交互原型。目标产品为安卓手机上的微信小程序，真实试用要验证会话选图、小程序内看图录音、账户隔离、持久化和对账规则。

据此筛选两条底座路线。第一条找已有微信端的商城或接单产品，核对订单角色和状态能否沿用。第二条找现成库存、开票和应收系统，核对配送趟次、单据更正和跨单收款是否能复用。OCR、语音、工作流和组件库独立评估。核心流程属于由程序控制、人工确认的工作流，模型可以辅助录单和理解修改指令。

## 2. 开源项目、许可证与实际可复用范围

**结论：本轮样本中没有找到适合整仓改造成首版的 MIT 业务系统。找到了能直接复用的 MIT 组件和官方 API 示例。** 评估整仓改造时，看它能否保留现有主流程和业务表。只有小程序、订单页或收款按钮，节省的工作有限。

### 2.1 业务底座

| 候选与代码协议 | 技术栈与已核验能力 | 差距和改造难度 |
|---|---|---|
| **litemall · MIT** | Java / Spring Boot、MySQL、Vue 后台、微信原生小程序。商城购物车到下单，用户中心按商业订单状态分页。 [许可证](https://github.com/linlinjava/litemall/blob/a1ef964a7/LICENSE) · [技术栈与功能](https://github.com/linlinjava/litemall/blob/a1ef964a7/README.md) · [小程序订单页](https://github.com/linlinjava/litemall/blob/a1ef964a7/litemall-wx/pages/ucenter/order/order.js) | **高**。可以参考导航、列表分页和请求封装。订单主体、下单入口、状态及金额语义都要换，取货、按明细送达和跨单收款仍需新建 |
| **自主接单小程序 · MIT** | uni-app / Vue 3、NestJS、TypeORM、MySQL。已有小程序、登录、IM 和订单日志。订单创建以用户选购服务、价格与库存校验、员工接单和抽佣为主。 [许可证](https://github.com/Big-Monster-H/order-self-miniprogram/blob/6d5e0701d/LICENSE) · [架构](https://github.com/Big-Monster-H/order-self-miniprogram/blob/6d5e0701d/README.md) · [订单服务](https://github.com/Big-Monster-H/order-self-miniprogram/blob/6d5e0701d/server/src/modules/order/order.service.ts) | **高**。聊天界面可参考，现有聊天是人与人的 IM。订单、员工、支付及结算模块与配送员工作台的流程不同 |
| **InvenTree · MIT** | Python / Django，React / TypeScript 网页。支持销售订单、客户、发运及库存分配。 [许可证](https://github.com/inventree/InvenTree/blob/b2a9218cf/LICENSE) · [前端依赖](https://github.com/inventree/InvenTree/blob/b2a9218cf/src/frontend/package.json) · [销售订单文档](https://docs.inventree.org/en/stable/sales/sales_order/) | **高**。能借鉴货品、销售单和发运的关联。小程序、趟次汇总、实际送达口径及收款分摊仍需实现。将来若库存变成主需求，可再评估作为独立库存系统接入 |
| **OpenStock · MIT** | Python / Flask、SQLite、HTML/JS。仓储、销售单据、客户预收、应收查询及供应商发票识别。代码中的应收查询筛选未付的转账销售单，`mark_paid` 写入整单付款时间。 [许可证](https://github.com/TMBeaver/openstock/blob/abc87dcca/LICENSE) · [应收实现](https://github.com/TMBeaver/openstock/blob/abc87dcca/db.py#L311-L340) · [识别入口](https://github.com/TMBeaver/openstock/blob/abc87dcca/invoice_ai.py) | **高**。是本轮较接近的轻量 MIT 业务参考。它的供应商发票识别服务于入库，收款机制和本项目的部分收款、自动分摊、更正后保留实收不等价，需要重建账务和小程序端 |
| **InvoicePlane · 主应用 MIT 文本，另有商标和 CodeIgniter 条款** | PHP / CodeIgniter 网页应用。付款模型通过 `invoice_id` 关联单张发票与余额。 [项目许可文件](https://github.com/InvoicePlane/InvoicePlane/blob/d61f75a27/LICENSE.txt) · [付款模型](https://github.com/InvoicePlane/InvoicePlane/blob/d61f75a27/application/modules/payments/models/Mdl_payments.php) | **高**。可参考单张发票余额更新方式。要扩展成一次收款对应多张单，还须补齐小程序和整趟配送流程 |
| **Medusa · 社区代码 MIT，企业版材料单列商业条款** | Node.js / TypeScript，PostgreSQL。商城后端有订单编辑、库存、发运、支付模块。 [许可证范围](https://github.com/medusajs/medusa/blob/develop/LICENSE) · [订单编辑](https://docs.medusajs.com/resources/commerce-modules/order/edit) · [发运](https://docs.medusajs.com/user-guide/orders/fulfillments) | **中高到高**。若同时建设客户自助商城，有复用理由。当前即使沿用订单编辑，也要新增小程序、送达后应收和线下跨单收款。要在锁定版本上区分社区与企业代码 |
| **ERPNext · GPL-3.0** | Python / Frappe、MariaDB 为常见部署组合，网页工作台。配送趟次包含多个停靠点。收款分配明细可指向不同单据并记录分配额，核销界面有按先入先出分配的方式。 [许可证](https://github.com/frappe/erpnext/blob/1e2f01a8b/license.txt) · [配送趟次模型](https://github.com/frappe/erpnext/blob/1e2f01a8b/erpnext/stock/doctype/delivery_trip/delivery_trip.json) · [收款分配模型](https://github.com/frappe/erpnext/blob/1e2f01a8b/erpnext/accounts/doctype/payment_entry_reference/payment_entry_reference.json) · [官方核销说明](https://docs.frappe.io/erpnext/payment-reconciliation) | **中高到高**。功能上最值得参考，把「到账」和「分配到哪张单」分开。直接接入还要做小程序和映射总账、发票、发货与更正规则。ERPNext 的未分配预收款处理也不能直接替代本项目待确定的超额规则 |
| **管伊佳 ERP（原华夏 ERP）· Apache-2.0** | Java / Spring Boot、MyBatis、MySQL、Vue 2。官方公开仓库描述进销存、财务及生产，并另行介绍网络版手机入口。 [许可证](https://github.com/jishenghua/jshERP/blob/38ad91e19/LICENSE) · [README](https://github.com/jishenghua/jshERP/blob/38ad91e19/README.md) | **高**。可参考中文单据结构。公开仓库的许可证和网络版展示是两回事。本轮没有核实网络版的小程序源码或默认跨单分配，因此未计入复用 |
| **Crater · AGPL-3.0** | PHP / Laravel、Vue，网页开票和付款产品。 [仓库](https://github.com/crater-invoice-inc/crater) · [许可证](https://github.com/crater-invoice-inc/crater/blob/master/LICENSE) | 许可证不满足 MIT 筛选条件，交付形态也缺司机端。作为开票工具对照即可 |

**维护信号。** GitHub API 按 2026-11-15 截止查询默认分支的最近提交。litemall 为 2025-10-05，接单小程序为 2026-06-08，OpenStock 为 2026-07-21，InvenTree 与 ERPNext 为 2026-11-15。这个信号只说明近期有无提交。选用依赖前，还需检查拟锁定版本的依赖、安全更新、构建结果和迁移说明。

许可证按上表对应仓库文件判断。复用 MIT 代码时保留要求的版权与许可声明，第三方依赖、素材、商标和模型权重按各自条款处理。常见 GPL 部署判断取决于是否交付软件副本，网络访问本身与向客户交付容器或安装包的情形有别。若未来采用 GPL 或 AGPL 底座并对外交付，应以具体方式复核。 [MIT 正文](https://opensource.org/license/mit) · [GNU 许可证 FAQ](https://www.gnu.org/licenses/gpl-faq.html)

### 2.2 可以直接复用的部件

| 层 | 项目、语言与代码协议 | 在 Dispatch Agent 里的用法 |
|---|---|---|
| 微信 UI | **TDesign Miniprogram**，微信组件 / TypeScript，**MIT**。 [许可证](https://github.com/Tencent/tdesign-miniprogram/blob/24eb55925/LICENSE) · [组件文档](https://tdesign.tencent.com/miniprogram/overview) | **低成本，可直接引入**。挑弹层、表单输入、按钮、提示等实际需要的组件，聊天录单和账单布局自己设计。把它当依赖使用，方便升级 |
| 微信 API 示例 | **wechat-miniprogram/miniprogram-demo**，小程序 JS/WXML/WXSS，**MIT**。 [许可证](https://github.com/wechat-miniprogram/miniprogram-demo/blob/master/LICENSE) · [示例](https://github.com/wechat-miniprogram/miniprogram-demo) | **低成本，择段复用**。配合官方 API 文档搭建选图、录音和 Canvas 导出的最小验证 |
| OCR | **PaddleOCR**，Python / Paddle 生态，仓库 **Apache-2.0**。 [许可证](https://github.com/PaddlePaddle/PaddleOCR/blob/dab3fe353/LICENSE) · [项目](https://github.com/PaddlePaddle/PaddleOCR) | 真实试用用同一批样本比较通用多模态模型和「OCR 文本、框位置 → 字段抽取」。后者可定位错字来源，但要增加抽取和部署。测试中文手写、聊天截图里的品牌、规格、数量和金额 |
| 中文转写 | **FunASR**，Python / PyTorch，工具包 **MIT**，模型另有许可。 [代码许可证](https://github.com/modelscope/FunASR/blob/c2107cdd3/LICENSE) · [模型许可](https://github.com/modelscope/FunASR/blob/c2107cdd3/MODEL_LICENSE) · [模型与 API](https://github.com/modelscope/FunASR/blob/main/docs/python_api.md) | 对中文商品名、品牌、箱袋数量，选支持热词的具体模型和推理方式验证。工具包许可证和热词能力不能推及全部权重 |
| 转写对照 | **faster-whisper**，Python / CTranslate2，**MIT**。**sherpa-onnx**，C++/ONNX 及多语言绑定，**Apache-2.0**。 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 前者可作自托管识别基线，后者在离线或 App 端推理有价值。热词、语言和连续识别效果要看所选模型、接口及设备 |
| 结构化抽取 | **Vercel AI SDK**，TypeScript，仓库 **Apache-2.0**。 [许可证](https://github.com/vercel/ai/blob/main/LICENSE) · [结构化输出](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) | 可选，用 schema 校验模型返回的订单草稿。调用模型也可直接用服务商 SDK。结构正确仍可能认错客户或价格，确认分支和账务校验继续由业务代码处理 |
| 工作流 | **LangGraph.js**，TypeScript，**MIT**。 [许可证](https://github.com/langchain-ai/langgraphjs/blob/main/LICENSE) · [人工确认与恢复](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | 等多步骤长任务、跨进程恢复或工具分支明显增加时再评估。中断恢复会重跑所在节点，写入仍需防重复。它的工作流检查点不能代替数据库事务或收款记录 |

首轮原型可以直接模拟抽取结果和转写文本。真正值得保留的两类设计是 ERPNext 的「收款记录与分配明细」和库存系统的「货品、规格、品牌、原单位分别建模」。这两点影响取货拿对、实收追得清，适合直接写入自己的业务模型。

## 3. 整仓改造和从零开发，难在哪里

以下是按功能和依赖推导的相对难度。没有完成同范围的迁移试验，因此不报人天差值。三个方案都须满足同一套需求，模拟原型和真实试用分别比较。

| 工作 | 原生小程序 + 新建业务层 | 改造 MIT 仓库 | ERPNext 作为后端，另写小程序 |
|---|---|---|---|
| 首轮模拟原型 | **中**。三个页面，组件和示例可复用。先实现状态、预览、计算和导图 | **高**。先跑起旧系统，再替换菜单、角色和订单流。原型可以模拟登录及上传，整仓已有的生产功能节省有限 | **高**。新增司机端，启动 ERP 并适配单据。只有业务规则能直接套进 ERP 时才有收益 |
| 草稿、改单、取货、送达 | **中**。在同一个模型上开发，直接按实际流程设计 | **高**。保留旧订单会连带引入库存、付款或商品档案假设，替换旧订单又损失底座价值 | **中高**。已有配送趟次和销售单据，仍要映射品牌对应关系、按原单位汇总、明细送达、单据版本 |
| 应收、跨单收款、更正 | **中高**。需要正确建模、事务、重复提交防护和对账测试 | **高**。最接近的候选分别支持整单标记已付或单发票收款，跨单分配基本要新做 | **中高**。可复用应收与分配机制，须验证已结清单更正、短收或多收、操作追溯和单据联动 |
| 真实材料上传与识别 | **中高**。选图、录音、上传、错误修复、抽取评测均须做 | **中高**。已有登录和上传可局部省工，识别及手动纠错大致相同 | **中高**。做在独立的司机端和接口层，避免直接写正式账 |
| 长期维护 | 一个业务模型、一套微信端，真实试用时加接口和数据库 | 维护自己的功能、改过的旧模块、上游升级冲突及旧技术栈 | 维护微信端、集成服务和 ERP 升级。团队已使用 ERPNext 时，额外学习和部署成本较低 |

**建议业务模块从零写，复用现成组件和 API 示例。** 核心验收用三笔数据就能说明差异。旧单尚欠 60 元，本单已送达应收 164 元，客户这次给 100 元。系统应把 60 元分到旧单、40 元分到本单，本单剩欠 124 元。再更正这张单的应收时，40 元仍在这张单，余额随应收变动。整个过程重试也只应生成一笔到账记录。相比捆绑商城订单或完整总账，专门实现这条规则更容易检查。

如果团队已经在用 ERPNext，优先比较「用现有 ERP 做账、Dispatch Agent 只做录入和配送」的集成方式。若将来还要做客户商城，重新比较 Medusa 和 litemall。这两种变化会提高业务底座的复用价值。

## 4. 跨端框架和原生，分两层选择

微信原生小程序写 TypeScript、WXML、WXSS，运行在微信里。Android 原生写 Kotlin 与 Jetpack Compose，运行在独立 App 里。Taro 和 uni-app 可以产出微信小程序。Flutter 和 React Native 的官方常规目标包括各自支持的 App 平台，微信小程序未列在其中。本轮也未验证第三方转换工具。因而这两类方案应分别比较。 [Flutter 支持平台](https://docs.flutter.dev/reference/supported-platforms) · [React Native 生态平台](https://reactnative.dev/docs/out-of-tree-platforms)

### 4.1 继续做微信小程序

| 方案 | 交互设计与实现 | 渲染性能和影响因素 | 后续维护与适用条件 |
|---|---|---|---|
| **微信原生 + TypeScript（首选）** | 会话选图、相册、小程序内录音、图片导出可直接对接微信 API。表单、弹层用原生组件库，业务流程仍需设计 | 少一层跨端运行时，能直接定位页面数据更新。高频整页刷新、大图解码或长列表依然可能卡。初期用常规渲染，按客户展开、局部更新，测到瓶颈再验证 Skyline | 微信单端的构建和故障定位路径较短。页面模板迁移到其他端需重写，纯 TypeScript 规则和后端可以保留。 [微信开发文档](https://developers.weixin.qq.com/miniprogram/dev/framework/) |
| **Taro + React / TypeScript（多端备选）** | React 组件、hooks 和类型适合复杂表单与状态拆分，可复用部分 H5 与微信 UI。微信会话选图等仍要针对目标端实现 | 常规小程序路径含运行时和模板映射。官方提供长列表优化与 Skyline 模式。Taro 文档要求使用 Skyline 的 worklet 时开启半编译，不能把这条要求等同于启用 Skyline 本身 | 多端或现成 React 团队时回报大。需要维护框架、平台插件和编译产物，端差异仍要单测和实机回归。 [许可证](https://github.com/NervJS/taro/blob/c8c25e589/LICENSE) · [性能指南](https://docs.taro.zone/docs/optimized) · [Skyline 指南](https://docs.taro.zone/en/docs/skyline) |
| **uni-app + Vue 3 / TypeScript（Vue 团队备选）** | Vue 模板、表单绑定、组件生态好上手，可共用多个小程序或 H5 的常用页面。专用 API 使用条件编译或平台封装 | 微信端输出小程序代码，真实表现受编译、运行时、数据差量、组件和基础库影响。原生代码写得低效时也可能更慢，不能只用框架名排序 | 已有 Vue 代码或明确多小程序目标时合适，需同时排查 Vue、uni-app 及微信差异。`uni-app x` 是另一套工具链，编译目标和组件/API 要查各自兼容表。 [Vue 3 分支许可证](https://github.com/dcloudio/uni-app/blob/next/LICENSE) · [编译机制](https://uniapp.dcloud.net.cn/tutorial/) · [uni-app x 小程序支持](https://doc.dcloud.net.cn/uni-app-x/mp/index.html) |

**选原生的直接理由是微信端就是已确认的交付端。** 用户在意能否一边看订单图片一边录音、批量标记送达时页面是否跟得上、导出的长图是否清晰。框架变化不会消除微信的权限和生命周期限制。若第二个端已经排期，React 团队选 Taro，Vue 团队选 uni-app，并先试通专用接口再决定共享页面比例。 [会话选图](https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseMessageFile) · [相册与相机](https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.chooseMedia.html) · [录音](https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start) · [Canvas 导出](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/wx.canvasToTempFilePath.html)

### 4.2 如果产品变成独立 App

| 方案 | 交互和渲染 | 长期维护 | 什么时候选 |
|---|---|---|---|
| **Kotlin + Jetpack Compose** | 能控制 Android 相机、文件、离线数据库和通知等。列表可用惰性布局，仍需避免不必要的重组。可研究在前台启动麦克风类型前台服务后持续录音，受系统版本、权限和设备政策影响 | 直接调试 Android 平台，需维护签名、分发和机型兼容。将来做 iOS 需单独实现页面 | 若业务确认需要微信外、切后台持续录音或重度离线，且 Android 仍是主设备。 [Compose 性能](https://developer.android.com/develop/ui/compose/performance) · [麦克风前台服务](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone) |
| **Swift + SwiftUI** | iOS 系统交互和无障碍可直接适配，能用 Instruments 定位视图更新与卡顿 | 单独维护 iOS 应用、签名和系统适配 | 明确需要独立 iOS App 和系统能力时评估。 [SwiftUI 性能](https://developer.apple.com/documentation/xcode/understanding-and-improving-swiftui-performance) |
| **Flutter + Dart · BSD-3-Clause** | 一套 Widget 支持 Android/iOS 上风格一致的定制交互。Impeller 提供自己的渲染路径，滚动和动画仍取决于页面和设备。媒体、后台及分享依赖插件或原生桥接 | 共享大部分 App UI，维护 Dart 依赖、Flutter 工具链和双端原生集成 | 两端独立 App 都进入排期、重视统一视觉时评估。 [许可证](https://github.com/flutter/flutter/blob/master/LICENSE) · [Impeller](https://docs.flutter.dev/perf/impeller) |
| **React Native + TypeScript · MIT** | React 组织页面，Fabric 使用宿主平台组件体系。能做流畅列表和交互，JS 工作量、组件更新以及原生模块仍会影响体感 | 与 React 技术栈衔接，Android/iOS 构建、权限、原生库和适配都要维护 | 两端独立 App 已排期且 React 复用有价值时评估。 [仓库与许可证](https://github.com/facebook/react-native) · [Fabric](https://reactnative.dev/architecture/fabric-renderer) |

独立 App 需重新设计微信材料导入，不能把应用安装和系统分享等同于小程序从微信会话中选图。测试系统 API 时按实际运行路径做，不能从 Android 前台服务的文档推断任意状态下都能开始录音。 [Android 后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)

### 4.3 用项目自己的数据测

统一使用同一台目标安卓手机、同一微信版本和同一批模拟数据。首轮覆盖约 20 位客户、最多 200 条明细，并比较首次打开、客户列表滚动、批量标记后界面反馈、聊天端密集更新、大图预览和长图导出。记录冷启动时间、交互反馈延迟、掉帧及导出耗时，反复测几次。若要引入 Skyline 或跨端框架，就拿同一页面和数据对测。网络上传和模型等待时间单独记，避免把请求慢算成页面渲染慢。

选图录音单独做一次设备探针。测试在小程序内浏览已选图时开始录音、麦克风权限被拒、切回微信或来电后的中断、转写失败转手填及草稿恢复。本轮通过 Context7 取得微信 API 文档摘录，部分官方链接在联网工具直连时未打开。看图录音体验和导出上限以真机结果为准。

## 5. 结合我的实现和排查能力

这是我在当前环境可以承担的工作，不是从业年限或实测评分。涉及手机、AppID、签名和设备行为，需要实际环境及运行结果。

| 语言与栈 | 我可以负责的部分 | 需要重点验证的部分 |
|---|---|---|
| **TypeScript / JavaScript、React、Vue 3、Node.js** | 把握高。可独立搭建页面和 API、写草稿状态、收款分配、数据校验和回归用例，排查编译及数据问题 | Taro、uni-app 的微信端产物、专用 API 和第三方包兼容须按版本验证 |
| **微信原生 TypeScript / WXML / WXSS** | 把握高。可搭三个页面、原生组件、表单与状态更新，按文档接入选图、录音和 Canvas | 微信开发者工具、基础库、录音中断、图片选择及保存权限以目标设备为准 |
| **Python / SQL** | 把握高。可实现 API、样本处理、OCR/ASR 适配、数据库事务与对账校验 | 模型推理环境和识别效果要用样本和硬件评估。现成 ERP 的定制需先阅读相应业务约束 |
| **Java / Spring Boot** | 可实现接口、排查持久层、构建和版本迁移 | 旧仓库升级、业务插件和部署链路需要先运行项目定位问题 |
| **Kotlin / Compose、Dart / Flutter、React Native 原生模块** | 可实现业务页面、数据层和常见平台集成。React Native 的 TypeScript 应用层把握更高 | 后台录音、厂商权限、插件冲突和性能需用真机、构建日志与 profiler 验证 |
| **Swift / SwiftUI** | 可实现常见页面、网络和状态管理，并协助排查 | 音频会话、后台、签名和多设备表现需 Xcode 和目标设备验证 |

## 6. 建议的落地顺序

1. **首轮原型**用微信原生 TypeScript、WXML/WXSS 和少量 TDesign 组件。用固定样例模拟识别，真正实现草稿、预览确认、汇总、送达、收款分配、版本更正及客户图导出。将货品汇总、金额计算和收款分配写成不依赖页面的 TypeScript。若原型必须走浏览器公开链接，同一业务规则可放到 H5 演示，将来微信端页面单独实现。
2. **真实试用**优先做安卓微信能力探针，再接微信登录、账号归属与持久化。后端建议 Node.js / TypeScript 加 PostgreSQL。保留一笔收款及其分配明细，在一个数据库事务里提交，按客户串行处理分配，用唯一请求键防止重试重复入账。若已有微信云开发环境，也可以评估其服务端事务、权限及异常重试能否覆盖同样的验收用例。 [PostgreSQL 事务](https://www.postgresql.org/docs/current/tutorial-transactions.html) · [行锁](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)
3. **识别接入**先用同一批授权真实样本比较支持图片和结构化输出的模型、云端短语音转写与开源候选。按品牌、数量、单位、价格、客户归属分别记错误，同时记录每单改几处、补充和确认花多久。云端转写可选支持热词的接口先测。模型输出进入草稿，后台规则和用户确认决定正式单据。 [腾讯云短语音](https://cloud.tencent.com/document/product/1093/35646) · [热词](https://cloud.tencent.com/document/product/1093/40996)
4. **真实收款前定规则**。明确补录和错录更正、超额处理、更正后是否重排历史分配。用模拟案例验证少收、已结清单更正、跨单补款及重试，实机验证选图录音与导出。需要长任务恢复时再判断是否引入 LangGraph.js，先用固定任务、输入、期望结果和运行记录保障回归。

这份报告的建议以「首轮模拟原型，正式目标为微信单端」为前提。第二终端排期、现成 ERP 依赖或必须持续后台录音，都会改变选型。
