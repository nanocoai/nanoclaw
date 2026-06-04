# Spec: call_paths 端点

## 接口

`POST /tool/call_paths`

## 入参

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| name | string | 是* | — | 起点符号名（与 target_uid 二选一）|
| target_uid | string | 否 | — | 起点符号 UID |
| repo | string | 是 | — | 仓库名 |
| direction | "downstream" \| "upstream" | 是 | — | 搜索方向 |
| stopAt | "dao" \| string | 否 | "dao" | 终止条件（"dao" = 文件路径匹配 DAO 目录）|
| maxDepth | number | 否 | 10 | 最大路径长度 |
| maxPaths | number | 否 | 20 | 最大返回路径数 |

## 返回

```json
{
  "from": {
    "name": "addPayBackRecord",
    "filePath": "job/service/handler.go"
  },
  "paths": [
    {
      "steps": ["addPayBackRecord", "callbackPay", "AddAccountPayMapping"],
      "endNode": {
        "name": "AddAccountPayMapping",
        "filePath": "dao/db/jiuwu_account_pay_mapping.go",
        "isDao": true
      },
      "depth": 3
    },
    {
      "steps": ["addPayBackRecord", "callbackPay", "GetPayOrder"],
      "endNode": {
        "name": "GetPayOrder",
        "filePath": "dao/db/jiuwu_pay_order.go",
        "isDao": true
      },
      "depth": 3
    }
  ],
  "stats": {
    "totalPaths": 6,
    "maxDepthUsed": 4,
    "truncated": false
  }
}
```

## 实现

### BFS + 路径级 visited（path-level dedup）

与 traverse 的全局 visited set 不同，call_paths 使用 **path-level visited**：每条路径独立维护已访问节点集合，允许同一个节点出现在不同路径中（但不允许同一路径内出现环）。

```typescript
interface PathState {
  currentId: string;
  path: string[];      // 从起点到当前节点的完整路径
  visited: Set<string>; // 该路径已访问的节点（防止环）
}

// BFS queue 中存的是 PathState
// 碰到 DAO 节点时，输出该路径并停止该分支
// 收集到 maxPaths 条路径时 early termination，停止遍历
```

关键差异 vs traverse：
- traverse 用全局 visited → 每个节点只出现一次 → 生成树
- call_paths 用路径级 visited → 同一节点可在不同路径中出现 → 完整路径枚举

### 性能保护

- maxPaths 限制 + early termination：收集到足够路径后立即停止
- maxDepth 限制：防止超深遍历
- maxQueueSize=5000：BFS queue 超限时停止，防止稠密图组合爆炸
- 单条路径内 visited set：防止环路导致的死循环

## 边界情况

- 无路径到 DAO → `{"paths": [], "stats": {"totalPaths": 0}}`
- 路径超多（热点函数）→ maxPaths 限制 + truncated 标记 + early termination
- BFS queue 膨胀超 maxQueueSize → 停止遍历，truncated=true
