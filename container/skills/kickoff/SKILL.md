---
name: kickoff
description: 任务启动工作流。提取需求 → 分类（定位问题 / 构建功能）→ 走对应流程 → 汇报。触发词：kickoff、开始任务、启动任务、开搞写spec。
---

# 任务启动工作流

根据任务性质自动选择流程：**定位问题**走 debug 轨道，**构建功能**走 OpenSpec 轨道。

## 幂等原则

**每步先检测，已有的跳过。** 用户可能已经手动完成了部分步骤，不要重复执行。

## 日志纪律

**每个阶段转换点必须输出结构化日志**，方便未来定位问题。格式：

```
📋 [阶段名] 描述
  - 关键参数/输入
  - 操作结果/输出
  - 耗时（如适用）
```

必须记日志的节点：
- **任务分类结果**：判定走哪条轨道 + 依据
- **定位问题**：每个 Phase 的发现和结论
- **OpenSpec 各步**：new/proposal/specs/design 每步的执行结果（成功/跳过/失败）
- **评审结果**：发现多少问题、修了多少、忽略了多少
- **代码修改**：改了哪些文件、测试结果
- **异常/错误**：任何非预期情况立即记录，包含上下文

---

## Step 0: 前置检查 — 上个任务是否收尾

**kickoff 前必须检查上个任务的收尾状态。**

1. **检查群名**：当前群名是否有 `(完成)` 前缀
   - 有 `(完成)` → 已收尾，跳过，进入 Step 1
   - 没有 → 上个任务未收尾，继续判断

2. **判断是否值得收尾**：检查上个任务是否有实质产出
   - 有 commit / PR / wiki 更新 / 代码改动 → **值得收尾**
   - 只是简单问答 / 小调整 / 聊几句就换话题 → **不值得**

3. **执行分支**：
   - 值得收尾 → 执行 `wrapup` skill 的完整流程（改群名、复盘文档、wiki 存档），**完成后不停顿，直接进入 Step 1 启动新任务**
   - 不值得 → 发一条 `"⏭️ 上个任务「{群名}」跳过收尾：{原因，如"仅简单问答，无实质改动"}"` → 直接进入 Step 1

⚠️ **不等用户确认，自动判断自动执行，保持工作流连贯。**

---

## Step 1: 提取需求 & 改群名

1. 从当前对话上下文中提取用户讨论的需求
2. 总结为 10-20 字的任务名
3. 调用 `rename_chat` 将群名改为任务名
4. 确认目标项目（NanoClaw / Nine / 其他），确定项目路径

## Step 2: 任务分类

根据用户意图判断任务类型：

| 类型 | 信号词 | 走哪条轨道 | task_type |
|------|--------|------------|-----------|
| **定位问题** | "定位"、"排查"、"为什么"、"怎么回事"、"挂了"、"报错"、"不工作" | → **轨道 A** | `bug` / `research` |
| **构建功能** | "加一个"、"改成"、"重构"、"优化"、"新功能"、"写 spec" | → **轨道 B** | `feature` / `refactor` |

**拿不准时默认走轨道 A**（先定位再动手，比反过来安全）。

## Step 3: 建立任务账本

分类完成后，**立即创建一条任务账本**，让整个 kickoff 全程在账本上留痕，进度可在 3457 看板（`http://<局域网IP>:3457/board`）实时查看。

调用 `mcp__nanoclaw__task_create`：

- `title` = Step 1 总结出的任务名
- `project` = Step 1 确认的目标项目（`nine` / `nanoclaw` / 其他）
- `task_type` = Step 2 判定的类型
- `description` = 用户需求的一句话背景
- `status` 默认 `draft`，不用手动传

**记住返回的 `task_id`，后续每个阶段转换都要带上它推进状态。** 这条 task_id 贯穿整个 kickoff（以及后续 wrapup）。

> ⚠️ **幂等**：如果账本里已有本任务（同名 + 同项目，用 `task_list` 检查），复用已有 task_id，不要重复创建。

**📋 日志**：
```
📋 [建账本] task_id=tl_xxx
  - title / project / task_type
```

---

## 轨道 A：定位问题

