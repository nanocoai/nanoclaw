---
name: wiki
description: 全局共享 Wiki 知识库维护。Ingest 资料、Query 查询、Lint 健康检查。
---

# Wiki 知识库

团队共享知识库，所有群的 agent 共享。**权威库是 `../../global/team_wiki/`**（推 GitHub `TierIITech/team-knowledge`，线上向量召回也只读这里）。

> ⚠️ 历史遗留的个人库 `../../global/wiki/` 已退役为草稿池，**不要再往那写**。写入端（本 skill）和召回端（`src/memory/inject.ts`）现已统一指向 `team_wiki`。

触发时机：
- 用户说"加到 wiki"、"整理到 wiki" → Ingest（写入 team_wiki）
- 用户发文件（`[文件: ...]`）且内容有知识价值 → 建议 Ingest 到 team_wiki
- 你为用户写了技术文档/方案/分析 → 建议存入 team_wiki
- 用户问问题且知识库可能有相关知识 → 先查 `../../global/team_wiki/index.md`
- 用户说"检查 wiki" → Lint

操作前先读 `INSTRUCTIONS.md`（与本文件同目录）获取详细指南。
