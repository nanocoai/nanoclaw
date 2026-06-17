# Wiki 操作详细指南

基于 Karpathy LLM Wiki 模式的团队共享知识库。**权威库是 `team_wiki/`**，个人库 `wiki/` 已退役为草稿池，不要再写。

## 目录结构

```
groups/global/team_wiki/             ← 团队共享知识（LLM 维护，推 GitHub）
groups/global/team_wiki/index.md     ← 团队索引（人 & AI 入口）
groups/global/team_wiki/private/     ← 个人私有（.gitignore 隔离，不上传）
groups/global/team_wiki/private/index.md  ← 私有独立索引
```

从 agent 工作区访问：`../../global/team_wiki/`

**共享 vs private 判断**（详见 `team_wiki/README.md`）：
- Nine 相关、可公开 → 共享层 `team_wiki/`
- 非 Nine（NanoClaw / Wall-E / Claude Code 研究等）、草稿、涉敏（IP/账号/证书/内部群 ID）→ `team_wiki/private/`
- 拿不准涉敏 → 先进 private，宁可保守

> ⚠️ 线上向量召回（`src/memory/inject.ts`）只读 `team_wiki/index.md` + `team_wiki/private/index.md`。写进别处召回不到。

## Ingest（导入资料）

用户提供文档、URL、或让你写技术方案时：

1. 判断进共享层还是 private（见上）
2. 通读资料，提取关键信息
3. 创建或更新 team_wiki 页面：
   - **综合进已有相关页**（优先），或新建主题页
   - 相关实体页（项目、人员、技术）/ 概念页
4. 更新所有受影响页面的交叉引用（用 `[[page-name]]` wiki link 格式）
5. 更新对应索引：共享进 `team_wiki/index.md`，私有进 `team_wiki/private/index.md`（两本索引互不引用）

**重要**：多个资料必须逐一处理，不要批量。"综合进已有页"优先于新建孤立碎片。

## Query（查询）

1. 先读 `team_wiki/index.md` 找相关页面（涉敏/个人经验再查 `team_wiki/private/index.md`）
2. 读取相关页面
3. 基于已综合的知识回答（附引用）
4. 如果回答本身有价值，考虑存回 team_wiki 作为新页面

## Lint（健康检查）

- 检查页面间矛盾
- 找孤立页面（无入链）
- 找过时内容
- 找缺失交叉引用
- 建议需要补充的内容

## 页面格式

```markdown
# 页面标题

简要描述。

## 内容

正文内容，使用 [[other-page]] 交叉引用。

## 相关

- [[related-page-1]]
- [[related-page-2]]

---
*来源: source-file.md | 创建: 2026-04-09 | 更新: 2026-04-09*
```
