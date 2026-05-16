---
name: html-report
description: 将内容生成精美 HTML 页面并上传到报告服务器，返回可直接访问的 URL。当用户说"生成 HTML"、"做个网页"、"发 URL 给我"、"生成报告页面"时触发。
---

# HTML 报告生成与发布

将结构化内容转换为可视化报告页面，通过 HTTP API 上传到报告服务器，返回可直接点击的 URL。

> **定位：这是阅读型 artifact，不是前端项目。** 目标是清晰表达信息，不是炫技。单文件 HTML、内联 CSS、无外部依赖、可读性优先。

---

## 组件白名单

页面只能使用以下预定义组件，**禁止自行发明新组件**。

### 1. Hero Header（页面标题区）
```html
<div class="header">
  <h1>标题</h1>
  <div class="meta">副标题 · 日期 · 作者</div>
</div>
```

### 2. Summary Cards（摘要卡片网格）
```html
<div class="card-grid">
  <div class="card">
    <div class="card-value">42</div>
    <div class="card-label">总数</div>
  </div>
  <!-- 2-4 个卡片 -->
</div>
```

### 3. Section（内容段落）
```html
<h2>段落标题</h2>
<p>正文内容，支持 <strong>加粗</strong>、<code>代码</code>、<a href="#">链接</a>。</p>
```

### 4. Comparison Table（对比表格）
```html
<table>
  <thead><tr><th>列A</th><th>列B</th><th>列C</th></tr></thead>
  <tbody><tr><td>数据</td><td>数据</td><td>数据</td></tr></tbody>
</table>
```
表格内可用 badge：`<span class="badge badge-green">通过</span>`

### 5. Timeline（时间线）
```html
<div class="timeline">
  <div class="timeline-item">
    <div class="timeline-dot"></div>
    <div class="timeline-content">
      <div class="timeline-time">10:30</div>
      <div class="timeline-text">事件描述</div>
    </div>
  </div>
</div>
```

### 6. Callout（提示/警告框）
```html
<blockquote class="callout callout-warn">
  <strong>⚠️ 注意：</strong>重要提示内容
</blockquote>
<blockquote class="callout callout-info">
  <strong>ℹ️ 说明：</strong>补充说明内容
</blockquote>
<blockquote class="callout callout-success">
  <strong>✅ 通过：</strong>检查通过
</blockquote>
```

### 7. Code Block（代码块）
```html
<pre><code>代码内容</code></pre>
```

### 8. Checklist（检查清单）
```html
<ul class="checklist">
  <li class="check-pass">✅ 已完成项</li>
  <li class="check-fail">❌ 未完成项</li>
  <li class="check-warn">⚠️ 需关注项</li>
</ul>
```

### 9. Ordered / Unordered List（列表）
```html
<ul><li>无序列表项</li></ul>
<ol><li>有序列表项</li></ol>
```

### 10. Divider（分隔线）
```html
<hr>
```

---

## 设计 Token

所有样式统一使用以下变量，保持视觉一致性：

| Token | 值 | 用途 |
|-------|-----|------|
| 主色 | `#667eea` | 标题背景、链接、强调 |
| 辅色 | `#764ba2` | 渐变终点 |
| 正文色 | `#1a1a2e` | 正文文字 |
| 次要文字 | `#4a5568` | 次级标题、说明 |
| 背景色 | `#f0f2f5` | 页面背景 |
| 卡片背景 | `#ffffff` | 内容区背景 |
| 边框色 | `#e2e8f0` | 表格、分隔线 |
| 成功 | `#c6f6d5 / #276749` | badge-green |
| 警告 | `#fefcbf / #975a16` | badge-yellow |
| 错误 | `#fed7d7 / #9b2c2c` | badge-red |
| 信息 | `#bee3f8 / #2a4365` | badge-blue |
| 圆角 | `12px`（大）/ `8px`（中）/ `4px`（小） | 卡片、代码块、badge |
| 字号 | `1.8rem`（h1）/ `1.4rem`（h2）/ `1.15rem`（h3）/ `1rem`（正文） | |

---

## 禁止项

- ⛔ 外部 CSS / JS CDN（CDN 挂了页面就废了）
- ⛔ 复杂 JavaScript 交互（除非用户明确要求折叠/Tab 等简单交互）
- ⛔ 自定义动画、渐变装饰、阴影堆叠等无意义视觉效果
- ⛔ iframe、canvas、SVG 图表（除非用户明确要求）
- ⛔ 组件白名单之外的自创组件
- ⛔ 重复内容（摘要和正文说同一件事）
- ⛔ 空白占位段落、lorem ipsum

