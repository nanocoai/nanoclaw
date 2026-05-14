---
name: ship
description: 一键全流程交付。从 OpenSpec 到代码实现到 E2E 验证，零人工干预。触发词：ship、跑全流程、一键交付、一发入魂。
---

# Ship — 一键全流程交付

从需求到交付，一条命令搞定。内部串联 kickoff → implement → e2e-testing 三个 skill 的核心步骤，**跳过所有"等用户确认"节点**。

## 核心原则

```
不停顿，不请示，不汇报中间状态。
中间有评审（子 agent）替你把关，最终只汇报结果。
```

## 什么时候用

- 需求已经聊清楚了（对话中有明确的功能描述）
- 改动是**构建功能**类型（新功能 / 改造 / 重构）
- 对 agent 的自主判断有信心

## 什么时候不用

- 定位问题 / debug → 用 kickoff（轨道 A）
- 需求模糊，方向都没定 → 先聊清楚再 ship
- 高风险改动（涉及数据迁移、生产环境、安全相关）→ 分步走，每步确认

---

## 日志纪律

全流程每个阶段转换点**必须输出结构化日志**：

```
📋 [阶段名] 状态=✅/❌
  - 产出: xxx
  - 耗时: N 分钟
  - 备注: xxx
```

---

## Phase 1: 启动 — 来自 kickoff

### 1.1 前置检查（kickoff Step 0）

检查上个任务是否收尾：
- 群名有 `(完成)` → 跳过
- 没有 → 判断是否值得收尾（有 commit/PR → 执行 wrapup；无实质产出 → 跳过并记日志）

### 1.2 提取需求 & 改群名（kickoff Step 1）

1. 从对话上下文提取需求，总结为 10-20 字任务名
2. 调用 `rename_chat` 改群名
3. 确认目标项目（NanoClaw / Nine / 其他）

### 1.3 开 Worktree（kickoff B1）

1. 检查是否已在 worktree → 是则跳过
2. 否则 `EnterWorktree`，分支名 `feat/<name>` 或 `fix/<name>`

### 1.4 写 OpenSpec（kickoff B2）

按 OpenSpec 标准流程：
1. `openspec new change <name>` — 已存在则跳过
2. `openspec instructions --change <name> proposal` → 写 proposal.md
3. `openspec instructions --change <name> specs` → 写 specs/
4. `openspec instructions --change <name> design` → 写 design.md（**含测试计划**）

**幂等**：每步先检查文件是否已存在，已有的跳过。

### 1.5 评审 OpenSpec（kickoff B3-B4）

spawn 子 agent 评审 proposal + specs + design：
- 完整性、可行性、风险点、简洁性、可测试性
- 收到反馈后自行判断：合理的改，不合理的忽略
- **不停顿，不等确认，直接进入下一阶段**

```
📋 [OpenSpec] 状态=✅
  - change: {name}
  - proposal: ✅/⏭️
  - specs: ✅/⏭️
  - design: ✅/⏭️（含测试计划）
  - 评审: N 个问题, M 个已修, K 个忽略
```

---

## Phase 2: 实现 — 来自 implement

### 2.1 加载上下文（implement Step 0）

1. 读 design.md 作为实现蓝图
2. 拆出文件级改动清单
3. 确认验收标准

### 2.2 写代码（implement Step 1）

按实现清单逐项编码：
- 每完成一个模块确保编译通过
- 记录关键决策
- 日志能记尽记

**Gate**: 清单全完成 + 编译通过

### 2.3 写测试（implement Step 2）

- 单元测试覆盖核心逻辑
- P0（必须）+ P1（应该）+ P2（最好）
- 编译通过

**Gate**: P0 全覆盖 + 编译通过

### 2.4 审代码（implement Step 3 — 双轨）

**3a. Codex Review**：
```bash
cd <项目目录> && env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  node ~/.claude/plugins/cache/openai-codex/codex/1.0.4/plugins/codex/scripts/codex-companion.mjs \
  review --json --base <base-branch>
```
超时 5 分钟则 cancel 重跑。

**3b. 子 Agent Review**：
补充 Codex 盲区（业务正确性、安全、架构）。

合并两轮结果：
- 🔴 必须修 → 改
- 🟡 建议修 → 判断后改或忽略
- 🟢 可选 → 记录不改

