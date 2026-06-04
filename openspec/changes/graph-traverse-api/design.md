# Design: eval-server 图遍历端点 + biz_code_locate 重构

## 实现顺序

1. eval-server: traverse 端点
2. eval-server: call_paths 端点
3. eval-server: callTool 路由注册
4. 部署 eval-server 到 DEV
5. biz_code_locate: 重构调用树构建
6. biz_code_locate: 重构输出格式
7. E2E 验证

## 1. eval-server traverse 端点

### 文件：`src/mcp/local/local-backend.ts`

新增 `traverse` 方法：

```typescript
private async traverse(
  repo: RepoHandle,
  params: {
    name?: string;
    target_uid?: string;
    repo?: string;
    direction: 'upstream' | 'downstream';
    maxDepth?: number;
    maxNodes?: number;
    relationTypes?: string[];
    includeTests?: boolean;
    markDao?: boolean;
  },
): Promise<any>
```

实现逻辑：
1. `resolveSymbolCandidates` 解析符号
2. BFS 遍历（复用 `_runImpactBFS` 的 Cypher 模式，但记录每个节点的 parentId）
3. 按 parentId 重建树形结构
4. 标记 DAO 节点（filePath 匹配规则）
5. DAO 节点不继续展开（剪枝）

核心差异 vs `_runImpactBFS`：
- **返回树形结构**（记录 parentId），不是扁平列表
- **DAO 剪枝**：碰到 DAO 节点停止展开该分支
- **maxNodes 限制**：全局节点数上限
- **注意**：因为用全局 visited set，返回的是"可达子图的生成树"，同一节点只出现一次。多路径场景由 call_paths 覆盖

DAO 路径匹配规则（**统一来源，Python 端只消费 isDao 字段**）：
```typescript
const DAO_PATH_PATTERNS = ['/dao/', '/repository/', '/mapper/', '/store/', '/globaldao/'];
function isDao(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return DAO_PATH_PATTERNS.some(p => lower.includes(p));
}
```

注意：不包含 `/model/`（太宽泛，Java 项目中 model 通常是 POJO/DTO）。

upstream 方向默认 maxNodes=50（入口查找场景不需要展开所有分支）。

### 文件：`src/cli/eval-server.ts`

在 `formatToolResult` 和 `getNextStepHint` 中添加 `case 'traverse'`。

traverse 的文本格式输出为缩进树：

```
[traverse]
root: Start → job/service/handler.go
  callbackPay → job/service/handler.go
    addPayBackRecord → job/service/handler.go
    [DAO] AddAccountPayMapping → dao/db/jiuwu_account_pay_mapping.go
  callbackRefund → job/service/handler.go
    [DAO] GetPayOrder → dao/db/jiuwu_pay_order.go

nodes: 74 | dao: 12 | depth: 6
[/traverse]
```

## 2. eval-server call_paths 端点

### 文件：`src/mcp/local/local-backend.ts`

新增 `callPaths` 方法。使用 **BFS + 路径级 visited**（不用 Cypher 变长路径，避免 Kuzu 兼容性风险）：

```typescript
interface PathState {
  currentId: string;
  path: Array<{id: string; name: string; filePath: string}>;
  visited: Set<string>;  // 路径级 visited（防环，但允许不同路径共享节点）
}
```

与 traverse 的关键区别：
- traverse 用全局 visited → 每个节点只出现一次 → 生成树
- call_paths 用路径级 visited → 同一节点可在不同路径中出现 → 完整路径枚举
- call_paths 收集到 maxPaths 条路径时 early termination，停止遍历

文本格式输出：
```
[call_paths]
from: addPayBackRecord → job/service/handler.go

paths:
  addPayBackRecord → callbackPay → AddAccountPayMapping [DAO]
  addPayBackRecord → callbackPay → GetPayOrder [DAO]
  callbackRefund → RefundBalance → RefundDeposit [DAO]

total: 6 paths | max_depth: 4
[/call_paths]
```

## 3. callTool 路由注册

### 文件：`src/mcp/local/local-backend.ts`

在 `callTool` 的 switch 语句中添加：
```typescript
case 'traverse':
  return this.traverse(repo, params);
case 'call_paths':
  return this.callPaths(repo, params);
```

