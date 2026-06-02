---
name: feishu-docs
description: 读取、创建飞书文档，上传文件到用户云盘。当用户发飞书文档链接、要求创建文档、或要求上传文件时使用。
codex-shared: true
---

# 飞书文档工具

通过 `feishu-docs` CLI 操作飞书文档和云盘。环境变量 `FEISHU_TENANT_TOKEN` 由系统自动注入。

## 可用命令

### 读取文档
```bash
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs read <URL或文档ID>
```

支持的 URL 格式:
- `https://xxx.feishu.cn/docx/TOKEN`
- `https://xxx.feishu.cn/wiki/TOKEN`
- 直接传文档 ID

输出为 Markdown 格式的文档内容。

### 创建文档
```bash
# 方式1: 内联内容
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs create "文档标题" "# 内容\n正文..."

# 方式2: 从 stdin 读取（适合长内容）
cat content.md | node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs create "文档标题"
```

输出 JSON: `{ document_id, url, message }`。将 url 分享给用户即可。

### 上传文件
```bash
# 上传到用户云盘指定目录（推荐）
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs upload /path/to/file --folder nanoclaw

# 上传到用户云盘根目录
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs upload /path/to/file
```

文件上传到用户个人云盘。`--folder` 指定目标文件夹（不存在会自动创建）。
输出 JSON: `{ file_token, file_name, size, url, folder, message }`。url 是可直接点击的云盘链接。

### 搜索文档
```bash
node /home/node/.claude/skills/feishu-docs/feishu-docs.mjs search "关键词"
```

返回匹配的文档列表（JSON 数组）。

## 使用场景

- 用户发了飞书文档链接 → 用 `read` 命令获取内容
- 用户要求写报告/文档 → 先在本地编写内容，再用 `create` 命令创建飞书文档，把链接发给用户
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

- 用户授权后可读取该用户有权限的所有文档
- 创建的文档在应用空间中，需要分享链接给用户
- 上传的文件在用户个人云盘中（默认 `nanoclaw` 文件夹）
- User Token 有效期约 2 小时，系统会自动刷新
