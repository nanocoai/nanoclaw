# 95分业务能力地图
# 业务能力数据（多消费者共享：架构师 / PM / 代码分析等）
#
# 数据源 & 权威性优先级（高 → 低）：
#   1. 飞书表「仓库职责（完整版）」业务 owner 手工签名维护（核心定位 / 核心功能 / 归属规则 / 状态 / Owner）
#      https://poizon.feishu.cn/base/M9hYbZkmyaTh4ps0M6Dc3rKanR8?table=tblsj8Q5SfzXk82N
#   2. 代码 Go import + 前端 API URL + 路由服务 + 函数注释（客观事实补充，作为 [fact] 字段）
#   3. mothership/project-registry.yaml（项目目录映射）
#
# 冲突裁决：飞书表 = 权威源（owner 亲笔签名「我的仓是干嘛的」），代码反推 = 客观补充。
# 描述句、域归属、归属规则均以飞书表为准；原 md 的代码反推事实（路由数 / README 引用 / 调用关系）
# 在不冲突时作为 [fact] 字段保留，作为客观佐证。
#
# 每仓元数据约定：
#   描述句     [飞书核心定位] 飞书核心功能（owner 亲笔，权威定义）
#   → 关键词   搜索/路由关键字（与原 md 一致，合并飞书核心功能里新增的概念）
#   [owner]    仓库负责人（飞书 @mention）
#   [status]   仅在 ≠"活跃" 时写出：公共包 / 停止新功能
#   [归属]     新功能该不该往这里落的判定规则（飞书功能归属规则原文）
#   [fact]     原 md 代码反推事实（路由数 / README 引用 / 调用关系），客观佐证
#   [tech]     构建/路由/手写流程等技术注释（仅 proto-driven 服务和 web-niepan 有）

# ════════════════════════════════════════
# 订单域 (dingdan) — server/order/，20 个项目
# 核心流程：
#   买家下单：商品浏览(shangxiang) → 下单(ms-trade) → 支付(ms-pay/huijin) → 卖家发货(ms-sale) → 质检(ms-black/lvyue) → 物流追踪(ms-logistic-tracing/lvyue) → 签收(ms-ordertrace)
#   卖家寄售：卖家挂售/寄售(ms-goods-order) → 商品审核 → 上架 → 买家下单 → 卖家从仓库发货(ms-sale)
#   退货退款：买家申请退货(ms-order-reverse) → 退货质检(ms-black-inspection/lvyue) → 退款(ms-pay/huijin) → 追缴(ms-order-reverse)
#   交易撮合：秒杀/竞拍/砍价(ms-trade/ms-bargain) → 订单生成(ms-order) → 支付
#   回收：估价(ms-recycle/shangxiang) → 上门取件(ms-logistic-tracing/lvyue) → 质检鉴定(ms-black/lvyue) → 回收转寄售(ms-recycle/shangxiang)
#   通知：业务事件 → ms-ripples(订单消息触发引擎) → ms-notification(短信/推送/微信/站内信) → 用户
# ════════════════════════════════════════

- ms-order: [买家订单业务] 买家订单的查询、取消等业务
  → 订单, 买家订单, 签收, C2C, 取消订单, 工单, 承诺规则
  [owner] 珊黄(huang shan)
  [归属] 买家订单管理业务
  [fact] 处理订单全生命周期（创建/取消/查询/签收）、承诺规则匹配、物流签收时间多源获取、C2C 咨询确认/提醒发货/结算

- ms-goods-order: [商品订单服务] 侧重提供和卖家商品订单创建与查询、与商品/唯一码/仓储相关的订单状态与数据维护、订单侧 MQ 消费与异步补偿
  → 商品订单, 寄售, 挂售, 卖家订单, 大貔貅, 跨境保税, 转寄, 得物二手
  [owner] 大文豪(JoeGnoix)
  [fact] 45 个路由；覆盖卖家订单管理、商品查询、大貔貅商品、跨境保税、商品收藏/品牌、订单同步、挂/寄售流程（有货号/无货号）、转寄、得物二手订单

- ms-sale: [出售相关服务] 销售侧规则与流程、销售渠道/售卖相关接口与任务
  → 销售, 卖家, 寄售, 发货, 寄快递, 大貔貅, C2C, 出价, 擦亮, 自发货, 包邮, 补贴
  [owner] 大文豪(JoeGnoix)
  [归属] 售卖策略、销售活动或渠道逻辑、销售侧配置与统计等
  [fact] 67 个路由；覆盖寄售管理、普通出售、卖家中心、快递发货（WriteExpress）、大貔貅、C2C、ToB 寄售、出价/改价、擦亮、自发货、包邮/补贴、低价管理

- ms-trade: [买家侧相关核心业务] 侧重于提供和买家相关的核心业务
  → 交易, 秒杀, 抢购, 拍卖, 砍价, C2C, 优惠券, 代付, 下单, 竞拍
  [owner] 锦(Lu)
  [归属] 秒杀、买家下单购买、买家订单详情/列表等各种和买家相关的核心业务
  [fact] 26 个路由；覆盖秒杀（卖家/买家/明星/得物）、订单计算、C2C 交易、拍卖、砍价、未支付订单、代付、优惠券、快递发货规则、潮玩购买

- ms-order-reverse: [售后服务] 交易客退流程、维修业务、无理由规则匹配等
  → 退货, 退款, 取消订单, 逆向, 极速退, 追缴, 维修, 保修
  [owner] 洋葱(Silov)
  [归属] 退货订单的流程维护功能；退货类规则配置和匹配校验功能；数码维修相关功能
  [fact] 25 个路由；覆盖取消订单、维修、退款（普通/极速退/追缴）、卖家退款规则、保修规则、退款快递、修改运单号

