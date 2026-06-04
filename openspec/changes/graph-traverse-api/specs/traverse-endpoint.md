# Spec: traverse 端点

## 接口

`POST /tool/traverse`

## 入参

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| name | string | 是* | — | 符号名（与 target_uid 二选一）|
| target_uid | string | 否 | — | 符号 UID（精确匹配，优先于 name）|
| repo | string | 是 | — | 仓库名 |
| direction | "downstream" \| "upstream" | 是 | — | 遍历方向 |
| maxDepth | number | 否 | 8 | 最大遍历深度（上限 32）|
| maxNodes | number | 否 | 200 | 最大返回节点数 |
| relationTypes | string[] | 否 | ["CALLS"] | 遍历的边类型 |
| includeTests | boolean | 否 | false | 是否包含测试文件 |
| markDao | boolean | 否 | true | 是否标记 DAO 层节点 |

## 返回

```json
{
  "root": {
    "id": "uid",
    "name": "Start",
    "type": "Function",
    "filePath": "job/service/handler.go",
    "isDao": false,
    "children": [
      {
        "id": "uid2",
        "name": "callbackPay",
        "type": "Function",
        "filePath": "job/service/handler.go",
        "isDao": false,
        "children": [
          {
            "id": "uid3",
            "name": "AddAccountPayMapping",
            "type": "Function",
            "filePath": "dao/db/jiuwu_account_pay_mapping.go",
            "isDao": true,
            "children": []
          }
        ]
      }
    ]
  },
  "stats": {
    "totalNodes": 74,
    "maxDepthReached": 6,
    "daoNodes": 12,
    "truncated": false
  }
}
```

## 实现

1. 复用 `resolveSymbolCandidates` 解析符号
2. 基于 `_runImpactBFS` 的 BFS 逻辑，但返回**树形结构**而非扁平列表：
   - BFS 遍历时记录每个节点的 parentId
   - 遍历结束后，按 parentId 重建树
3. DAO 标记规则：`filePath` 匹配 `/dao/`、`/repository/`、`/mapper/`、`/store/` 目录
4. 到达 DAO 节点后不再继续展开（剪枝），减少无效遍历
5. maxNodes 限制：BFS 过程中 visited.size > maxNodes 时停止，标记 truncated=true

## 边界情况

- 符号不存在 → `{"error": "Target 'xxx' not found"}`
- 符号有歧义 → 返回 candidates 列表，同 impact 端点
- 遍历结果为空（叶子节点无 callees）→ `{"root": {..., "children": []}, "stats": {"totalNodes": 1}}`
- maxNodes 超限 → 停止遍历，`stats.truncated = true`
