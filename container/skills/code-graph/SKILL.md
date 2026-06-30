---
name: code-graph
description: "代码逻辑查询工具。用户说'查 XX 代码逻辑'、'XX 的调用链'、'XX 怎么实现的'时触发。支持任意已索引 Git 项目；未索引项目必须先提示并确认后再建索引。基于 GitNexus 知识图谱，提供符号上下文（调用方/被调用方）、执行流搜索、影响分析。"
---

# Code Graph — 代码逻辑查询

用户问代码逻辑时用这个。支持任意已索引 Git 项目；未索引项目必须先向用户说明并确认，不能自动静默建索引。

## 环境配置

本机 `gitnexus` 命令优先加载 DashScope embedding 环境变量；如果 env 文件不存在，也要继续执行已索引仓库查询，不能因为缺 env 文件短路。

```bash
if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; gitnexus <command> ...
```

跨平台超时 helper（macOS 无 GNU `timeout` 时也能跑）。执行索引命令前，必须先在同一个 shell 中定义这个 helper：

```bash
with_gitnexus_timeout() {
  seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
    return $?
  fi
  "$@" &
  pid=$!
  ( sleep "$seconds"; kill -TERM "$pid" 2>/dev/null ) &
  watcher=$!
  wait "$pid"
  rc=$?
  kill "$watcher" 2>/dev/null
  return "$rc"
}
```

## 使用流程

### 第一步：确认索引是否存在

```bash
if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; gitnexus list 2>&1 | grep -i "<项目名>"
```

### 第二步：如果没有索引 → 先 fail-visible，再确认是否建索引

如果 `gitnexus list` 查不到目标仓库，必须先告诉用户：

> 仓库 `<项目名>` 尚未建立 GitNexus 索引。快速静态索引通常较快，但没有 embedding 语义搜索；完整语义索引会调用 embedding，可能耗时较久。是否现在执行？

必须先询问用户确认，不能自动运行 embedding 索引。用户确认后按场景执行：

快速静态索引（默认推荐，120 秒超时）：

```bash
cd <项目路径> && if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; with_gitnexus_timeout 120 gitnexus analyze . --name <项目名>
```

完整语义索引（用户明确确认后才跑，120 秒超时）：

```bash
cd <项目路径> && if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; with_gitnexus_timeout 120 gitnexus analyze . --name <项目名> --embeddings
```

如果超时，停止命令并把下面的手动续跑命令发给用户，不要把后续 `rg` / `git diff` 兜底说成 GitNexus 已成功：

```bash
cd <项目路径> && if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; gitnexus analyze . --name <项目名> --embeddings
```

例如：
```bash
cd /Users/dajay/AI_Workspace/nine && if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; with_gitnexus_timeout 120 gitnexus analyze . --name nine
cd /Users/dajay/AI_Workspace/nanoclaw && if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; with_gitnexus_timeout 120 gitnexus analyze . --name nanoclaw
```

索引完成后告知用户，然后继续查询。

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

# 更新已有索引
cd <项目路径> && git pull && if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; with_gitnexus_timeout 120 gitnexus analyze . --name <项目名> --embeddings --force
```
