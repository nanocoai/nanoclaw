---
name: code-graph
description: "代码逻辑查询工具。用户说'查 XX 代码逻辑'、'XX 的调用链'、'XX 怎么实现的'时触发。支持任意 Git 项目，首次查询自动建索引。基于 GitNexus 知识图谱，提供符号上下文（调用方/被调用方）、执行流搜索、影响分析。"
---

# Code Graph — 代码逻辑查询

用户问代码逻辑时用这个。支持任意 Git 项目，首次使用时自动建索引。

## 环境配置

**所有本机 gitnexus 命令必须先加载 DashScope embedding 环境变量：**

```bash
source ~/.gitnexus/env && gitnexus <command> ...
```

或者用内联方式：
```bash
$(cat ~/.gitnexus/env | sed 's/export //g' | tr '\n' ' ') gitnexus <command> ...
```

## 使用流程

### 第一步：确认索引是否存在

```bash
source ~/.gitnexus/env && gitnexus list 2>&1 | grep -i "<项目名>"
```

### 第二步：如果没有索引 → 在项目目录下建索引

```bash
cd <项目路径> && source ~/.gitnexus/env && gitnexus analyze . --name <项目名> --embeddings
```

例如：
```bash
cd /Users/dajay/AI_Workspace/nine && source ~/.gitnexus/env && gitnexus analyze . --name nine --embeddings
cd /Users/dajay/AI_Workspace/nanoclaw && source ~/.gitnexus/env && gitnexus analyze . --name nanoclaw --embeddings
```

索引完成后告知用户，然后继续查询。

### 第三步：查询

本机项目直接用 gitnexus CLI：
```bash
source ~/.gitnexus/env && gitnexus <command> [options] -r <项目名>
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
cd <项目路径> && git pull && gitnexus analyze . --name <项目名> --embeddings --force
```
