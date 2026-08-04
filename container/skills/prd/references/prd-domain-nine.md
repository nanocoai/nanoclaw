# nine 平台域 PRD 参考（prd-domain-nine）

> nine 平台域特有规则。通用写作规律见 prd-core.md,工序流程见 prd-pipeline.md。

## 域定位

- **适用**：**nine 平台自身**的需求 —— 基础架构 / 数据 agent / 招聘 / 产研工作流四类。（95分业务需求如订单/商详/汇金/履约/基架，用 `prd-domain-交易端.md` / `prd-domain-履约端.md`，不是本域。）
- **裁剪**：简单需求按体量裁剪，不必套满 10 章（lite 判定与骨架裁剪在 S1 完成，见 prd-pipeline.md）。
- **用法**：先按「类型提示」认领需求类型 → 写到 §7 时重点看对应组；§7 是**勾选自检**（涉及就勾+一句话+指向正文章节，不涉及标 `N/A`），不是另写一遍作文。

## 类型提示

认领你的需求类型 → §7 重点看这些组（S1 认领类型，S5/S7 只读对应子节）：

| 需求类型 | 典型改动（判断口径） | §7 重点看 |
|---|---|---|
| **基础架构** | 引擎（main_agent/nine_loop）、SSE/中断恢复、DB schema/迁移、权限/授权（grantable/角色）、Go 网关、部署/蓝绿、tool_registry/prefix cache | A1-A4、B1、B3 + **G**（DB/SSE/prefix/权限/部署/Go-telemetry）|
| **数据 agent** | BI/数据分析 agent、Cube/ODPS 取数、chief_architect、telemetry/context-xray | A1-A4、F1 + **G**（Cube dt / telemetry 真相源 / event-loop）|
| **招聘** | 招聘 lite / recruit skill·tool、nine-recruit-api、登录风控、职位发布/打招呼、跨仓身份 | B2、B3、C1、E1 + **G**（登录多态 / agent 编排 / 身份键 / event-loop）|
| **产研工作流** | 除上三者外全部：pm-lite/prd-review/testcase-gen、代码定位/代码工具、skill 框架、结构化产物生成 | A1、A2、D1、D2 + **G**（结构化产物格式 / skill 工具声明 / 权限）|

重点组 → 子节对应：A →「§7 勾选自检：A 组」，B/C →「§7 勾选自检：B-C 组」，D/E/F →「§7 勾选自检：D-F 组」，G →「§7 勾选自检：G 深水区」。

> 近乎所有 nine 需求都涉及、**建议一律作答**：A1（弱契约归一化）、A2（软提示≠硬熔断）、B1（改动波及面含 Go）、D1（诚实失败+真链路 E2E）、D2（守护测试正反成对）。其余带〔触发〕的组命中场景才答。

> **核心理念（贯穿全文）= 格式服从内容复杂度**：内容简单一句话，复杂到研发/评审会为它扯皮才上表/矩阵/图/伪代码。篇幅克制是优点。
> **三条铁律（AI 几乎不会做，判别力最强）**：诚实认盲区（§二、D1）/ 异常分支写全＝阈值 + 降级动作 + 日志三件套（§7-D、§6.3 异常行）/ 护栏负向指标（§二）。
> **nine 与 95分的区别**：nine 是内部平台 —— 不写用研/竞品/C端常规埋点；价值口径用**内部效率/质量**（不用 GMV/转化/留存 这类 C 端指标）；§7 技术约束是本域的新增核心（从 nine 过去 1Q **55% 补丁**逆向提炼、条条有 PR 证据的坑）。

## 域章节清单

nine PRD 十章结构：0. 文档元信息 → 一、背景与现状 → 二、目标与价值 → 三、需求概述 & 影响模块 → 四、名词与概念 → 五、范围 → 六、功能详细说明 + 数据流 → 七、技术约束 / 架构不变量（勾选自检）★ → 八、验收标准 & 可观测性 → 九、灰度 / 部署 / 回滚 → 十、风险 —— §7-§10 是 nine 特有章；埋点章无（内部平台不写 C 端常规埋点）。
本域 A 类（必写）＝元信息 / 一 / 二 / 三 / 五 / 六 / §7 / §8；四按正文有无专有概念取舍；§9/§10 命中才写（见「条件章节」）；裁剪骨架前先到「类型提示」认领需求类型。

> 上述章号均为**模板身份**；有章被省时，落稿编号按全文连排取实际序号（core 写作纪律「章节编号连排」条）。

**0. 文档元信息**

