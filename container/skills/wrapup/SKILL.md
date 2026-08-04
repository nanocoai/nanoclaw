---
name: wrapup
description: 任务收尾工作流。回顾任务全过程，总结踩坑记录和未解决问题，形成文档存入 Wiki。触发词：wrapup、收尾、总结任务、任务总结、复盘。
---

# 任务收尾工作流

任务完成后的复盘与知识沉淀。

## 执行步骤

### Step 1: 改群名为完成状态

1. 获取当前群名（即最近一次 `rename_chat` 设置的名称）
2. 如果群名已有"(完成)"前缀则跳过
3. 否则调用 `rename_chat` 将群名改为 `(完成)任务名`

### Step 2: 回顾全过程

从对话历史和 todo 记录中提取：

- **做了什么**：任务的核心产出
- **关键决策**：过程中做了哪些重要选择，为什么这么选
- **踩坑记录**：遇到了什么问题，怎么解决的（或为什么没解决）
- **反复纠结的点**：哪些地方来回改了多次，最终结论是什么
- **未解决的问题**：遗留了什么，为什么没解决，后续建议

### Step 3: 形成文档

按以下模板生成复盘文档：

```markdown
# [任务名] 复盘

## 概述
一句话说明任务目标和结果。

## 关键决策
| 决策点 | 选择 | 理由 |
|--------|------|------|
| ... | ... | ... |

## 踩坑记录
### 坑 1: [标题]
- **现象**：...
- **根因**：...
- **解法**：...

### 坑 2: [标题]
...

## 未解决问题
### [问题标题]
- **现状**：...
- **为什么没解决**：...
- **后续建议**：...

## 沉淀建议
从本次经验中可以提炼的通用知识或规则，值得写入 Wiki 供后续任务参考。
```

### Step 4: 存入团队知识库（team_wiki）

**写入目标是团队库 `../../global/team_wiki/`，不是个人库 `wiki/`。** 这一点关键：线上飞书对话的向量化召回（`src/memory/inject.ts`）只读 `team_wiki/index.md` + `team_wiki/private/index.md`，写进个人 `wiki/` 的内容召回不到。

1. 使用 `/wiki` skill 的 ingest 流程将文档存入 **team_wiki**
2. **判断进共享层还是 private**（两步判断，按优先级执行）：
   - **Step A: 先判是否影响 Nine 用户体验**——直接或间接影响 Nine 平台功能的知识（包括底层组件如 GitNexus/eval-server/sandbox-api/agent-runner 等）→ **进共享层 `team_wiki/`**，不管内容是否含 open_id/chat_id/IP/端口/容器名/测试账号等开发常规信息（这些不算涉敏）
   - **Step B: 与 Nine 无关的纯个人知识** → `team_wiki/private/`（NanoClaw 自身机制研究 / Wall-E / Claude Code 研究等）
   - **唯一例外：含真实凭据（密码、API Key/Secret、证书私钥、OAuth token）的内容必须进 private**，不管项目归属
3. 分类标签：`复盘`、`[项目名]`、`[技术领域]`
4. 遵循"**综合进已有页的对应小节并回收旧态**"原则（详见 `team_wiki/CONTRIBUTING.md`）：新知识融进对应小节、更新顶部状态、回收被取代的旧描述、禁页内行号引用；不要无脑追加带日期的新章节或新建孤立碎片
5. 更新对应的 `index.md`（共享进 `team_wiki/index.md`，私有进 `team_wiki/private/index.md`，两本索引互不引用）
6. **三处验证落盘后 commit + push**（页 + index + log 用 `grep`/`wc` 确认真在，再推）：
   ```bash
   cd ../../global/team_wiki && git add <页+index> && git commit -m "docs(wiki): <一句话>" && env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy git push origin main
   ```
   `private/` 被 gitignore 隔离不进 push；push 报远端有新提交先 `git pull --ff-only` 再推。详见 `/wiki` skill INSTRUCTIONS「Git 同步」。

### Step 5: 归档 OpenSpec（如适用）

如果本次任务走了 OpenSpec 流程：
1. `openspec status --change <name>` 确认任务完成度
2. `openspec archive <change-name>` 归档

### Step 5.5: 收尾任务账本（如适用）

如果本次任务在 kickoff 时建了任务账本（task-ledger），收尾时要把它标记完成，让 3457 看板上的进度走到终态。

1. 找到本任务的 `task_id`（kickoff 过程中记下的；忘了就用 `task_list` 按项目+标题找）
2. `task_get` 确认当前状态：
   - 还没到 `verifying` → 说明验证没走完，**先补 `task_record_verification` 记录验证证据**（进 `verifying`），再往下
   - checklist 有未完成项 / 测试用例有 pending/failed/blocked → 用 `task_update_checklist` 补齐，否则 `task_mark_done` 会被闸门拒
3. 调用 `task_mark_done`（带 `task_id` + 完成说明）→ 账本进 `done`

> ⚠️ 纯调查/答疑类任务（账本停在 `draft`，没进实现）不用强行 mark_done，保持原状即可。

**📋 日志**：
```
📋 [账本收尾] task_id=tl_xxx → done
  - 验证证据已补 / checklist 已齐
```

### Step 6: 汇报前先过 Step 7/8

（编号保留兼容旧引用，实际执行顺序：先 Step 7、Step 8，最后 Step 9 汇报。）

### Step 7: 沉淀原子块

问一句：**这次做的事里，有没有输入输出清晰、下次可以独立复用的模块？**（脚本、查询套路、命令序列、文档模板……）

有就抽出来存 `../../global/agent-assets/atomics/`，一块一文件，写明：用途、输入、输出、验收标准、来源任务。

**复利三铁律**（不满足就不要写，写了也是垃圾）：
1. 压缩到通用层——记"这类问题怎么解"，不记"这次哪一步怎么写"
2. 成功经验记成**动作轨迹**（当时沿什么序列做成的），不写步骤模板
3. 必须指向行动——这条沉淀会改变下一次的做法吗？答不上来就删

配套：造了机制/脚本要当场跑一遍，不跑等于没造；泛化结论验证前只能叫假说。

### Step 8: 记 want-to-do

往 `../../global/agent-assets/want-to-do.md` 的"待办"追加本次任务留下的四类条目（没有就跳过，不硬凑）：
- **好奇的种子**：过程中冒出来但没时间验证的想法
- **新工具新方法**：看到但没用上的
- **系统摩擦**：哪里反复卡、反复绕（这是基建改进信号）
- **妥协性验收项**：勉强收了的，必须带触发条件（"什么时候回头看它"）

### Step 9: 汇报

向用户简要汇报：
- 复盘文档已生成并存入 Wiki
- 列出沉淀的关键知识点（不超过 3 条）
- 本次沉淀的原子块 / want-to-do 条目（没有就说没有）
- 列出遗留问题（如有）

## 注意事项

- 如果对话太长导致早期上下文被压缩，优先从 todo 记录和 git diff 中恢复信息
- 不要编造没发生过的问题，只记录真实遇到的
- 未解决的问题要诚实说明原因，不要硬编一个"解决方案"