**Gate**: 所有 🔴 已修 + 编译通过

### 2.5 审测试（implement Step 4）

spawn 子 agent 审测试覆盖率和有效性：
- 🔴 必须补的场景 → 补写
- 修改有问题的现有测试

**Gate**: 遗漏已补 + 编译通过

### 2.6 跑测试（implement Step 5）

跑**全量测试**：
- 失败 → 修复 → 重跑 → 循环直到全绿
- 循环 3 次以上仍失败 → **停下来汇报**（这是唯一的停顿点）

**Gate**: 0 failures

```
📋 [实现] 状态=✅
  - 代码: {文件数}个文件, {行数}行改动
  - 测试: P0={n}, P1={m}, P2={k}
  - 代码审查: Codex {verdict}, 🔴{x}修 🟡{y}修/{z}忽略
  - 测试审查: 补了 {n} 个场景
  - 测试运行: {x} passed, 0 failed
```

---

## Phase 3: 提交

### 3.1 提交 & 创建 PR（implement Step 6）

1. git add + commit（遵循项目规范）
2. 创建 PR（标题简洁，body 含改动摘要 + 测试结果）
3. **不等确认，直接进入 E2E**

```
📋 [提交] 状态=✅
  - PR: {链接}
  - commit: {数量}
```

---

## Phase 4: E2E 验证 — 来自 e2e-testing

### 4.1 准备

1. 查 `wiki/e2e-test-catalog.md` 找已有用例
2. 没有 → 按改动设计用例（发出来但**不等确认**）
3. 确认测试环境（NanoClaw / Nine）
4. 清理旧任务
5. 确认部署就绪（build + 重启 / 等 CI 部署）

### 4.2 执行

- 逐条执行，每条检查结果 + 日志
- 失败当场定位修复（加载 systematic-debugging）
- 修复后重跑验证

### 4.3 沉淀用例

新设计的用例补充到 `wiki/e2e-test-catalog.md`。

```
📋 [E2E] 状态=✅
  - 用例: {n} 个
  - 通过: {n} 个
  - 失败修复: {m} 个
```

---

## Phase 5: 交付汇报

全流程完成后，**一次性**汇报：

```
## 🚀 Ship 完成

**任务**: {一句话描述}
**PR**: {链接}

**OpenSpec**:
  - {change name}: proposal + specs + design（含测试计划）
  - 评审: {n} 个问题已处理

**代码**:
  - 改了: {文件摘要, 3-5 条}
  - 审查: Codex {verdict} + Agent Review, 🔴{x}修 🟡{y}修
  - 测试: {x} passed, 0 failed

**E2E**:
  - {n}/{n} 通过
  - 环境: {NanoClaw / Nine DEV}

**等你确认**: 说"合"我就 merge。
```

---

## 停顿规则

全流程**只有两个允许停顿的点**：

| 停顿条件 | 原因 | 恢复方式 |
|----------|------|---------|
| 测试循环 3 次仍失败 | 可能是架构问题，不是代码问题 | 用户判断后继续或放弃 |
| E2E 发现不可自修的问题 | 需求理解偏差或环境问题 | 用户确认方向后继续 |

其他情况**一律不停**：
- OpenSpec 评审有分歧 → 自行判断
- 代码审查有 🟡 → 自行决定修不修
- E2E 失败 → 自行修复重跑

---

## 异常处理

| 场景 | 处理 |
|------|------|
| 需求不是"构建功能"类型 | 切到 kickoff 轨道 A（定位问题），不走 ship |
| OpenSpec 已存在且完整 | 跳过 Phase 1.4，直接实现 |
| Worktree 已存在 | 跳过开 worktree |
| Codex Review 超时/不可用 | 只走子 agent review，记日志 |
| E2E 环境不可用 | 记录原因，跳过 E2E，在汇报中标注 ⚠️ |

---

## 相关 Skill

- **kickoff** — Phase 1 的底层流程
- **implement** — Phase 2 的底层流程
- **e2e-testing** — Phase 4 的底层流程
- **wrapup** — ship 完成后用户可手动触发收尾
- **systematic-debugging** — E2E 失败时的定位流程

---
*创建: 2026-05-12*
