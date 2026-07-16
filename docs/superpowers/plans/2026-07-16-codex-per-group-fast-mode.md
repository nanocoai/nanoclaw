# Codex 群级快速模式实现计划

> **For Codex:** REQUIRED SUB-SKILL: Use test-driven-development to implement this plan task-by-task.

**Goal:** 允许每个 NanoClaw 群在现有 `settings.json` 的 `codex` 命名空间中独立选择标准或快速服务档位。

**Architecture:** 配置读取层只接受 `standard`/`fast` 两个值；Codex Runner 在 `fast` 时向每次 `codex exec` 注入 `service_tier="fast"` 与 `features.fast_mode=true`，未配置或 `standard` 保持原行为。

**Tech Stack:** TypeScript、Vitest、Codex CLI

---

### Task 1: 配置解析

**Files:**
- Modify: `src/model-settings.test.ts`
- Modify: `container/agent-runner/src/model-settings.ts`

1. 先补 `fast`、`standard`、非法值三类失败测试。
2. 运行 `npm test -- src/model-settings.test.ts` 确认 RED。
3. 新增 `CodexServiceTier` 类型与白名单解析。
4. 重跑测试确认 GREEN。

### Task 2: CLI 参数映射

**Files:**
- Modify: `container/agent-runner/src/codex-runner.test.ts`
- Modify: `container/agent-runner/src/codex-runner.ts`
- Modify: `container/agent-runner/src/index.ts`

1. 先补 fast 注入、standard/缺省不注入的失败测试。
2. 运行定向测试确认 RED。
3. 将 service tier 从群配置传入 Runner，并仅在 fast 时追加两个 `-c` 参数。
4. 重跑定向测试确认 GREEN。

### Task 3: 文档与验证

**Files:**
- Modify: `README.md`

1. 记录群级配置示例、取值和生效时机。
2. 运行定向测试、全量测试、`npm run build`、`git diff --check`。
3. 人工复核 diff，提交并创建目标为 `main` 的 PR。