| 项 | 内容 |
|---|---|
| 需求标题 | |
| 作者 / 评审人 | |
| **需求类型** | 基础架构 / 数据 agent / 招聘 / 产研工作流（决定 §7 重点组，见「类型提示」）|
| 关联 | issue / 前序 PR / 相关 skill |

版本变更表:见 prd-pipeline.md「版本变更表协议」

## 章节实操：头部与一~五章

头部＝0. 文档元信息表（式样见「域章节清单」）+ 版本变更表 v1.0 行（按 prd-pipeline.md「版本变更表协议」）。五章写法独立成节，见下节「五章范围写法」。

**一、背景与现状**

- **问题现象**：内部同事/用户**实际看到什么**（如：某 agent 把字段填「待补」反复追问、飞书卡片黑屏 3 秒、部署后老实例卡死连环回滚、抽取任务静默失败零日志）。写现象、举真实 case（真实 task_id / trace_id / 群 id），不写「我觉得该优化」。
- **现状机制**：这条链路现在**怎么跑的**（穿哪个引擎 main_agent/nine_loop、哪些 skill/工具/节点、Go 还是 Python），为什么现状扛不住。
- nine 是内部平台，**不写用研/竞品**；要写就写「现有机制的具体不足」。

**二、目标与价值**

- **定性**：解决什么问题、让谁（PM/运营/研发/终端用户）的什么体验变好。
- **定量（内部口径）**：少几步操作 / 召回率↑ / 误报率↓ / token 或延迟↓ / 人工介入↓ / 失败率↓ —— 用**内部效率/质量口径**。**不用 GMV/转化/留存**这类 C 端指标（nine 是内部平台）。有数则用「现状 vs 目标」两栏对照（如：抽取失败率 41.9%→<5%）。
- **成功判据**：上线后用什么可测的数确认「成了」（接 §8 验收）。
- **护栏负向指标**：给正向目标时，同时写「不能被伤害」的负向指标（如"召回率↑但误报率不得↑""改造不得拉长现有链路延迟"）。只报正向 = AI 味。
- **价值可验算 + 认盲区**：定量价值写成能当场验算的推导（每个乘数点名来源，基线未知留区间、不编数）；相关性判断写明「相关≠因果」并给验证方案（与 D1 诚实失败一脉）。

**三、需求概述 & 影响模块**

- 一句话讲清做什么 + 涉及哪些模块/链路/引擎通道。
- **对照附录 A「高危模块清单」**：本需求是否触碰其中任何一个？命中的，必须在 §7 对应组**重点回答**（这些模块的坑占了全季度补丁的大头）。

**四、名词与概念**

列本需求涉及的 nine 专有概念，与代码实体命名对齐（别用 PRD 自创词替换代码里的词），不写通用技术词（"接口"/"数据库"）。常见：

| 名词 | 定义 |
|---|---|
| main_agent / nine_loop | 二选一的对话引擎内核（线上默认 NineLoop）|
| AgentGraph | LangGraph 子图流水线（被 main_agent 的 graph_bridge 拉起）|
| skill_runner | skill 内核（工具注册/内容注入/生命周期）|
| SSE seq | 事件序号（断点续传/去重/replay_end 水位线）|
| grantable | L0 授权层（代码默认 vs 管理员 toggle）|

## 五章范围写法

**五、范围**

**格式按改动形态选**（不强制某一种）：改动点清晰可逐条列 → **3 列表**（模块/改动点/负责人）；多来源/多场景 → **「内容/说明/示例」三列**；单点改动 → 一句话。

| 模块 | 改动点 | 负责人 |
|---|---|---|
| [业务域/引擎 · 模块] | [具体改动，改到功能级] | 后端 / 前端 / Go |
| 本期范围外 | [明确排除] | — |

- ✅「基架域 · SSE 续传 \| 新增 xxx 事件类型 + Go proxy 透传 \| 后端+Go」← 域名 + 改到功能级 + 负责人。
- ❌「优化 SSE \| 不确定」←「优化」太模糊、"不确定"空头。⚠️ 别用仓库名/服务名/枚举字面值（PM 看不懂）。
- **必含「本期不做」**（≥2 条，防范围蔓延）：明确排除的功能/场景/引擎通道/仓。
- **影响面**：改动波及哪些引擎通道 / skill / 角色 / 仓（nine ⇄ 前端 ⇄ nine-recruit-api ⇄ 飞书 ⇄ Go 网关）。

## 内容→结构决策表

6.3 功能主体的格式决策表（nine 适配，按内容类型选格式，别一套到底）：

