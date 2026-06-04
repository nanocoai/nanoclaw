# Proposal: eval-server 图遍历端点 + biz_code_locate 重构

## 问题

biz_code_locate 的调用树构建（`_build_call_tree`）通过逐层调用 eval-server 的 `context` API 实现 BFS，每深入一层就多一次 HTTP 请求。这导致：

1. **性能差**：构建 74 节点的调用树需要 ~10 次 HTTP 往返（每层一次），耗时 ~8s
2. **深度受限**：`_CALL_TREE_MAX_DEPTH=4`，超过就截断，可能漏掉关键 DAO 路径
3. **图能力浪费**：eval-server 底层用 LadybugDB（Kuzu 衍生，支持 Cypher），`_runImpactBFS` 已实现完整的图 BFS 遍历（单次查询拿一层所有节点），但只用于 impact 分析，未暴露给调用树场景
4. **入口上溯低效**：`_escalate_to_entry` 也是逐层查 callers，同样多次往返

## 方案

### 1. eval-server 新增 2 个端点

**`POST /tool/traverse`** — 从指定符号出发，沿调用链遍历，返回完整子图

```json
{
  "name": "addPayBackRecord",
  "repo": "server-ms-pay",
  "direction": "downstream",
  "maxDepth": 10,
  "relationTypes": ["CALLS"],
  "includeTests": false
}
```

返回结构化的层级树（不是 impact 的扁平列表），包含父子关系、DAO 标记。

**`POST /tool/call_paths`** — 从指定符号到满足条件的终点，返回所有简单路径

```json
{
  "name": "addPayBackRecord",
  "repo": "server-ms-pay",
  "direction": "downstream",
  "stopAt": "dao",
  "maxDepth": 10
}
```

基于 Kuzu 的 `allSimplePaths` / 递归 CTE，返回从起点到 DAO 层文件的精确调用路径。

### 2. biz_code_locate 重构

- `_build_call_tree` → 调 `traverse` 端点，一次请求拿完整树
- `_escalate_to_entry` → 调 `traverse` 端点 upstream 方向
- `_format_search_result` → call_tree 提到搜索列表前面，搜索列表精简（去掉代码片段）
- 新增 `dao_paths` 字段，展示搜索命中点到 DAO 的精确路径

### 3. 输出格式调整

```
[call_tree]
entry: Start
traced_from: addPayBackRecord (graph traverse, depth=8)

tree:
  Start → job/service/handler.go
    callbackPay → job/service/handler.go
      addPayBackRecord → job/service/handler.go
      [DAO] AddAccountPayMapping → dao/db/...

dao_paths:
  addPayBackRecord → callbackPay → [DAO] AddAccountPayMapping

dao_summary: 6 个 DAO 文件
status: reached_dao | nodes: 74
[/call_tree]

[search_results]
1. addPayBackRecord | function | go | 0.681 | server-ms-pay | handler.go:163-181
2. Settle | function | go | 0.669 | server-ms-pay | wechat.go:32-81
...
[/search_results]
```

## 不做的事

- 不改 eval-server 现有端点（context/impact/query）的行为
- 不改向量搜索逻辑
- 不做跨仓库调用链（当前 eval-server 不支持）

## 风险

1. **图遍历爆炸**：某些函数（如 utils/logger）被大量调用，downstream 遍历可能产生数千节点。mitigation：traverse 端点复用 `_runImpactBFS` 的 visited set + depth limit + maxNodes 参数
2. **DAO 标记准确性**：需要可靠的规则判断哪些节点是 DAO 层。方案：按文件路径匹配（`/dao/`、`/repository/`、`/mapper/`）
3. **Kuzu 路径查询性能**：`allSimplePaths` 在大图上可能慢。mitigation：限制 maxDepth=10，只走 CALLS 边
