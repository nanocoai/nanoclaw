---
name: feishu-docs
description: 读取、创建飞书文档，上传文件到用户云盘。当用户发飞书文档链接、要求创建文档、或要求上传文件时使用。
codex-shared: true
---

# 飞书文档工具

通过 `feishu-docs` CLI 操作飞书文档和云盘。这个 skill 对外保留统一入口，底层优先调用飞书官方 `lark-cli`；不要在业务 skill 里直接散写 `lark-cli` 命令。

所有官方 CLI 调用默认带 `LARK_CLI_NO_PROXY=1`，避免代理污染内网/飞书请求。

## 可用命令

### 读取文档
```bash
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs read <URL或文档ID>
```

支持的 URL 格式:
- `https://xxx.feishu.cn/docx/TOKEN`
- `https://xxx.feishu.cn/wiki/TOKEN`
- 直接传文档 ID

底层使用 `lark-cli docs +fetch --api-version v2 --as bot`。输出为飞书官方返回的文档内容结构，适合保真读取；不要假装复杂表格/图片一定能还原成 Markdown。

### 创建文档
```bash
# 方式1: 内联内容
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs create "文档标题" "# 内容\n正文..."

# 方式2: 从 stdin 读取（适合长内容）
cat content.md | node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs create "文档标题"
```

输出 JSON: `{ document_id, url, message }`。将 url 分享给用户即可。

底层使用 `lark-cli docs +create --api-version v2 --as bot --content @file`，支持长文和表格，优先用于 PRD/方案文档。

### 追加内容
```bash
# 方式1: 内联内容
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs append <URL或文档ID> "## 新章节\n正文..."

# 方式2: 从 stdin 读取（适合长内容）
cat append.md | node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs append <URL或文档ID>
```

底层使用 `lark-cli docs +update --api-version v2 --as bot --command append --content @file`。

### 插入图片
```bash
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs insert-image <URL或文档ID> ./diagram.png --width 900 --caption "流程图"
```

底层使用 `lark-cli docs +media-insert --as bot`。如果返回 `docs:document.media:upload` 权限缺失，必须如实告诉用户“飞书应用权限未开”，不要说图片已嵌入。短期可退化为上传 HTML/SVG/PNG 文件并在文档中放链接。

### 上传文件
```bash
# 上传到用户云盘指定目录（推荐）
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs upload /path/to/file --folder nanoclaw

# 上传到用户云盘根目录
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs upload /path/to/file
```

文件上传到用户个人云盘。`--folder` 指定目标文件夹（不存在会自动创建）。
输出 JSON: `{ file_token, file_name, size, url, folder, message }`。url 是可直接点击的云盘链接。

底层使用 `lark-cli drive +upload --as bot`。当前 `--folder nanoclaw` 映射到固定 folder token；其他文件夹名需要先补 folder token 映射。

### 搜索文档
```bash
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs search "关键词"
```

返回匹配的文档列表（JSON 数组）。
底层使用 `lark-cli drive +search --as user`。

## 使用场景

- 用户发了飞书文档链接 → 用 `read` 命令获取内容
- 用户要求写报告/文档 → 先在本地编写内容，再用 `create` 命令创建飞书文档，把链接发给用户
- 用户要求在已有文档后追加内容 → 用 `append`
- 用户要求把图放进文档 → 优先把 SVG/HTML 渲染成 PNG 后用 `insert-image`；如权限不足，上传图件并把链接追加回文档
- 用户要求发文件/保存文件 → 用 `upload --folder nanoclaw` 上传到云盘，把 url 链接发给用户
- 用户要求查找文档 → 用 `search` 命令搜索

## 授权流程

如果工具提示 `FEISHU_AUTH_REQUIRED`，说明用户还没有授权飞书文档访问。按以下步骤处理：

1. 使用 `send_message` 工具发送 `{"type":"feishu_auth_request"}`
2. 告知用户："需要授权飞书文档权限，我已发送授权卡片，请点击卡片中的按钮完成授权。"
3. 用户完成授权后会收到"授权成功"的通知
4. 之后重试之前的飞书文档操作

**不要**在 `FEISHU_AUTH_REQUIRED` 时反复重试工具调用，先请求授权。

## 注意事项

- `create/read/append/insert-image/upload` 优先走官方 `lark-cli`
- `insert-image` 依赖飞书应用权限 `docs:document.media:upload`
- `search` 需要 `lark-cli` user 身份可用
- 创建的文档会由官方 CLI 给当前 CLI 用户授予管理权限