## 4. biz_code_locate 重构

### `_build_call_tree` → 调 traverse 端点

```python
def _build_call_tree(symbol_name: str, repo: str, uid: str = "") -> list[str]:
    params = {"name": symbol_name, "direction": "downstream", "maxDepth": 10,
              "maxNodes": 200, "relationTypes": ["CALLS"], "markDao": True}
    if uid:
        params["target_uid"] = uid
    raw = _call_eval_server("traverse", params)
    if not raw or raw.startswith("[错误]") or "Not found" in raw:
        return []
    return raw.strip().split("\n")
```

### `_escalate_to_entry` → 调 traverse upstream

```python
def _escalate_to_entry(symbol_name: str, repo: str, uid: str = "") -> tuple:
    raw = _call_eval_server("traverse", {
        "name": symbol_name, "direction": "upstream",
        "maxDepth": 5, "maxNodes": 50, "relationTypes": ["CALLS"],
    })
    # 解析返回的树，根节点即为 entry
```

### `_format_search_result` 输出结构调整

**call_tree 提到最前面，搜索列表精简到后面：**

```python
def _format_search_result(data, query):
    lines = []
    # 1. call_tree 在最前面（最有价值的信息）
    chain_result = _auto_call_chain_for_top(top_symbol, top_repo)
    if chain_result:
        lines.append(chain_result)
        lines.append("\n---\n")
    # 2. 搜索列表在后面（精简格式，无代码片段）
    lines.append("[search_results]")
    for i, point in enumerate(results):
        lines.append(f"{i+1}. {symbol} | {type} | {lang} | {score:.3f} | {repo} | {path}:{start}-{end}")
    lines.append("[/search_results]")
    return "\n".join(lines)
```

### SKILL.md 检查

需要确认 `biz_code_locate/SKILL.md` 中的示例输出格式与新格式一致。重点：
- 路径 B 示例中 `🎯 DAO 标记` → 改为 `[DAO]` 标记
- 搜索结果示例更新

## 测试计划

### P0（必须通过）

| # | 测试场景 | 预期结果 | 验证方式 |
|---|---------|---------|---------|
| 1 | "支付回调写了哪些表" | call_tree 到达 DAO，≥6 个 DAO 文件，call_tree 在输出最前 | E2E debug API |
| 2 | "物流追踪状态更新的代码" | 返回搜索结果 + call_tree | E2E debug API |
| 3 | "用户下单到支付完成的完整链路" | 搜索结果 + call_tree | E2E debug API |
| 4 | "商品详情页的数据来源" | call_tree 包含 SpuDetail，到达 DAO | E2E debug API |
| 5 | "改了 createOrder 会影响什么" | impact 路径正常（不受本次改动影响） | E2E debug API |
| 6 | traverse 端点直接调用（addPayBackRecord downstream） | 返回树形结构 + DAO 标记 | curl eval-server |
| 7 | call_paths 端点直接调用（addPayBackRecord downstream stopAt=dao） | 返回路径列表 | curl eval-server |
| 8 | traverse upstream（addPayBackRecord upstream） | 找到 Start 作为入口 | curl eval-server |
| 9 | "优惠券核销流程" | 搜索 + call_tree（测试前端相关场景） | E2E debug API |
| 10 | "退款流程写了哪些表" | call_tree 到达 DAO | E2E debug API |

### P1（应该通过）

| # | 测试场景 | 预期结果 |
|---|---------|---------|
| 11 | 符号不存在 | 友好错误信息 |
| 12 | 符号有歧义 | 返回 candidates 列表 |
| 13 | maxNodes 超限 | truncated=true，部分结果 |
| 14 | 无 DAO 到达 | status: no_dao |

### P2（最好通过）

| # | 测试场景 | 预期结果 |
|---|---------|---------|
| 16 | 性能对比 | traverse 端点 vs 递归，响应时间对比（预期快 3-5x）|
| 17 | 飞书卡片展示 | call_tree 在 1000 字符截断内完整可读 |
| 18 | 多仓库同名符号 | 不跨仓库混淆 |