- ms-ordertrace: [订单轨迹节点服务] 追踪节点写入与聚合、订单/物流相关轨迹查询、Job/MQ 消费以补齐或修正轨迹、对内对外的追踪读接口（本仓多为手写路由 + internal/dao 形态）
  → 订单追踪, 轨迹, 订单节点, 签收
  [owner] 大文豪(JoeGnoix)
  [归属] 仅追加/查询「发生了什么、何时发生」的订单轨迹与快照类数据
  [fact] 覆盖买家/卖家订单创建事件、买家支付事件、全流程轨迹节点管理、洗护拒洗节点替换、转寄售订单判断
  [tech] 架构=proto-driven(gins框架) | handler签名=func(s *XxxService) Method(ctx context.Context, req *proto.XxxReq) (*proto.XxxResp, error)
  [tech] 路由=proto生成HttpRoutes表 + framework.RegisterHttpRoutes注册(api/bootstrap/route.go)
  [tech] 新增API流程：写.proto(rpc/ordertrace/api/) → bash gen.sh生成代码 → api/service/实现interface → route.go注册
  [tech] 目录：api/build/main.go=入口 | api/service/=handler实现 | internal/dao/=数据层 | rpc/=proto定义
  [tech] ⚠️ 构建机无protoc，禁止走proto生成流程！直接手写handler：匹配上述签名，Service须实现proto已生成的XxxServer interface，路由表在已生成的proto/*.go中

- ms-notification: [消息发送管理服务] push、短信、私信、得物 push 等统一发送管理服务
  → 通知, 短信, 站内信, 推送, 微信, CRM, 消息模板
  [owner] 珊黄(huang shan)
  [归属] 各种类型消息发送
  [fact] 7 个路由；覆盖短信（Sms）、站内信（Letter）、APP 推送（极光）、微信消息、CRM 推送、模板变量校验、得物数据同步

- ms-ripples: [消息服务] 提供业务相关的 Push、短信、站内信、得物消息盒子等集中发送服务
  → 消息触发, 通知引擎, 砍价通知, C2C通知, 回收通知, 延迟发送
  [owner] 锦(Lu)
  [归属] 消息触达
  [fact] 是 ms-notification 的上游业务触达层；注册多种消息通知处理器（砍价/C2C/回收相关），支持空闲时段延迟发送（22:00-09:00 跨天）

- ms-merchant: [商家后台] 寄挂售、直发、深库存、ERP 等订单商家后台操作
  → 商家, 商户, 卖家中心, 库存, 自发货, 物料申请, 权限, 保证金, 试穿
  [owner] 阿志(AZ)
  [归属] 寄挂售、直发、深库存、ERP 等订单商家后台操作
  [fact] 46 个路由；覆盖商户账户、待退回商品、自发货导入、质检后订单、协卖图片、物料申请、商家权限、卖家中心、深度库存、试穿、导出

- ms-bargain: [还价、竞拍业务]
  1. 还价业务：还价、议价、还价成交、系统撮合、补贴、辐射
  2. 拍卖业务：自营拍卖、非自营拍卖、爆品拍卖
  → 砍价, 还价, 竞拍, 拍卖, 自动调价, 平台补贴
  [owner] 珊黄(huang shan)
  [归属] 还价、竞拍等买卖家针对商品价格互动业务
  [fact] 22 个路由；覆盖砍价/还价、卖家/买家竞拍、C2C 砍价、团体竞拍、自动调价、平台补贴、辐射推荐

- ms-tob: [ToB 服务] B 端（商家 / 企业 / 开放能力）侧订单与相关业务能力收口，与 C 端主 App 流程解耦，便于权限、协议与接入形态单独演进。承载 ToB HTTP/开放接口、商家侧订单与经营相关查询或操作
  → ToB, 企业商家, 数字商品, ERP, 库存, 批量验货
  [owner] 大文豪(JoeGnoix)
  [归属] 调用方明确为 B 端/开放平台、或需与 C 端不同的鉴权、协议版本、批量与导出形态时
  [fact] 25 个路由；覆盖数字商品、ERP 对接、JOS 接口、库存管理、商户订单、挂售改价、批量验货

- ms-app-common: [App 壳层] 协议与合规、首页与导航、实验与差异化
  → App通用, 首页, 弹窗, App升级, 用户协议, AB实验, 热词, 金刚位
  [owner] 阿志(AZ)
  [归属] 协议与合规、首页与导航、实验与差异化
  [fact] 26 个路由；覆盖首页内容、Tab 管理、弹窗管理、App 启动/升级、用户协议、AB 实验客户端、域名白名单、搜索热词兜底、首页金刚位/通知/引导

- ms-self-goods: [自营业务] 自营订单相关业务管理
  → 自营, 小仓, 仓库直发, 回收转自营, 成色修改
  [owner] 洋葱(Silov)
  [归属] 对接得物、售后等自营小仓相关的订单数据维护
  [fact] 17 个路由；覆盖商品管理、小仓管理、仓库直发、回收转自营、成色修改导入/导出、自营上架

- ms-configcenter: [业务配置中心] 配置管理和配置读取
  → 配置中心, 应用管理, 动态配置
  [owner] 洋葱(Silov)
  [归属] 提供后台配置管理接口和业务读取配置接口
  [fact] 处理应用管理、配置增删改查、按 MasterKey 获取配置、事件监听器

- ms-community: [卖家说、社区评论] 卖家说、社区评论、C2C 社区
  → 社区, 评论, 留言, 卖家说
  [owner] 阿志(AZ)
  [归属] 卖家说、社区评论、C2C 社区
  [fact] 处理评论/留言管理、卖家说、通知

- ms-throughtrain: [品牌直发服务] 提供商品品牌直发属性维护和查询
  → 直通车, 品牌直发
  [owner] 锦(Lu)
  [归属] 品牌直发卖家信息、商品信息管理
  [fact] 检查卖家是否品牌直发、查询品牌直发订单

- ms-supportsale: [一键转卖] 提供给得物侧调用接口，判断商品是否支持转 95 分出售
  → 销售支撑, 商品详情, 相似款式, 价格趋势, 一键转卖
  [owner] 锦(Lu)
  [归属] 得物一键转卖
  [fact] 83 个路由；与 ms-goods-biz 路由高度相似，处理 SPU 聚合详情、相似款式、尺码、价格趋势

- ms-black-atm: ATM 鉴定终端，处理 App 端拍照、爱果接口获取鉴定报告（未在飞书表登记 owner）
  → ATM, 鉴定终端, 拍照, 爱果
  [tech] 架构=proto-driven(gins框架) | handler签名=func(s *XxxService) Method(ctx context.Context, req *proto.XxxReq) (*proto.XxxResp, error)
  [tech] 路由=proto生成HttpRoutes表 + framework.RegisterHttpRoutes注册(api/bootstrap/route.go)
  [tech] 新增API流程：写.proto(rpc/black-atm/api/) → bash gen.sh生成代码 → api/service/实现interface → route.go注册
  [tech] 目录：api/build/main.go=入口 | api/service/=handler实现 | internal/globaldao/=数据层(注意不是dao/) | rpc/=proto定义
  [tech] ⚠️ 构建机无protoc，禁止走proto生成流程！直接手写handler：匹配上述签名，ctx可断言为*gins.Context获取HTTP信息；路由表在已生成的proto/*.go中

- ms-browser-automation: [基于浏览器的自动化业务] 通过浏览器执行 canvas 绘图等功能
  → 截图, 自动化
  [owner] 锦(Lu)
  [status] 停止新功能
  [归属] 自动化工具

- ms-common-cutimg: 通用图片切图（未在飞书表登记 owner）
  → 切图, 图片处理


# ════════════════════════════════════════
# 商详域 (shangxiang) — server/product/，16 个项目
# 核心流程：
#   商品生命周期：商品创建/导入(ms-goods-core) → SPU/SKU 数据管理(ms-goods) → 得物商品同步(ms-goods) → 商品审核(ms-goods/C2C审核)
#   商品展示链路：商品搜索(ms-goods-rec/ms-goods-feeds) → 商品列表(ms-goods-biz) → 商品详情页(ms-goods-biz/SPU聚合接口) → SKU 选择/价格趋势(ms-goods-biz)
#   推荐与信息流：Tab推荐/金刚位/主题推荐/同款推荐(ms-goods-rec) → 商品Feed/榜单(ms-goods-feeds) → AI商品详情(ms-goods-feeds)
#   用户体系：注册/登录(ms-member) → 账户管理/地址管理(ms-member) → 用户生态/卖家任务/消息中心(ms-user-ecology) → 风控(ms-user-ecology)
#   筛选过滤：尺码/颜色/价格/类目过滤(web-durian) → 限价活动(ms-activity) → 商品列表展示
#   回收（业务在订单流程中、代码归属在商详）：估价/AI估价(ms-recycle) → 回收订单/转寄售(ms-recycle)
#   跨境（业务在订单流程中、代码归属在商详）：跨境商品/海关备案/30天最低成交价(ms-international)
# ════════════════════════════════════════

- ms-goods: [承载"自建 95分商品 + 得物镜像商品"双源数据的统一管理、检索与一致性治理，是商品域的事实标准服务。多入口形态：admin（运营写）+ api（对外读）+ job（异步/同步）]
  - 商品基础数据：SPU/SKU/品牌/类目/属性/系列/尺码模板的增删改查与映射
  - 得物双源同步：得物 SPU/SKU/品牌/类目/属性/价格/产品图镜像与映射
  - 检索与列表：基于 ES 的供货商列表、同款 V2、最低价、SKU 最优、快速搜索
  - 尺码页/单品页：尺码、销售属性、相邻 SKU、瑕疵、供货入口、多渠道价
  - 标签 / 营销 / C2C：标签体系、Top5000、长库存、C2C 审核与配置
  - 异步一致性：宽表同步、Binlog 监听、去重、调价、各类 Sync Job
  → 商品, SPU, SKU, 成色, 图搜, 比价, 商品同步, 得物
  [owner] 珂(Kagami)
  [归属]
    - 对外 API：面向 APP 与下游微服务的读接口，承载 Goods/Spu/Sku/GoodsList/Brand/Category/CutImg/Dewu 等 gRPC 服务，覆盖尺码页、单品页、供货商列表、瑕疵、价格查询
    - Admin 后台：承载商品域全部运营写操作，包括 SPU/SKU、品牌/类目、属性体系、系列/尺码、标签、封禁、长库存、得物映射、潮玩等
    - Job 任务：负责异步一致性，包含 RabbitMQ/Kafka/Canal Binlog 消费、宽表同步、商品去重、得物价格/属性/类目同步、标签状态更新等 Cron
    - 共享业务：跨入口复用的重业务实现，如 ES 检索 v7、宽表 binlog、得物多渠道价、相似/同款、供货入口判定
  [fact] 处理 SPU/SKU 数据、成色转换、阿里图搜比价、MQ 消费限流

- ms-goods-biz: [商品域 C 端商详、首页金刚位、部分得物侧供给场景] 商详、聚合商详、瀑布流部分场景、首页金刚位
  → 商品详情, 商品列表, SKU, 批量取回, 穿搭, 销售历史, 相似款式, 价格趋势, SPU聚合
  [owner] 昭东(zhaodong)
  [归属] 商详、聚合商详、瀑布流部分场景、首页金刚位等对 C 端接口
  [fact] 85 个路由；覆盖商品列表/详情/SKU 详情/购买信息、SPU 聚合详情接口、批量取回、穿搭、脚型报告、销售历史、商品订阅、相似款式推荐、分享、尺码模块、价格趋势

- ms-goods-core: [统一承载 SPU/SKU 主数据、关系维护与任务调度，并对外提供稳定的 Proto HTTP 能力] 提供 SPU/SKU 查询接口，支持商品导入 Cron、绑定得物 SKU、批量订单消费，协同缓存、MQ 与下游服务调用
  → 商品核心, SKU, SPU, 数据层, 得物SKU
  [owner] 无风(wf)
  [status] 停止新功能
  [归属] api 负责对外接口；job 负责 Consumer/Cron 异步任务；internal 承载业务与 DAO；rpc 负责协议定义与代码生成

- ms-member: [账号相关对应 db 的增删查改接口] 用户表、用户映射表、用户地址表等 db 的增删查改 api
  → 会员, 用户, 账户, 登录, 手机号, 微信, 地址, 卖家类型
  [owner] 浅(zoro)
  [归属] 底层 db 的 model 层
  [fact] 16 个路由；覆盖按 ID/手机号/微信 UnionId 查询、账户管理、微信账户映射、地址管理、虚拟账户、卖家类型、用户状态

- ms-user-ecology: [用户生态相关业务] 我的主页、以及用户维护的相关信息
  → 用户生态, 卖家, 消息中心, 用户协议, 客服, 登录, 风控, 快速开通
  [owner] 克莱恩(Klein·Yueqiang), 昭东(zhaodong)
  [归属] 95 分 C 端、我的、尺码信息等
  [fact] 51 个路由；覆盖消息中心、卖家任务、用户协议、得物商户对接、客户端信息、登录、用户定位、客服、卖家数据中心、风控发起与比对、快速开通、隐私更新

- ms-live: [直播模块] 直播模块
  → 直播, 关注推荐, 观众, 公告
  [owner] 叶李新
  [status] 停止新功能
  [归属] 直播模块
  [fact] 10 个路由；覆盖商品工具栏、关注推荐、观众列表、公告、开播前信息

- ms-goods-rec: [商品推荐] 各种场景搜索、推荐、得物侧接口转发、默认价格推荐
  → 推荐, 商品推荐, 金刚位, 同款推荐, 品牌墙, 商品搜索
  [owner] 叶李新
  [归属] 各种场景搜索、推荐、得物侧接口转发、默认价格推荐
  [fact] 处理 Tab/金刚位/主题/同款推荐、品牌墙、商品搜索

- ms-goods-feeds: [C 端搜推场景]
  - 后台：主题场景增删改查，资源位（金刚位）配置增删改查，捞月配置
  - api：主搜、首页推荐、分类 tab 推荐、星辰推荐瀑布流、金刚位、非星辰（UniversalCommodity）、秒杀、得物秒杀、品牌等场景瀑布流、榜单功能
  - job：商品预缓存、捞月数据检查、榜单检查
  → 商品Feed, 信息流, 榜单, 搜索, AI详情, 预缓存
  [owner] 无风(wf)
  [归属] 同上（后台 / api / job 三入口拆分）
  [fact] 22 个路由；覆盖搜索、推荐、秒杀、品牌、得物推荐、AI 商品详情、榜单管理（创建/关闭/更新）、场景可见、预缓存

- ms-atm-contact: ATM 鉴定报告管理，处理爱果爬虫获取报告、图片上传处理、SKU 匹配（未在飞书表登记 owner）
  → ATM, 鉴定报告, 爱果, SKU匹配

- web-durian: [BFF 服务，最关键的职责是承接 95 分在得物 APP 的核心流量入口] 得物尺码页（独立部署、RT ≤ 30ms）、得物第三方接口（异步价格、可售校验、自定义入口、置换、貔貅）、SPU/SKU 列表详情筛选、商品搜索与 Suggest、优惠券与券后价、订单与 TCC 余额、得物支付与 ms-black/WMS 回调。同时承载会员、社区、维修、地址、PageBuilder、周热销榜、JPush/极验/推送通道、OSS 代理等配套能力
  → 筛选, 过滤器, 尺码, 颜色, 价格区间, 类目, BFF, 得物入口
  [owner] 珂(Kagami)
  [归属] HTTP 处理器按业务域拆分到 api/http/api_third|api_goods|api_pay|api_black|api_search|api_pagebuilder/ 及根目录散文件；业务逻辑集中在 api/service/，复杂域单独建子包（dewu_sizepage、dewu_supplier、spu、search、coupons、order、pagebuilder、hotgoods、kafka_client 等）；请求/响应 DTO、枚举、常量、筛选器统一放在独立 Go module rpc/；基础设施在 api/{build,conf,global,middleware,dao,utils,tests} 与 docs/

- ms-activity: [各类独立营销活动] 限价锁价优惠券补贴活动、锁货费率补贴活动、520 AI 视频活动的相关操作
  → 活动, 限价, 锁价, 商品活动
  [owner] 无风(wf)
  [归属] 限价锁价优惠券补贴活动、锁货费率补贴活动、520 AI 视频活动的相关操作
  [fact] 3 个路由 + 13 个定时任务；覆盖限价活动查询、商品限价信息、批量锁定价格、商品导入/更新/调价

- ms-recycle: [回收业务所有相关场景服务] 回收订单、回收商、回收报价
  → 回收, 估价, 鉴定师, 转寄售, 批量回收, 捐赠, AI估价, 3C回收
  [owner] 浅(zoro)
  [归属] 95 分回收业务的所有相关场景
  [fact] 17 个路由；覆盖回收估价、鉴定师回收订单、转寄售回收、回收问询、补贴信息、批量回收、回收捐赠、AI 估价、3C 自营回收、跟价配置

- ms-international: [95 分国际跨境场景相关] 国际相关新增、查询、报关、税费查询
  → 跨境, 国际, 免税, 保税, 海关备案, 寄售Plus
  [owner] 浅(zoro)
  [归属] 95 分国际跨境的所有相关场景
  [fact] 11 个路由；覆盖得物跨境/免税 API、寄售 Plus、跨境商品管理、海关备案、30 天最低成交价查询

- 95fen-app-backend: [老 95 分商家后台部分功能和涅槃后台的部分功能]
  [owner] 无风(wf)
  [归属] 老 95 分商家后台部分功能和涅槃后台的部分功能
  [fact] PHP，历史遗留

- jiuwu: [老 95 业务大仓，目前剩余边缘业务仍在使用] 95 分 C 端后台业务都有涉及，目前无核心业务，仅边缘业务
  [owner] 无风(wf)
  [归属] 95 分 C 端后台业务都有涉及，目前无核心业务，仅边缘业务
  [fact] PHP，历史遗留


# ════════════════════════════════════════
# 汇金域 (huijin) — server/finance/，15 个项目
# 核心流程：
#   支付：下单(dingdan) → 创建支付单(ms-jiawu/生成JW订单号) → 支付渠道处理(ms-pay/支付宝/微信/得物跨境/佳物分期) → 支付回调更新业务状态(ms-pay)
#   退款：退货审核通过(dingdan) → 发起退款(ms-pay) → 余额/原路退回 → 追缴(dingdan)
#   费率计算：商品出价/下单 → 匹配费率规则(ms-rate/基础/活动/定制/仓储) → 计算卖家费用 → 费用快照(ms-rate)
#   优惠券：规则创建/审核(ms-discountcenter) → 优惠券发放 → 下单时核销 → 过期清理/推送
#   保证金：大商家入驻 → 保证金充值(ms-pay-bigseller) → 挂售时检测 → 退出时退还
#   结算：交易完成 → 卖家费用计算(ms-finance) → 打款
#   客服：用户咨询 → ms-customer-robot(智能客服) → 会话决策/自动SOP/聊天机器人 → 人工升级
#   AB 实验：业务需要分桶时 → ms-abtest 配置实验/分层/用户分组/hashkey 计算
# ════════════════════════════════════════

- ms-pay: [支付、退款、提现、结算] 处理平台资金业务的核心服务
  → 支付, 付款, 退款, 余额, 代扣, 支付流水, 微信支付, 支付宝, 佳物分期
  [owner] 童话(skyfly)
  [归属]
    支付服务承接当前 95 分所有的三方支付业务的对接，封装下游服务商一系列资金服务接口，以高可用性、高安全性为目标。我们的目标：稳定、高感知度、高追踪度。
    任何资金问题，可以在飞书找裘年宝寻求帮助。

    支持哪些方式的支付？
    按支付方式划分：
      - 支付宝支付（花呗分期）
      - 微信支付（小程序支付）
      - 得物支付中台
      - 佳物分期支付
      - 得物收单系统之微信二清支付
    按业务域划分：
      - 购买下单
      - 还价保证金
      - 拍卖保证金
      - 挂售出价保证金
      - 支付寄售取回费用
      - 大商家入驻充值
      - 保卖充值
      - 用户余额服务，包括提现、打款、转账
  [fact] README "95分资金微服务"；处理支付流水管理、业务订单号更新、支付方式转化、余额处理、代扣支付、退款任务、手机号脱敏

- ms-jiawu: [佳物支付] 佳物支付相关服务，包含分期试算、账号管理、静默登录等功能
  → 资金, 支付底层, 订单号生成, 结算, 佳物支付, 分期
  [owner] 魏宇(Evan)
  [归属] 涉及佳物支付的功能接口
  [fact] README "95分资金微服务"；处理支付/结算订单号生成（28 位 JW/JWS 开头）、支付方式转化、金额分转元、队列切分

- ms-rate: [服务费] 服务费创建、更新、查询。所有的服务费费用都在这
  → 费率, 手续费, 卖家费率, 仓储费率, 定制费率, 审批
  [owner] 魏九(Jesse Wei)
  [归属] 服务费相关功能
  [fact] 29 个路由；覆盖基础/活动/定制/仓储费率管理、费率匹配规则、卖家费率查询、审批、调价集合、商品 ES 查询

- ms-finance: [汇金业务] 批量服务费查询
  → 财务, 结算, 卖家费用
  [owner] 鹏七(dakun)
  [归属] 汇金业务层调用接口
  [fact] 处理卖家费用

- ms-discountcenter: [优惠券] 券后价计算、优惠券核销、优惠券发放
  → 优惠券, 折扣, 活动, 规则管理, 优惠券发放
  [owner] 麓峻(Eric)
  [归属] 与优惠券相关的功能
  [fact] 处理规则创建/修改/删除、审核回调、优惠券清理/消费/过期推送

- ms-im: [C2C IM 聊天] C2C 商品用户之间聊天互动，包含商品的还价、确认还价、支付信息通知、发货信息通知
  → IM, 即时通讯, 消息, 买家消息, 卖家消息, C2C
  [owner] 魏九(Jesse Wei)
  [归属] C2C 通知

- ms-customer-robot: [客服机器人] 客服机器人依赖数据查询、客服工具提供
  → 客服, 机器人, 智能客服, 自动回复, 会话决策, SOP, 聊天机器人
  [owner] 鹏七(dakun)
  [归属] 客服
  [fact] 25 个路由；覆盖商品/订单/优惠券/用户/退款/物流/赔偿查询、取消订单、会话决策、保证金、自动客服 SOP、聊天机器人

- ms-trade-identify: [在线鉴别服务] 用户拍图，并支付鉴别费用，平台提供鉴别真假服务
  → 交易鉴定, 鉴别, 支付回调, 类目, 品牌, 在线鉴别
  [owner] 童话(skyfly)
  [归属] 在线鉴别
  [fact] 处理支付/鉴别结果回调、类目/品牌/系列查询、发布前置校验

- ms-pay-bigseller: [大商家] 提供大商家保证金充值、使用锁定、释放、退出相关功能
  → 保证金, 大商家, 押金, 信用商户, 保证金退款
  [owner] 鹏七(dakun)
  [归属] 与大商家相关的功能
  [fact] 7 个路由；覆盖保证金退款/账户/日志、信用商户、保证金优惠券、保证金释放/锁定重算

- ms-abtest: [95 分 abtest 服务] 提供 95 分在线应用的流量 AB 实验、分发统计
  → AB测试, 实验, 分组, 分层, hashkey
  [owner] 舒白(Song)
  [归属] 在线 AB 实验平台
  [fact] 10 个路由；处理实验配置/分层/用户分组、hashkey 实验计算、Etcd 同步

- ms-cron: [定时任务调度] 提供平台所有定时任务调度的平台
  → 定时任务, 调度, gocron, 任务管理
  [owner] 童话(skyfly)
  [归属] 任务调度
  [fact] README "gocron"；处理任务执行/监控/超时处理/强制杀死

- ms-page-gen: [页面搭建器] 前端页面搭建器
  → 页面生成, CMS, 页面发布, ES同步, 页面搭建器
  [owner] 魏九(Jesse Wei)
  [归属] 页面搭建器相关
  [fact] 7 个路由；处理项目/页面/历史管理、ES 同步、页面下线

- ms-radar: [雷达爬虫] 根据爬取的外网包表配信息，新增货号或者补充信息基本属性
  → 雷达, 爬虫, 货号扩充
  [owner] 魏九(Jesse Wei)
  [归属] 扩充货号和扩展商品属性

- ms-image-refinement: [图片优化] 输入原始图片，输出优化后的图片
  → 图片优化, 精修
  [owner] 鹏七(dakun)
  [归属] 图片优化

- jiuwu-cron-admin: 定时任务管理后台（未在飞书表登记 owner）


# ════════════════════════════════════════
# 履约域 (lvyue) — server/fulfillment/，14 个项目
# 核心流程：
#   收货入库：卖家发货 → 物流揽收(ms-logistic-tracing) → 到仓签收 → 收货入库(ms-black) → 库位分配(ms-bwms)
#   质检鉴定：收货后 → 鉴定能力匹配(ms-black-identify) → 质检检验(ms-black-inspection/瑕疵/3C/IMEI) → 合法性校验(ms-black-legality) → 质检拍照 → 质检报告
#   瑕疵处理：质检发现瑕疵 → 瑕疵分级(ms-black-inspection) → 买家问询确认/撮合(ms-black-inspection) → 涅槃审核
#   发货：质检通过 → 发货校验(ms-black/DeliveryCheck) → 批量发货(ms-black/BatchDelivery) → 运费计算(ms-freight) → 物流下单(ms-logistic-tracing) → 物流追踪
#   自主下单寄快递：后台操作(web-niepan) → 创建快递单(ms-black/CustomDelivery) → 运费计算(ms-freight) → 物流下单
#   退货检验：买家退货到仓 → 退货质检(ms-black-inspection/RefundInspection) → 瑕疵判定 → 退款(ms-pay/huijin)
#   洗护：质检后需洗护 → 洗护类型确认(ms-clean/焕然一新) → 绑扣送洗(ms-clean) → 洗护完成回仓 → 继续发货
#   仓储管理：库位管理(ms-bwms/四级) → 上架/下架 → 盘点 → 异常商品 → 前置仓调拨 → 集包
#   图片处理：商品到仓 → 白底图抠图(ms-goods-whitebgimg) → 积木拍照校验 → 水印处理
#   数据运维：数据清洗任务(ms-scrub-data) → 刷数/造数 → 告警监控 → 技术方案评审
# ════════════════════════════════════════

- ms-black: [履约主要服务, 没有明确子服务的需求统一放到此服务中] 历史上承载质检、瑕疵、WMS、鉴别、物流等全部逻辑，目前仍有下游服务未迁完的遗留代码
  → 供应链, 收货, 发货, 批量发货, 退货质检, 寄快递, 自主下单, 瑕疵, 问询, 鉴定, 仓储, 工单
  [owner] 盖仑(WJ)
  [归属] 新接口按领域写到对应下游服务（WMS 相关→ms-bwms、鉴别相关→ms-black-identify、质检相关→ms-black-inspection、物流相关→ms-logistic-tracing 等），并持续从 ms-black 拆出遗留代码到对应子服务；如果功能不属于任意子服务，则把功能代码放到 ms-black 上
  [fact] 承担履约域 API 网关职责（292 个路由）；部分接口本服务实现，部分转发下游微服务；覆盖收货入库、发货校验与批量发货、退货质检、自主下单寄快递（DES）、瑕疵处理与问询、鉴定能力、仓储库位与容器短驳、订单履约管理、质检拍照、洗护、工单、看板等

- ms-logistic-tracing: [物流轨迹] 主流承运商轨迹抓取、下单/取消、OFC/OFS/TMS 对接、全球履约、自寄/卖家寄、承运商匹配、到达时效
  → 物流, 快递, 轨迹, 揽收, 上门取件, 承运商, 卖家自发, 运费退款
  [owner] 九歌(Rocky)
  [归属] 物流轨迹、承运商对接、OFC/OFS/TMS、到达时效、物流属性
  [fact] 20 个路由；覆盖物流轨迹查询、上门取件（普通/顺丰/京东）、揽收下单与取消、到达时间预测、卖家自发货、运费退款

- ms-freight: [运费 / 取件] 运单管理、上门取件、取件运费补贴、回收配置、运费通知
  → 运费, 快递费, 运费补贴, 上门取件, 卖家退回
  [owner] 九歌(Rocky)
  [归属] 运费计算、取件调度、运费补贴、回收配置
  [fact] 7 个路由；覆盖运费订单、上门取件费用、卖家退回设置、运费退款、物流节点上报

- ms-black-identify: [鉴别服务] 鉴别流程、鉴别规则、鉴别结果流转；对外鉴别相关接口
  → 鉴定, 鉴别, 免费鉴定, 鉴定配置, 鉴定拦截, 鉴别贴, 中检
  [owner] 九歌(Rocky)
  [归属] 所有与鉴别相关的功能
  [fact] README "95鉴别服务"，17 个路由；覆盖鉴定能力配置（品类/分组级）、免费/离线鉴定、鉴定拦截、鉴别贴生命周期、得物鉴别结果/中检/复核/工单/审批

- ms-black-inspection: [质检服务] 普通质检、3C 质检、后验、客退核验、3C 维修单、效期管理、质检瑕疵
  → 质检, 检验, 瑕疵, 问询, 3C检验, 退货检验, 工位, 维修工单
  [owner] 盖仑(WJ)
  [归属] 质检（含 3C）、后验、客退核验、3C 维修、效期、瑕疵相关
  [fact] 34 个路由；覆盖瑕疵判定/分级、瑕疵问询（买家确认/涅槃审核/撮合）、得物瑕疵质量标准、工位管理

- ms-bwms: [仓储 / WMS] 仓库基础数据、库区/库位管理、前置仓货架管理、WMS 功能模块
  → 仓储, WMS, 库位, 上架, 下架, 盘点, 前置仓, 集包, 拣货
  [owner] 萨尔(Thrall)
  [归属] 仓库、库区、库位、货架、库存流转等仓储基础能力
  [fact] 25 个路由；覆盖园区/仓库/库区/库位四级管理、商品上下架、库存盘点、异常商品、前置仓调拨、OFC 对接、集包、物料、拣货

- ms-clean: [清洗服务] 平台清洗、自清洗、内部清洗、返修清洗
  → 洗护, 送洗, 绑扣, 清洁, 维修, 自助洗护, 焕然一新
  [owner] 一夫(if)
  [归属] 清洗流程、返修清洗、清洗服务对接
  [fact] 12 个路由；覆盖绑扣送洗、洗护类型确认（焕然一新对接）、拒洗、自助洗护、维修清洁、回仓

- ms-black-common: [履约域公共包] 统一承载履约域所有 DAO 层代码；统一常量/枚举定义；跨服务共享的基础类型
  → 商品查询, 唯一码, 告警, 操作日志, 权限校验
  [owner] 萨尔(Thrall)
  [status] 公共包
  [归属] 任何 DAO；任何跨服务共享的常量、枚举、基础类型定义
  [fact] 10 个路由；提供商品查询、唯一码、告警、操作日志、权限校验、成色查询等公共能力

- ms-scrub-data: [履约数据工厂 / 运维平台] 数据擦洗、数据工厂、审批流、告警、分析、订单/用户生命周期查询、技术方案评审、发布、模板、上传、方法管理等
  → 数据清洗, 刷数, 审批, 告警监控, 造数工厂
  [owner] 一夫(if)
  [归属] 履约侧运维工具、数据治理、内部审批流、告警分析、非核心业务的工具类能力
  [fact] 55 个路由；覆盖飞书机器人

- ms-goods-whitebgimg: [抠图 / 白底图] 积木多拍抠图、SPU/SKU 白底图生成、临时抠图任务
  → 抠图, 白底图, 图片处理, 水印, 积木拍照
  [owner] 萨尔(Thrall)
  [归属] 抠图、白底图生成、图片背景处理
  [fact] 14 个定时任务；覆盖水印、尺寸换算、积木拍照校验、鞋盒校验

- ms-black-legality: [合规 / 正品校验] SKU/SPU 维度的合规与合法性校验
  → 合法性, 寄售校验, 鞋类检查
  [owner] 萨尔(Thrall)
  [归属] 商品合规、正品校验、合法性规则
  [fact] 处理寄售合规检查、鞋类校验

- ms-black-tortoise: [玄武后台 Proxy] 仅玄武后台的权限控制、账号增删改查；其余接口通过 Apollo routerProxy 配置转发到下游服务
  → 玄武后台, 反向代理, 鉴权, 权限
  [owner] 萨尔(Thrall)
  [归属] 玄武账号/权限管理；新接口优先走 Apollo 转发配置，不在此仓库写业务逻辑
  [fact] README "玄武后台proxy"

- ds-admin-black: 玄武供应链管理后台（README "玄武·BLACK 供应链履约系统"，未在飞书表登记 owner）
- fe-scrub-data: 数据清洗管理后台前端（Ant Design Pro，未在飞书表登记 owner）


# ════════════════════════════════════════
# 基架域 (jijia) — server/infrastructure/，6 个项目
# 角色：基础设施层，被所有业务域依赖，不包含业务逻辑
# 飞书表「仓库职责（完整版）」不覆盖此域，沿用代码侧标注
# 核心能力：
#   API 网关：请求分发/熔断/灰度/精准路由(ms-gateway)
#   基础框架：MQ 统计/Trace/服务发现/HTTP 客户端(ms-atom)，被 56 个项目依赖
#   数据安全：KMS 密钥管理/加解密/摘要(ms-crypt)，ID 混淆防爬(ms-oid)
#   研发效能：审批/机器人/GitLab/RBAC/覆盖率/BI(ms-yunti)
#   通用工具：CDN/OSS/短链接/OCR/以图搜图/翻译(ms-misc)
# 注：AB 实验 ms-abtest 由业务 owner 划归汇金域
# ════════════════════════════════════════

- ms-atom: 基础框架服务，提供 MQ 统计、Trace 过滤、日期工具、服务发现、HTTP 客户端等基础组件。被 56 个项目 import
  → 基础框架, MQ统计, 服务发现, HTTP客户端

- ms-gateway: API 网关，处理请求分发、得物 SK 解密、熔断配置、灰度方案、Hash 分桶、精准路由
  → 网关, API网关, 请求分发, 熔断, 灰度, 路由

- ms-yunti: 研发效能平台云梯（48 个路由），处理审批、系统用户、机器人管理、GitLab Webhook、RBAC 权限、数据库迁移、仓库管理、BI、Jaeger 链路、代码覆盖率
  → 研发效能, 云梯, 审批, 机器人, GitLab, RBAC, 覆盖率

- ms-misc: 通用工具（16 个路由），处理 CDN/OSS、短链接、图片处理、OCR、美图接口、以图搜图、文字翻译
  → 工具, CDN, OSS, 短链接, OCR, 以图搜图, 翻译

- ms-crypt: 数据加解密（4 个路由），处理 KMS 密钥管理、加密/解密/摘要
  → 加密, 解密, KMS, 数据安全

- ms-oid: ID 混淆服务，将连续 ID 转为不可推测的 OID，防爬
  → OID, ID混淆, 防爬


# ════════════════════════════════════════
# 前端/移动端 (domain=null)
# 这部分不在飞书表「仓库职责（完整版）」覆盖范围内，沿用代码侧标注
# ════════════════════════════════════════

- web-niepan: 95分运营后台（涅槃），30+ 页面模块（订单/商品/供应链/财务/用户/活动/配置/数据看板）。后端对接：ms-black(lvyue)、ms-black-identify(lvyue)、ms-black-inspection(lvyue)、ms-bwms(lvyue)、ms-order-reverse(dingdan)、ms-rate(huijin)
  → 后台, 涅槃, 运营管理, 订单管理, 商品管理, 供应链管理, 财务管理
  [tech] 框架=React16+TypeScript4.6+AntDesign4 | 构建=webpack(react-app-rewired)+yarn | 端口=8080
  [tech] 路由=src/route/routes.ts(HashRouter) | 菜单=src/config/menu.ts
  [tech] API定义在各模块pages/模块/api/index.ts，用axios实例($axios=admin-api, $lemonAxios=lemon-api)
  [tech] 新增页面：pages/模块/页面/index.tsx → route/routes.ts注册 → config/menu.ts加菜单
  [tech] 新增API：在pages/模块/api/index.ts中加函数，import $axios from @/utils/axios

- web-dollar: 商家后台（斗金）。后端对接：ms-merchant(dingdan)、ms-sale(dingdan)
  → 商家后台, 斗金, 卖家, 出价, 价格管理

- web-basalt: 玄武质检操作后台。后端经由 ms-black-tortoise(lvyue) 代理
  → 玄武, 质检后台, 供应链操作

- web-page-h5: H5 可视化页面搭建平台
  → H5搭建, 可视化, 搭建器

- web-miniprogram: 95分微信小程序
  → 小程序, 微信, 买家端

- web-abtest: AB 实验管理前端（React），对接后端 ms-abtest(huijin)，提供实验配置/分层/用户分组等管理界面
  → AB测试, 实验管理, 分组, 分层

- web-taro: 95分 Taro 跨端应用（H5 + 微信小程序），基于 Taro 框架实现跨端复用
  → Taro, 跨端, H5, 小程序

- web-buried-point: 前端埋点管理系统
  → 埋点, 埋点标记, 报障

- mobile-rn: 得物&95分内嵌 RN 应用。后端对接：ms-sale(dingdan)
  → RN, 得物内嵌, 商品详情, 订单, 寄售, 回收

- mobile-black: 供应链终端 PDA 应用（Black App，Flutter），覆盖质检拍照、鉴定（含 P80 连接）、收发货、3C/IMEI 检验、WMS 库位操作、维修、瑕疵问询、OCR、抽检、打卡、小仓管理。后端对接：ms-black(lvyue)、ms-black-inspection(lvyue)、ms-black-identify(lvyue)、ms-bwms(lvyue)
  → PDA, 供应链终端, 质检拍照, 鉴定, 收发货, 3C检验, WMS, 维修, 瑕疵, OCR, 抽检

- mobile-ios: 95分 iOS 客户端
- mobile-android: 95分 Android 客户端


# ════════════════════════════════════════
# 跨域调用关系（从 Go import 代码验证）
# ════════════════════════════════════════

# 主链路（按业务流程）
下单：ms-trade(dingdan) → ms-goods(shangxiang) + ms-pay(huijin) + ms-discountcenter(huijin) + ms-rate(huijin)
发货：ms-sale(dingdan) → ms-black(lvyue) → ms-logistic-tracing(lvyue) + ms-freight(lvyue)
退货：ms-order-reverse(dingdan) → ms-black(lvyue) + ms-black-inspection(lvyue) + ms-pay(huijin)
质检：ms-black(lvyue) → ms-black-inspection(lvyue) + ms-black-identify(lvyue) + ms-bwms(lvyue)
回收：ms-recycle(shangxiang) → ms-black(lvyue) + ms-logistic-tracing(lvyue) + ms-pay(huijin)
商品详情：ms-goods-biz(shangxiang) → ms-goods(shangxiang) + ms-order(dingdan) + ms-rate(huijin) + ms-black(lvyue)
通知：ms-ripples(dingdan) → ms-notification(dingdan) ← 被 dingdan/lvyue/huijin 多域调用
基础设施：ms-atom(jijia) ← 被全部域 56 个项目 import

# 跨域依赖密度（从代码 import 统计）
dingdan ↔ shangxiang: 双向最密切（65+95 条 import）
dingdan ↔ huijin: 双向密切（50+77 条）
dingdan ↔ lvyue: 双向密切（50+64 条）
jijia: 被所有域单向依赖（ms-atom 56 次、ms-misc 28 次）
