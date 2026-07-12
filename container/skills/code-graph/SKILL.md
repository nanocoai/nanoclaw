---
name: code-graph
description: "代码逻辑查询工具。用户说'查 XX 代码逻辑'、'XX 的调用链'、'XX 怎么实现的'时触发。复用共享主干索引，提供符号上下文、执行流搜索和影响分析；任务 worktree 不重建索引。"
---

# Code Graph — 代码逻辑查询

用户问代码逻辑时用这个。查询复用每个仓库的共享主干索引；任务 worktree 只提供当前 diff，禁止自行建立或刷新完整索引。

## 共享索引规则（最高优先级）

本机共享索引由独立守护进程维护，固定跟踪：

- `nanoclaw` → `origin/main`
- `nine` → `origin/dev`
- `nine-recruit-api` → `origin/dev`
- `sandbox-api` → `origin/main`

**禁止事项：**

- 禁止在 `.claude/worktrees/`、`*-worktrees/` 或其他任务 worktree 中运行 `gitnexus analyze`。
- 禁止因为 `Target not found`、`UNKNOWN` 或 stale warning 自动重建索引。
- 禁止把共享索引的 `detect-changes` 结果当成当前 worktree diff，除非工具明确绑定了当前 worktree。

worktree 新增符号尚未进入主干图谱时，直接用 `rg`、`git diff`、定向测试和人工调用链兜底。这是正常降级，不是索引故障。

## 环境配置

本机 `gitnexus` 命令优先加载 DashScope embedding 环境变量；如果 env 文件不存在，也要继续执行已索引仓库查询，不能因为缺 env 文件短路。

```bash
if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; gitnexus <command> ...
```

## 使用流程

### 第一步：确认索引是否存在

```bash
if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; gitnexus list 2>&1 | grep -i "<项目名>"
```

### 第二步：如果没有索引或索引不适用 → fail-visible 并降级

如果 `gitnexus list` 查不到目标仓库，或索引指向错误 checkout，必须告诉用户并使用源码证据继续：

> 仓库 `<项目名>` 当前没有可用的共享索引。本次改用 `rg`、`git diff`、定向测试和人工调用链，不会在任务 worktree 重建索引。

只有用户明确要求维护共享索引时，才允许操作 `$HOME/.gitnexus/shared-index/refresh.sh`；普通编码任务不得触发。

### 第三步：查询

本机项目直接用 gitnexus CLI：
```bash
if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; gitnexus <command> [options] -r <项目名>
```

Mothership 项目（在 Metal 容器中）：
```bash
ssh metal 'docker exec gitnexus-server gitnexus <command> [options] -r <repo_name>'
```

## 查询命令

### query — 语义搜索（最常用的入口）

不知道具体函数名时，用关键词搜索相关执行流程。

```bash
ssh metal 'docker exec gitnexus-server gitnexus query "订单创建流程" -r ms-order'
```

### context — 符号 360° 视图

查看某个函数的所有调用方（谁调了它）和被调用方（它调了谁）。

```bash
ssh metal 'docker exec gitnexus-server gitnexus context "InitSortedBestGoods" -r ms-goods-biz'
```

### impact — 影响分析

分析修改某个符号会影响哪些上游调用方。

```bash
ssh metal 'docker exec gitnexus-server gitnexus impact "GetSkuLevelPriceMap" -r ms-goods-biz'
```

### 跨仓查询

```bash
ssh metal 'docker exec gitnexus-server gitnexus group query mothership "order create flow"'
```

## 查询策略

### 标准流程：从问题到答案

1. 用 `query` 搜关键词 → 找到相关执行流和符号
2. 用 `context` 逐层追踪调用链 → 从 API 追到 DAO
3. 调用链断裂时 → grep 源码补充（`Gd.` / `globalDao.`）
4. 需要评估修改影响时 → 用 `impact`

### 已知限制

1. **每次只返回一跳** — 需手动逐层追踪
2. **Go DI/struct 链式调用** — 间接调用图中可能缺少边
3. **跨服务 HTTP/RPC 调用** — 需切换 `-r` 参数到目标服务继续追

## 辅助命令

```bash
# 查看所有已索引仓库（本机 + Metal）
gitnexus list
ssh metal 'docker exec gitnexus-server gitnexus list'

# 查看共享索引刷新日志（只读）
tail -100 "$HOME/.gitnexus/logs/shared-index.log"
```