适用于 bug 定位、异常排查、行为分析类任务。**核心纪律：只定位，不修改。**

### A1: 执行 systematic-debugging 流程

按 `container/skills/systematic-debugging/SKILL.md` 的四阶段流程执行：

1. **Phase 1 — 根因调查**：读错误信息、复现、查 recent changes、追数据流
2. **Phase 2 — 模式分析**：找可工作的参考、对比差异
3. **Phase 3 — 假设验证**：形成假说、最小化验证

**⛔ 到 Phase 3 结束后停下。禁止进入 Phase 4（实施修复）。**

**📋 日志**：每个 Phase 结束后记录：查了什么 → 发现了什么 → 结论是什么。例如：
```
📋 [Phase 1] 根因调查
  - 查了 Loki 日志 / Jaeger trace / git log
  - 发现：xxx 异常发生在 yyy 之后
  - 初步判断：zzz 导致
```

### A2: 汇报根因

向用户汇报，格式要求：

```
## 问题名

**症状**：一句话描述用户看到的现象

**根因**：用人话解释为什么会出问题（不要贴代码，讲逻辑）

**证据链**：
1. 观察到 X → 说明 Y
2. 追踪到 Z → 确认是 W 导致

**影响范围**：这个问题影响哪些功能/场景

**修复方向**：建议怎么修（简要方案，不写代码）

**下一步**：等你确认根因后开始修复
```

要求：
- **用人话讲**，假设读者不看代码也能理解
- 证据链要有逻辑链条，不是罗列现象
- 修复方向只给方向，不给实现细节
- 不超过 20 行

**🗂️ 账本**：把根因和修复方向写回账本（`task_update`：`description` 补根因结论，`desired_outcome` 写修复目标）。纯调查/答疑类任务（不打算改代码）到这里就停，账本保持 `draft`，不再往下推。

### A3: 等待确认

**必须等用户明确确认后才能开始修改代码。** 不要在汇报中顺手就改了。

用户确认后，**先开 worktree 再改代码**（轨道 B 的 B1 步骤），任何项目都一样，哪怕只改一行。然后视情况：
- 简单修复 → 在 worktree 里直接改（走 systematic-debugging Phase 4）
- 需要设计 → 转入轨道 B 写 OpenSpec

**🗂️ 账本**：用户确认开始修复后，账本要走完后续闸门才能进实现阶段——
1. `task_lock_effect`（修复后达到什么效果 + 验收标准）→ `effect_locked`
2. `task_define_e2e`（怎么验证这个 bug 真修好了）→ `e2e_defined`
3. `task_plan_tests`（要补哪些测试、改哪几个文件）→ `tests_planned`
4. `task_start_implementation` → `implementing`，然后才动代码
> 极简单的一行修复也至少走 `task_lock_effect` + `task_start_implementation`，别跳闸门。

> ⚠️ **唯一例外**：纯调查/答疑、或只改运行时数据（memory、wiki 这类非版本控制的文件）不需要 worktree。只要动到任何项目的版本控制源码，就必须先开 worktree。

**📋 日志**：修复后记录：
```
📋 [修复] 问题=xxx
  - 改了: file1.py (L100-120), file2.py (L50)
  - 测试: 单测 X 个通过 / E2E 验证通过
  - 验证方式: curl/Playwright/手动
```

---

## 轨道 B：构建功能

适用于新功能、改造、重构类任务。

### B1: 开 Worktree

1. **先检查**：如果当前已经在 worktree 中，跳过此步
2. 如果没有，使用 `EnterWorktree` 工具在目标项目中开一个隔离的 worktree
3. 分支名建议用 `feat/<change-name>` 或 `fix/<change-name>`

### B2: 写 OpenSpec

1. **先检查**：运行 `openspec list`，如果已存在相关 change，跳过创建，检查已有 artifact 完成度
2. 对于已有的 artifact（proposal.md / specs/ / design.md），文件已存在且非空则跳过
3. 只补写缺失的部分

按 OpenSpec 标准流程执行（先读 `container/skills/openspec/INSTRUCTIONS.md` 获取 CLI 用法）：