| 要表达的内容 | 推荐格式 | 反面（AI 常犯）|
|---|---|---|
| agent/工具行为**规则枚举**、多场景准入 | 表：场景/条件/结果/**是否与现状不同** | 大段文字罗列规则 |
| **契约归一化 / 引擎路由 / 撮合判定**（算法性）| 结构化文字（小标题 + 多级 bullet）或伪代码（if/return），**规则后紧跟代入真实数字的算例** | 塞进表格挤成一团；只给公式不给算例，评审无法验算 |
| **状态竞态 / 时序准入**（SSE seq、interrupt-resume、任务态、工具态：某状态下能否触发某动作）| **互斥矩阵表**（状态 × 事件 → 是否允许 + 说明）| 文字"如果…那么"，漏组合 |
| **异常 / 边界 / 失败降级** | 表：场景/触发条件/处理方式/**终态** | 只写主流程，异常散落 |
| **跨系统交互**（Go↔Python、跨引擎通道、nine⇄recruit-api、飞书）| **白板时序图**（正文配一句业务概括）| 大段文字；或只写"见画板" |
| 字段/枚举/工具名**变更清单** | 「(新增)」前缀原地标 或 波及面表（接 §7-B1，含 Go 侧）| 另起"变更前后对照表" |
| 复杂多字段、需逐条对照的默认主力 | **「内容/说明/示例」三列表**（单元格可嵌 bullet）| 拆 `####` + bullet，丢对照性 |
| 偏展示型 nine 需求（有前端页面）| 交易端「域/模块/功能/详细说明/交互图」5 列表 | — |
| 重复出现的口径/阈值/配置 | 单一真源（一处定义成表），其余位置按名引用，改一处全篇生效 | 多处逐字复制，改漏不同步 |
| 存量/历史数据处理 | 表：场景/处理方式/SOP | 一句"无历史数据影响"糊弄 |
| 灰度上线/回滚 | 表：阶段/范围/观测时长/通过条件 + 回滚触发（接 §9）| 只写"灰度上线" |
| 单点小改动 | 一句话 或 一行嵌进列表 | 为小改动画流程图 + 建表 |

> **判断口诀**：这块内容"研发/评审会不会为它扯皮"？会 → 上结构（表/矩阵/图/伪代码）把边界钉死；不会 → 一句话平铺。

**每条功能说明的质量标准（不论用哪种格式）**：
- **触发条件 + 处理逻辑 + 返回结果 三段齐全**；
- 边界/异常在同处描述（"调用 X 失败时降级展示 Y"），不另起；
- 涉状态机：列**全部合法状态 + 流转条件**（含**禁止流转**，如"已 replay_end 后不再补发历史事件"），不能只写部分。
- ⚠️ 反例——别把多模块拆成 `####` + bullet（失去逐条对照性，PM 滚屏难比对）。

## 6.3 功能主体与质量标准

> 逐功能写清**触发条件 + 处理逻辑 + 返回结果**，异常/边界分支不是可选项、是核心。格式服从内容复杂度——每块内容先过上节「内容→结构决策表」选形态，别一套表格套到底；质量标准四条见上节尾部，逐行套用。

**6.4 历史 / 存量数据处理（D 类）**

涉存量数据影响时写（字段迁移 / 状态重算 / 兼容旧值，如 DB 里历史 `claude_loop` 值需映射到 `nine_loop`）。用表（场景/处理方式/SOP）写清一次性刷数方案 + 对账。涉存量却不写 = 隐患。

## 数据流图（必画，追到物理层）

`[数据源] → [传输层] → [消费端]`，每段标 `文件:函数`。凡跨 Go↔Python（控制面 HTTP / 数据面 Redis-SSE）、跨 nine⇄recruit-api、跨引擎通道的，**必须画出物理链路**，别停在内存层（历史教训：`bus.broadcast` 是死代码，画到它就错）。示例：
```
Python RedisEventStore.add_event() [sse_handler.py]
  → Redis: INCR seq + ZADD events:{task_id}
  → Go 订阅 Pub/Sub [server/api/internal/sse/proxy.go]
  → 按 seq 回放 + replay_end → text/event-stream → 前端
```

## §7 勾选自检

落进 PRD 的章标题＝「技术约束 / 架构不变量（勾选自检）★」（模板身份=技术约束章，章号按全文连排取实际序号，见 core 写作纪律「章节编号连排」条）。

> **这是勾选自检，不是另写一遍作文。** 每条：
> - ☐ **涉及** → 一句话说清本需求怎么处理它 + **指向正文章节**（`见 §6 / §8 / §9`，详细答案写在那些自然章节，这里只勾选 + 指路）。
> - ☐ **不涉及** → 标 `N/A + 一句为什么`。
>
> 带【必答】的近乎所有 nine 需求都涉及；带〔触发:X〕的**命中 X 场景才答**。每条尾部括号里的 `(现象 · PR#)` 是"这真出过事"的提醒，不是让你读的材料——它是从 nine 过去 1Q **55% 补丁**逆向提炼、条条有 PR 证据的坑。答不清楚 = 大概率重蹈覆辙。

### §7 勾选自检：A 组

**A. LLM / Agent 契约（几乎所有 nine 需求都涉及）**

- **A1【必答】弱契约归一化**：本链路把哪些 LLM/工具输出喂给下游？在**哪一层归一化**（过唯一权威 `extract_text_content`，禁散落 `.strip()/.loads()/[:N]`）？覆盖 `dict/list/str-JSON/非法JSON/None` 五路？工具函数是否接 `**kwargs` 兜底 `raw=`（生产路径绕过 args_schema）？失败是**显式 error 日志**还是静默降级？（见 §6 数据流）　*(content 是 Union、args 乱、非法 JSON 被兜底 `{raw:...}` 透传；dev 实测某抽取 41.9% 失败零日志 · #2367/#1663)*
- **A2【必答】软提示 ≠ 硬熔断**：逐条标注本功能每个行为约束由 **prompt（倾向引导）** 还是 **runtime guard（绝对红线）** 强制？涉及资源消耗/死循环/外部调用/权限的约束，是否有**代码熔断 + 次数上限**（不能只写进 prompt——LLM 会无视 WARNING）？（见 §6 / §7-A2）　*(架构师搜索螺旋 44 次 LLM/1.84M token、基建挂了空转、22 次警告仍重试 · #439)*
- **A3〔触发:调 LLM 时〕provider×协议路径矩阵**：走哪些 provider/协议路径（Anthropic / OpenAI-compat / thinking / streaming / prefix-cache）？各路径 `temperature/thinking/cache/finish` 怎么处理？「一轮完成」判定是否同时满足「文本完整 + tool_call 闭合 + finish 合法」？（见 §8 按路径验证）　*(temperature 阻塞 thinking 400、bind_tools streaming 丢文本、离线 70 次 PASS 生产 0% · #2501/#2007)*
- **A4〔触发:给 LLM 注入上下文时〕引擎通道 + ground-truth**：注入内容走哪条引擎通道（线上默认 **NineLoop** 非 MainAgent）？预加载常驻还是按 action 触发？截断上限按引擎路径分流？怎么用**运行时 ground-truth**（容器内 grep 标记串 / Loki 日志）验证模型**真看到**（注册≠执行、预览≠加载）？后续会被引用的关键信息（file_path/ID/SQL 结果）是否迁到**结构化持久字段**（别指望模型从 tool_result 文本复制，会被上下文治理裁掉）？（见 §6）　*(_pinned_content 黑洞、requires_phase 帧内注入首次盲调、截断在路由前 · #2813/#2014)*

### §7 勾选自检：B-C 组

**B. 改动波及面 / 跨栈同步**

- **B1【必答】改动波及面矩阵**：本需求改的每个 **字段 / 默认值 / 工具名 / 枚举值**，点名它的**全部表达点与消费者**清单 —— 必须覆盖 `server/api` 的 **Go 渲染/鉴权层**（只搜 `server/backend`+`skills` 会漏）、三张授权表、迁移、测试断言、SKILL 引导。`required→default` 是否同步把 Pydantic 字段翻 `Optional`（校验早于函数体，不翻则兜底全是死代码、合法请求被 422）？（见 §6 波及面表；跨 Go/Python **字段契约表**见 §7-G）　*(HC 审批卡露英文 key = 漏同步 notifier.go · #2255/#2810)*
- **B2〔触发:涉用户身份/跨服务/飞书时〕身份键**：这条链路用哪个身份键（Nine `users.id` UUID / 飞书 `open_id` 按应用隔离 / `union_id`）？由谁归一化、**写路径（acquire_session/profile）是否也归一**（不能只接读路径）？`user_id`（选 profile）与 `nickname`（仅展示）是否混用？飞书每个 API 用 **tenant 还是 user token**、要哪些 scope？（见 §6）　*(open_id vs UUID 分裂，同日横跳 #3119↔#3123)*
- **B3〔触发:改状态值/跨服务字段时〕状态枚举双端同步**：新增/改哪个状态值或字段？列**全部消费方**，给出沿 **NineLoop**（线上默认引擎）逐条核对「终态集合 / 成功集合 / legacy / 通知分支 / 契约白名单」的回归清单？成功/可恢复中断/失败三类终态是否收敛到单一常量？（见 §6 状态机）　*(改一条终态集合漏 N 个消费方 · #3498/#3455)*

**C. 副作用与幂等**

- **C1〔触发:有外部副作用时（发布/打招呼/推通知/写库/转发）〕幂等**：每个副作用点的**幂等键**是什么？超时/失败后**先用权威查询核验是否已成功**再决定重试（禁盲目重试）？跨重启去重是否**持久化 + 两阶段标记**（reserve→mark，非纯内存 Set）？多 worker/多机下会不会**重复或漏消费**——消费语义是广播还是单消费，key 是否需 hostname 隔离？（并发/event-loop I/O 见 §7-G）　*(Pub/Sub 广播致每条发 7 遍 · #858/#2880)*

### §7 勾选自检：D-F 组

**D. 失败处理与验收**

- **D1【必答】诚实失败 + trust-but-verify**：每条失败分支，用户/LLM 看到的是**诚实错误（`{ok:false, blocker}`）+ 可见兜底**，还是编造的假业务数据 / 黑屏？基础设施成功返回（HTTP 200 / exit 0 / 挂载成功）后，是否对**关键产物做后置校验**？状态机的拒绝/异常是否走 error 通道（禁靠 phase 值判「完成」）？（见 §8 真链路 E2E）　*(飞书卡片连 4 PR 自测绿真链路挂、假 fallback 编数据 · #2342)*
- **D2【必答】守护测试正反成对**：关键行为是否配**正向锚点（新机制在）+ 反向禁回退（旧坏词不在）**成对测试、覆盖全部出口/同步点？反断言是否锚**全文唯一标记 + 局部窗口**（非全文 `not in`，会被别处假满足）？删调用点用 `monkeypatch raise`（非「断言副作用没发生」）？找裸 token 用**边界正则 + 零命中**（禁 `grep -v` 超集名整行误滤）？（见 §8-守护测试）　*(只反断言=没功能也不失败的假守护；主证据 wiki nine-guard-test-discipline · #2819/#3362/#2651/#2842/#3372)*
- **D3〔触发:改动触达 Go/YAML/shell/跨仓时〕多层脑测**：改动在**每层解释器**（Python 作用域 / Edit 工具 / YAML / shell / Go 工具链）下行为脑测过吗？import 放顶部 + 变量带默认（防 if 块内 import 的 `UnboundLocalError`）？YAML scalar 含 `#` 引号包裹？跨仓库链路先做**存在性检查**（能 grep 到才算真链路）？refactor 是否跑了 E2E（CI 绿 ≠ 行为对）？（见 §6/§8）　*(if 块内 import 相隔 40 天同根复踩、zsh 分词编译失败 · #908/#471)*

**E. 集成契约**

- **E1〔触发:调飞书 Block/OpenAPI 时〕**：调哪些飞书 API？错误码泛（`1770001/11310/429/300309`，`code=0` 是**假成功**客户端不重渲染）如何处理？文档表格**列数≤3 或列宽和≤1024**、图片走**建空块→上传→PATCH replace 三阶段**、cell/批次失败是降级还是整体失败（禁静默丢）？动态刷新用 **CardKit 实体卡**（非 IM 内联卡 PATCH）？会话定位严格按 `(open_id, chat_id)`（禁空 chat_id fallback）？验收是否**新会话 E2E 盯日志核 errcode**（mock 覆盖不到）？（见 §8）　*(列宽超限/图片单阶段/cell 静默丢/黑屏 · #577/#2680/#2086/#2856)*

**F. 时间口径**

- **F1〔触发:涉及日期/时间时〕**：涉及哪些日期？基准是 **T / T-1 / T-2**？**自然日还是工作日**（是否跳法定节假日）？展示是否含完整日期？全链路是否 `Asia/Shanghai`、**禁用 `datetime.utcnow()`**？　*(#1990/#2648 · feedback_no_utcnow)*

### §7 勾选自检：G 深水区

**G. 深水区触发项（命中即答，指向章节）**

> 紧凑触发表。**命中触发就答**（权限/event-loop 等跨域坑，不因需求不属基础架构就免答）。每行：☐ 命中 → 一句话 + `见 §X`。

- **〔改 DB schema〕**：禁在启动同步路径（`run_migrations` / `Base.metadata.create_all`）跑任何 ALTER（全需 EXCLUSIVE MDL 锁，蓝绿并存必死锁）；DDL 下沉 DBA 离线 online DDL（INSTANT/INPLACE/LOCK=NONE）+ 代码 rolling fallback（列缺失 catch 省列重试）兜底；加字段既要迁移又要 fallback；配 CI grep 'ALTER TABLE' in run_migrations 防线。（见 §9）　*(启动 ALTER → MDL 死锁，22 天两次 P0 · #2764/#3593)*
- **〔涉 SSE / 流式 / 断点续传 / 中断恢复〕**：新增哪些 SSE 事件？seq 按 taskId 隔离（禁 globalLastSeq）、POST 必回 `last_seq`、判空用 `!=null` 非 truthy、`replay_end` 必发收尾、`_seq` 构造在 payload 之后不被旧值覆盖、单冒泡管道禁 `_emit_sse` 直推；跨 resume 状态从 Redis（ground truth）恢复、每个 interrupt 做认领戳校验防零 UUID 全局泄漏、跨层 TTL 对齐；新增事件只改 Python `sse_handler` yield + 前端 switch，Go 层纯透传。（见 §6/附录 A）　*(改一处漏一端 · #870/#834)*
- **〔运行时动态挂工具 / 改 system〕prefix cache**：位置敏感 prefix hash（非命名缓存），tools[]+system 任何变动整段 prefix 失效；禁按用户消息 mid-session 动态挂工具（cache 杀手），改 session 级/角色级；subtask 路径显式启用 nine_loop cache_marker。（见 §7-A4）　*(fs.* 22→25 击穿 prefix cache · #2374)*
- **〔涉权限 / 角色 / 工具授权·任意域〕**：grantable 层「代码原生默认」与「管理员可覆盖」拆**两列**（`meta_default` vs `user_grantable`），启动同步只写默认列、用 `ON DUPLICATE KEY UPDATE` 非 `INSERT IGNORE`；三态语义写死全库一致（`None`=不过滤放行 ≠ 空集=全拒，异常 fail-fast 禁返空集）；**展示读**（合并两源）与**运行时读**（DB-only fail-close）严格分离；角色 key 有格式契约（`^[a-z][a-z0-9_]{0,48}$`）三层一致、key 与展示名分离；seed 只补缺失、绝不覆盖管理员运行时删除（initialized flag 守护）。（见 §9）　*(None 误当空集全拒/授权跷跷板/INSERT IGNORE 掉工具 · #3515/#2117/#3153)*
- **〔新增服务 / 端口 / 配置 / 蓝绿部署〕**：蓝绿假设新旧实例并存 + 历史残留物 —— backend 禁暴露宿主机端口（两组不能同绑 8001）、跨容器走 nginx 按容器名路由消灭直连 `host:8001`、残留 DNAT/容器用**孤儿检测**（扫全表→目标 IP 是否属活容器）清理非按已知 IP、常驻服务加 `restart: unless-stopped` 自愈；docker compose `environment:` 无默认值 `${VAR}` 缺键展开成空串且优先级高于 env_file（**静默清空凭证 P1**）、禁给 env_file 已有真值兜底；外部 host/密钥/回调按环境注入、默认「直接 up 能跑」；ccvm skill 参考走**物化路径**非卷挂载 + 消费方与参考绑同角色 + 上线需部署才可见。（见 §9）　*(孤儿 DNAT 劫持流量 / 空插值清空凭证 P1 / ext4 挂载不可靠 · #3544/#2748/#3898)*
- **〔后台任务 / 周期扫库 / async serve 链路 / 跨服务 timeout〕event loop**：`async def`/`await`/`create_task` 都不代表已让出 event loop；面向 HTTP 的 serve 进程严禁承载周期性大扫库/长任务（回捞/批量/巡检走独立 worker 或 `to_thread` offload）；新增 `storage.*` 进 async 链路标注同步 vs async I/O；跨服务 timeout 按完整业务链路预算、用常量表达禁散落 magic number。（见 §6/§8）　*(async 里跑同步 pymysql 卡死全站 p95 · #649/#671/#2568/#3888)*
- **〔数据跨 Python↔Go 或跨表流动〕双栈字段契约**：给**两侧对齐契约表**（Go struct + Python ORM / Redis key 格式 / 字段名 / 类型 / 鉴权取值方式），跨语言消费同表禁各自硬编码表名；Go→Python 的 UserContext 只传 `user_id` 由 Python 自查，禁透传 role/tool_permissions 死字段；同一份合并逻辑收口**单一函数**。（见 §6）　*(char(36)≠int、Redis key 一端带 modelID 段一端不带 · #1596/#2467/#3093)*
- **〔走 Cube / ODPS 取数〕**：该模型 `dt` 是 string(yyyyMMdd) 还是 time？分区键是什么、是否按分区剪裁？快照日期（_ds/_df）与业务日期如何区分？商分只声明 type、不在业务/prompt 层硬编码日期格式。　*(dt string→filters 自动转换、分区误报 · #2406/#2718)*
- **〔可观测 / telemetry〕**：唯一计量真相源是什么（Token 一律以真实发 API 的 `api_total = input + cache_read + cache_creation` 为准）？所有视图从同一基数拆分（消除"消息 10.9K < 缓存 40.1K"矛盾）？埋点起点覆盖全生命周期（会话注册即初始化 JSONL）？新老结构显式降级兼容？（见 §8）　*(数字对不上/空壳误判 · #2166/#3442)*
- **〔LLM 产结构化产物（报告/表/PRD/测试用例/评审）〕**：定义**正向唯一合法格式**（非罗列禁止形式——枚举禁止=教 LLM 找第 8 种绕过）；生成后**回读自检 + 单次重试 + 失败 handoff 人工**；分步落档（create 头 + append 追加）时两步 `--doc-format` 必须一致、含富文本样式须 xml，防飞书截断；评判标准从**权威原文蒸馏**而非二手摘要。　*(丢豁免口/抄错一票否决 · #3844/#3580)*
- **〔声明 / 动态挂 skill 工具〕**：钉死**单一权威工具声明源**（manifest tools 富条目 → names/display/action_map 三视图），声明工具名与注册工厂 key 一一对齐（`tool.name` 是函数名非 dotted）；`@触发 / load_skill / docker restore` 三入口走同一 `_register_skill_tools` + 每轮刷新 schema + 幂等去重；能力变更改唯一数据源 `platform_presets.py` 再跑 seed（禁只改 DB，会被 `_clean_stale_tools` 清掉）。　*(manifest key≠工厂 key 工具消失、tools_count 9→22 · #1988/#1429)*
- **〔招聘·登录 / 风控〕**：登录态是**多态**（need_login 可恢复 / need_verify 风控 / logged_in_unbound / normal）不是布尔；判定 **fail-closed + 以接口返回为 ground-truth**（如 jobmanage.list），DOM 启发式只回落（"无负信号 ≠ 已登录"须正向确认）；发绑定卡前**幂等预创建用户记录**（回调依赖 `users.feishu_open_id` 存在）。　*(fail-open 误判已登录/need_verify 死循环 · #363/#632)*
- **〔招聘·agent 编排〕**：派工前输入契约五要素（channel/job_id/职位/目标/策略）齐备、缺字段走结构化 `needs_input` 不反猜；四类 prompt（common framework / 路由 / employee / role overlay）按 `agent_key` 精准注入，业务路由禁进 common framework；子任务**无工具调用/副作用证据禁报 completed** 且不得被后续翻案；下架**三层同关**（skill 路由 + seed/registry + grantable/user_grants 迁移可回滚）。　*(能启动≠能上线、completed 翻案 · #3280/#3082)*

> **覆盖自证**：核心 13 组（A1-F1）+ 本 G 表 = nine 过去 1Q 挖掘的 31 条不变量全覆盖、每条仅一处。完整证据链见 `nine-lessons-to-prd-constraints.md`。

## 条件章节

nine 尾部三章：§8 验收（A 类必写）；§9 灰度/部署/回滚、§10 风险为条件章，命中才写、不硬凑。

**八、验收标准 & 可观测性**

- **真链路 E2E**（不是 mock、不是离线 SDK）：新会话 + 普通用户账号，**禁用 `SKILL_GRANT_ENFORCEMENT=false` 之类放行开关**制造假象（离线 70 次 PASS 生产 0% 的先例）。飞书类走新会话盯真实日志核 errcode（旧 session tool schema 已冻结，须 `new_session=true`）。
- **终态数据断言**（不是「流程跑通」）：status 值、是否**真 commit 落库**、msg_id 非空、产物真实生成 —— 逐条列可验断言。
- **验收按业务路径分组**（主链路 / 异常链路 / 存量 / 上线指标），每条可验证。
- **守护测试**：关键行为配正反成对测试（正向锚点 + 反向禁回退），见 §7-D2。
- **可观测接入**：新链路/服务是否接了 **GlitchTip**（异常）/ **Jaeger**（trace）/ **Loki**（日志，LOG_DIR + volume 三套环境 dev/tst/prod 同步）/ 关键指标？出问题怎么定位（trace_id → span → 日志）——见团队 `observability-debug` 5 步法。
- **telemetry 计量**：唯一计量真相源、所有视图同基数拆分、埋点覆盖全生命周期（见 §7-G）。

**九、灰度 / 部署 / 回滚**

- **DB 变更**：见 §7-G 的迁移约束（**禁进启动路径 ALTER**；离线 online DDL 或 rolling fallback；加字段既迁移又 fallback；配 CI grep 防线）。
- **蓝绿假设**（新旧实例并存 + 历史残留物）：backend 禁暴露宿主机端口（两组不能同绑 8001）、跨容器调用走 nginx 按容器名路由消灭直连 `host:8001` 硬编码；残留资源（DNAT/容器/网络）用**孤儿检测**（扫全表 → 目标 IP 是否属活容器）清理，非按已知 IP 匹配；常驻服务加 `restart: unless-stopped` 自愈。**配置**：docker compose `environment:` 无默认值 `${VAR}` 缺键展开成空串且优先级高于 env_file（静默清空凭证 P1）——禁用无默认 `${VAR}` 给 env_file 已有真值兜底；外部 host/密钥/回调按环境注入、默认值「直接 up 就能跑」。
- **ccvm skill 部署**（本需求若改 skill/参考）：参考/多文件内容走 **skill 物化路径** `/workspace/.claude/skills/<key>/references/`（每 VM 新起即有、可靠）而非卷挂载（受预烤 ext4 + overlay 不可控）；依赖 `CCSKILLS_MULTIFILE_ENABLED=true`，消费方与参考 skill 须绑同一 ccvm 角色，上线需部署才可见。
- **开关 / 灰度**：kill-switch 名称与语义写清（**名单=灰度 还是 名单=豁免**）；灰度范围、节奏、通过条件（用表：阶段/范围/观测时长/通过条件）+ 回滚触发列表；灰度期指标与全量目标**分开统计**。
- **回滚**：出问题怎么退，是否有脏数据风险（revert 仍可能脏数据的改动风险等级上调）。

**十、风险**

- 技术风险 / 数据风险 / 依赖风险，各配缓解措施。
- **命中附录 A 高危模块的部分，风险等级上调**并在 §7 对应组正面回答。
- 跨方协作缺口显式标 `⚠️ 待与 X 对齐 · Owner · 预期时间`，不假装谈妥。

## 附录 A：高危模块清单

> 命中即在 §7 重点回答对应约束。过去一季度补丁扎堆处：你的改动若触碰其一，几乎必然踩对应的坑，PRD 要正面回答。完整 15 模块 + 31 不变量 + 证据链见 `nine-lessons-to-prd-constraints.md`。

| 模块 | 反复踩的坑（一句） | 对应 §7 |
|---|---|---|
| `main.py::run_migrations` / `Base.metadata.create_all` | 启动同步路径跑 ALTER → 蓝绿 MDL 死锁（22 天两次 P0）；漏迁移又静默丢数据 | §7-G · DB schema |
| `nine_loop/api_client` + `main_agent/tool_registry` | LLM 弱契约震中：`{raw:}` 兜底透传绕 args_schema、mid-session 挂工具击穿 prefix cache | A1/A2/A3 · §7-G prefix |
| `sse_handler.py` + Go `sse/proxy.go` + `graph_orchestrator`（interrupt/resume）| seq 续传/去重/replay_end + 跨轮中断状态丢失，改一处漏一端 | §7-G · SSE |
| `llm_output_parser.py::extract_text_content` | 唯一权威归一化 helper；任何新链路直接 `.strip()/.loads()` 没过它就复发崩溃 | A1 |
| `recruit/client.py` + recruit-api `nine_identity.py` | 身份键 open_id/UUID 分裂、状态枚举跨仓、归一化只接读路径 | B2/B3 · §7-G 招聘 |
| `skill_runner.py`（200KB）| `_pinned_content` 黑洞、requires_phase 首次盲调、截断在路由前、ContextVar 丢 user_id 绕鉴权 | A4 · §7-G skill 工具 |
| `feishu/streaming_card` + `docx_tools` + `markdown_parser` | Block API 严契约、`code=0` 假成功、列宽/图片/CardKit、黑屏 | E1 |
| `grantable_service.py` + Go `user_grant.go` | 授权跷跷板、代码默认 vs 管理员 toggle 混列、三态 fail-open/closed、Go↔Python 表不对齐 | B1 · §7-G 权限/双栈 |
| `chief_architect.py` | 开放式「用工具确认 X」无上限 → 搜索螺旋；if 块内 import UnboundLocalError | A2/D3 |
| `platform_presets.py` → seed → `tool_assembler.py` | 工具能力单一源：只改 DB 被 seed 清、manifest key≠工厂 key、RBAC 关闭 None 当空集全拒 | §7-G skill 工具/权限 |
| `deploy.sh` + `docker-compose.*` + nginx | 蓝绿残留 DNAT 劫持流量、`environment:` 空插值静默清空凭证 P1 | §7-G 部署 · §9 |
| recruit-api `storage.py` / `cdp_base.py` / `workflow/engine.py` | async 里跑同步 pymysql 卡死 event loop、登录 fail-open、submit_event 幂等五闸 | §7-G event-loop · C1 · 招聘 |