---

## 执行步骤

### Step 1: 内容分析

从用户提供的内容中提取要展示的信息，确定：
- 报告主题和目标受众
- 核心数据点（用于 Summary Cards）
- 主体内容的逻辑结构

### Step 2: 规划页面结构

**先规划，再写 HTML。** 在 `<outline>` 标签内输出页面结构规划：

```
<outline>
- hero: 标题 + 副标题
- summary-cards: 3 张（指标A、指标B、指标C）
- section "分析结果": comparison-table + callout-warn
- section "时间线": timeline（5 个节点）
- section "建议": checklist（4 项）
</outline>
```

确认结构合理后再进入 Step 3。

### Step 3: 生成 HTML

基于 Step 2 的规划，使用下方模板生成自包含 HTML。**只能使用组件白名单中的组件。**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{TITLE}}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    line-height: 1.8; color: #1a1a2e; background: #f0f2f5;
    padding: 2rem 1rem;
  }
  .container { max-width: 900px; margin: 0 auto; }

  /* Hero Header */
  .header {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white; padding: 2rem; border-radius: 12px 12px 0 0;
  }
  .header h1 { font-size: 1.8rem; font-weight: 700; }
  .header .meta { font-size: 0.85rem; opacity: 0.85; margin-top: 0.5rem; }

  /* Content Area */
  .content {
    background: white; padding: 2rem; border-radius: 0 0 12px 12px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.07);
  }

  /* Summary Cards */
  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
  .card { background: #f7fafc; border-radius: 8px; padding: 1.2rem; text-align: center; border: 1px solid #e2e8f0; }
  .card-value { font-size: 2rem; font-weight: 700; color: #667eea; }
  .card-label { font-size: 0.85rem; color: #4a5568; margin-top: 0.3rem; }

  /* Typography */
  h2 { font-size: 1.4rem; color: #2d3748; margin: 1.5rem 0 0.8rem; padding-bottom: 0.4rem; border-bottom: 2px solid #e2e8f0; }
  h3 { font-size: 1.15rem; color: #4a5568; margin: 1.2rem 0 0.6rem; }
  p { margin: 0.6rem 0; }
  ul, ol { padding-left: 1.5rem; margin: 0.6rem 0; }
  li { margin: 0.3rem 0; }
  strong { color: #2d3748; }
  a { color: #667eea; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Table */
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.9rem; }
  th { background: #f7fafc; font-weight: 600; text-align: left; padding: 0.6rem 0.8rem; border: 1px solid #e2e8f0; }
  td { padding: 0.6rem 0.8rem; border: 1px solid #e2e8f0; }
  tr:hover td { background: #f7fafc; }

  /* Badge */
  .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
  .badge-green { background: #c6f6d5; color: #276749; }
  .badge-red { background: #fed7d7; color: #9b2c2c; }
  .badge-yellow { background: #fefcbf; color: #975a16; }
  .badge-blue { background: #bee3f8; color: #2a4365; }

  /* Callout */
  blockquote { border-left: 4px solid #667eea; padding: 0.8rem 1rem; background: #f8f9ff; margin: 1rem 0; border-radius: 0 8px 8px 0; }
  .callout-warn { border-left-color: #ecc94b; background: #fffff0; }
  .callout-info { border-left-color: #4299e1; background: #ebf8ff; }
  .callout-success { border-left-color: #48bb78; background: #f0fff4; }

  /* Timeline */
  .timeline { position: relative; padding-left: 2rem; margin: 1rem 0; }
  .timeline::before { content: ''; position: absolute; left: 0.5rem; top: 0; bottom: 0; width: 2px; background: #e2e8f0; }
  .timeline-item { position: relative; margin-bottom: 1.2rem; }
  .timeline-dot { position: absolute; left: -1.75rem; top: 0.4rem; width: 10px; height: 10px; border-radius: 50%; background: #667eea; border: 2px solid white; box-shadow: 0 0 0 2px #667eea; }
  .timeline-time { font-size: 0.8rem; color: #a0aec0; font-weight: 600; }
  .timeline-text { margin-top: 0.2rem; }

  /* Checklist */
  .checklist { list-style: none; padding-left: 0; }
  .checklist li { padding: 0.4rem 0; }
  .check-pass { color: #276749; }
  .check-fail { color: #9b2c2c; }
  .check-warn { color: #975a16; }

  /* Code */
  code { background: #f1f5f9; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.88em; color: #e53e3e; }
  pre { background: #1e293b; color: #e2e8f0; padding: 1rem; border-radius: 8px; overflow-x: auto; margin: 1rem 0; }
  pre code { background: none; color: inherit; padding: 0; }

  /* Divider */
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 1.5rem 0; }

  /* Footer */
  .footer { text-align: center; margin-top: 2rem; font-size: 0.8rem; color: #a0aec0; }

  /* Print */
  @media print {
    body { background: white; padding: 0; }
    .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .container { max-width: 100%; }
  }
  /* Mobile */
  @media (max-width: 640px) {
    .card-grid { grid-template-columns: 1fr 1fr; }
    .header h1 { font-size: 1.4rem; }
    body { padding: 1rem 0.5rem; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>{{TITLE}}</h1>
    <div class="meta">{{META}}</div>
  </div>
  <div class="content">
    {{SUMMARY_CARDS}}
    {{BODY_SECTIONS}}
  </div>
  <div class="footer">Generated by NanoClaw · {{DATE}}</div>
</div>
</body>
</html>
```

**占位说明：**
- `{{TITLE}}` — 页面标题
- `{{META}}` — 副标题信息（日期、作者等）
- `{{SUMMARY_CARDS}}` — 摘要卡片区（可选，无摘要数据时留空）
- `{{BODY_SECTIONS}}` — 主体内容区（多个 `<h2>` section 组成）
- `{{DATE}}` — 生成时间

**格式转换：** 将 Markdown 手动转换为 HTML 标签（`##` → `<h2>`，`**` → `<strong>`，表格 → `<table>`，列表 → `<ul>/<ol>` 等）

### Step 4: 自检

输出 HTML 前逐项确认：

- [ ] HTML 标签全部正确闭合
- [ ] 无外部 CSS/JS 依赖
- [ ] 只使用了组件白名单中的组件
- [ ] 移动端布局正常（`viewport` meta 存在，卡片网格响应式）
- [ ] 打印可读（`@media print` 存在）
- [ ] 无重复内容（摘要 vs 正文不重叠）
- [ ] 无空白占位或装饰性内容
- [ ] 所有中文使用 UTF-8 编码

### Step 5: 保存文件

文件名格式：`{中文简称}-{日期}.html`

命名规则：
- 用中文简称概括报告主题（10 字以内）
- 英文专有名词保留原文（如 ClaudeCode、AgentLoop、Nine）
- 日期格式 `YYYYMMDD`，无需时分秒
- 示例：`Nine消息压缩机制-20260511.html`、`ClaudeLoop移植测试计划-20260510.html`

```bash
FILENAME="报告简称-$(date +%Y%m%d).html"
```

用 Write 工具将 HTML 写到 `/workspace/group/$FILENAME`。

### Step 6: 上传到报告服务器

用 HTTP API 上传：

```bash
python3 -c "
import json, urllib.request
html = open('/workspace/group/$FILENAME').read()
data = json.dumps({'filename': '$FILENAME', 'content': html}).encode()
req = urllib.request.Request('http://10.117.0.159:8091',
    data=data,
    headers={'X-Upload-Key': 'O5vrky7-9dv3M7NELohZVNthFSxzvcClFtWHD_2YdVY',
             'Content-Type': 'application/json'})
resp = json.loads(urllib.request.urlopen(req).read())
print(resp['url'])
"
```

API 返回 JSON：`{"url": "http://10.117.0.159:8090/xxx.html", "filename": "xxx.html"}`

### Step 7: 返回 URL

把返回的 URL 发给用户。

---

## 上传 API 规格

| 项目 | 值 |
|------|-----|
| 端点 | `POST http://10.117.0.159:8091` |
| 认证 | `X-Upload-Key: O5vrky7-9dv3M7NELohZVNthFSxzvcClFtWHD_2YdVY` |
| Content-Type | `application/json` |
| Body | `{"filename": "xxx.html", "content": "<html>..."}` |
| 返回 | `{"url": "http://10.117.0.159:8090/xxx.html"}` |
| 限制 | 10MB 上限，无 key 返回 403 |
