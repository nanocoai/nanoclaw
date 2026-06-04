# Spec: biz_code_locate 重构

## 改动范围

`/nine/server/backend/app/agents/tools/biz_code_locate.py`

## 改动点

### 1. `_build_call_tree` → 调 traverse 端点

**现在：**
```python
def _build_call_tree(symbol_name, repo, depth=0, uid=""):
    # 调 context API 拿 callees
    # 递归展开每个 callee
    # 每层一次 HTTP 请求
```

**改为：**
```python
def _build_call_tree(symbol_name, repo, uid=""):
    # 调 POST /tool/traverse，一次请求拿完整树
    # 将 JSON 树转为缩进文本格式
    # DAO 节点标记 [DAO]
```

### 2. `_escalate_to_entry` → 调 traverse upstream

**现在：** 逐层查 callers，最多 5 层

**改为：** 调 `traverse(direction=upstream, maxDepth=5)`，一次请求找到入口

### 3. `_auto_call_chain_for_top` → 组合 traverse + call_paths

**现在：** 先 build_call_tree(top)，没 DAO 则 escalate → rebuild

**改为：**
1. `traverse(name=top, direction=downstream)` 拿完整树
2. 如果没到 DAO → `traverse(name=top, direction=upstream, maxDepth=5)` 找入口
3. `traverse(name=entry, direction=downstream)` 从入口重建
4. `call_paths(name=top, direction=downstream, stopAt=dao)` 拿精确路径

### 4. `_format_search_result` → 重排输出结构

**现在：** 搜索列表（含代码片段）→ `---` → `[call_tree]`

**改为：** `[call_tree]`（含 dao_paths）→ `---` → `[search_results]`（精简一行一条，无代码片段）

### 5. `_format_call_tree_structured` → 新增 dao_paths

在 `[call_tree]` 标签内新增 `dao_paths:` 段，列出搜索命中点到每个 DAO 的调用路径。

### 6. 搜索列表结构化

**现在：**
```
1. **addPayBackRecord** (function, go) — 相关度 0.681
   仓库: server-ms-pay | 文件: handler.go:163-181
   ```go
   // 大段代码片段
   ```
```

**改为：**
```
[search_results]
1. addPayBackRecord | function | go | 0.681 | server-ms-pay | handler.go:163-181
2. Settle | function | go | 0.669 | server-ms-pay | wechat.go:32-81
...
[/search_results]
```

## 兼容性

- `_call_eval_server` 函数保留，新增 traverse/call_paths 的调用方式
- SKILL.md 的工作流描述不需要改（semantic_search 输出格式变了但含义一致）
- call_chain 工具和 impact 工具不受影响