1. `openspec new change <name> --description "描述"`（如已存在则跳过）
2. `openspec instructions --change <name> proposal` → 写 proposal.md（如已存在则跳过）
3. `openspec instructions --change <name> specs` → 写 specs/（如已存在则跳过）
4. `openspec instructions --change <name> design` → 写 design.md（如已存在则跳过）
5. **design.md 末尾必须包含 `## 测试计划`**：测试分层（纯函数 vs mock）、优先级（P0/P1/P2）、预估用例数。详见 `container/skills/openspec/INSTRUCTIONS.md` 的"可测试性要求"章节

**不要在每个阶段停下来等确认，一路写完到 design（含测试计划）。**

**🗂️ 账本同步**：OpenSpec 写到哪一步，账本就推进到对应状态（带上 Step 3 拿到的 `task_id`）：

| OpenSpec 产出 | 账本工具 | 推进到 |
|---------------|----------|--------|
| proposal.md 写完（目标+验收清晰） | `task_lock_effect`（desired_outcome + acceptance_criteria 从 proposal 提取） | `effect_locked` |
| specs/ 写完（场景明确） | `task_define_e2e`（每个 spec 场景转成一条 E2E 用例） | `e2e_defined` |
| design.md 测试计划写完 | `task_plan_tests`（测试分层 + 改哪些文件转成 checklist） | `tests_planned` |

账本工具有闸门：必须按 `lock_effect → define_e2e → plan_tests` 顺序调，跳步会被拒。把 `spec_path` 用 `task_update` 关联上 change 目录方便溯源。

**📋 日志**：每步执行后记录结果：
```
📋 [OpenSpec] change=xxx
  - proposal.md: ✅ 新建 / ⏭️ 已存在跳过 → 账本 effect_locked
  - specs/: ✅ 新建 3 个 spec / ⏭️ 已存在跳过 → 账本 e2e_defined
  - design.md: ✅ 新建（含测试计划）/ ⏭️ 已存在跳过 → 账本 tests_planned
```

### B3: 子 Agent 评审

用 `Agent` 工具 spawn 一个评审 agent，prompt 要求：

- 角色：资深架构师，负责评审变更规范
- 输入：把 proposal.md、specs/、design.md 的内容喂给它
- 评审标准：
  - **完整性**：是否覆盖所有场景，有无遗漏的边界条件
  - **可行性**：技术方案是否可落地，有无明显的实现障碍
  - **风险点**：是否有安全、性能、兼容性方面的隐患
  - **简洁性**：是否过度设计，有无可以简化的部分
  - **可测试性**：关键逻辑是否可单元测试，有无纯函数可提取
- 输出：结构化的评审意见列表（问题 + 建议）

### B4: 修改

根据评审 agent 的反馈，修改 proposal / specs / design 中的问题。
只改有道理的建议，不合理的忽略（你来判断）。

**📋 日志**：
```
📋 [评审修改] change=xxx
  - 评审发现: N 个问题
  - 已修复: M 个（列出关键修改）
  - 已忽略: K 个（附理由）
```

### B5: 汇报

向用户汇报，格式要求：

```
## 任务名

**一句话总结**：这个变更要做什么

**关键决策**：
- 决策 1
- 决策 2

**评审结果**：X 个问题已修复，Y 个忽略（附理由）

**测试计划**：X 个 P0 测试 + Y 个 P1 测试（简要描述）

**下一步**：等你确认后开始写代码 + 单测
```

要求：
- 总分结构，从顶层开始讲
- 简洁，不讲实现细节
- 不超过 20 行

### B6: 进入实现（用户确认后）

用户确认方案后，调用 `task_start_implementation`（带 `task_id` + 一句 summary）→ 账本进 `implementing`，然后才开始写代码 + 单测。

实现完成、测试跑通后，调用 `task_record_verification`（带证据：命令输出 / 截图路径 / trace 链接）→ 账本进 `verifying`。**最终的 `task_mark_done` 留给 wrapup 收尾时调**（见 wrapup skill），别在这里直接标完成。

**📋 日志**：
```
📋 [实现] task_id=tl_xxx → implementing
  - 改了: file1.py / file2.ts
  - 测试: 单测 X 个通过 / E2E 验证通过 → verifying（已记证据）
```
