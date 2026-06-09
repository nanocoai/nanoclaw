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
  /* Claude 风格：暖白底、暖灰文字、大留白、无装饰 */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6; color: #2d2d2d; background: #faf9f7;
    max-width: 820px; margin: 0 auto; padding: 3rem 1.5rem;
    font-size: 15px;
  }

  /* Header */
  .header { margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid #e8e6e1; }
  .header h1 { font-size: 1.6rem; font-weight: 600; color: #1a1a1a; letter-spacing: -0.01em; }
  .header .meta { font-size: 0.8rem; color: #8b8b7a; margin-top: 0.4rem; }

  /* Typography */
  h2 { font-size: 1.2rem; font-weight: 600; color: #1a1a1a; margin: 2rem 0 0.8rem; }
  h3 { font-size: 1.05rem; font-weight: 600; color: #3d3929; margin: 1.5rem 0 0.5rem; }
  p { margin: 0.8rem 0; color: #2d2d2d; }
  ul, ol { padding-left: 1.5rem; margin: 0.8rem 0; }
  li { margin: 0.3rem 0; }
  a { color: #b5651d; text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { font-weight: 600; }

  /* Summary Cards */
  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.8rem; margin: 1.5rem 0; }
  .card { background: #fff; border: 1px solid #e8e6e1; padding: 1.2rem; text-align: center; }
  .card-value { font-size: 1.8rem; font-weight: 600; color: #1a1a1a; }
  .card-label { font-size: 0.8rem; color: #8b8b7a; margin-top: 0.25rem; }

  /* Table */
  table { width: 100%; border-collapse: collapse; margin: 1.2rem 0; font-size: 0.9rem; }
  th { font-weight: 600; text-align: left; padding: 0.6rem 0.8rem; border-bottom: 2px solid #e8e6e1; color: #3d3929; }
  td { padding: 0.6rem 0.8rem; border-bottom: 1px solid #eeece7; }

  /* Badge */
  .badge { font-size: 0.75rem; font-weight: 500; padding: 0.15rem 0.5rem; border-radius: 2px; }
  .badge-green { background: #e6f4ea; color: #1e7e34; }
  .badge-red { background: #fce8e8; color: #c62828; }
  .badge-yellow { background: #fef7e0; color: #8a6d00; }
  .badge-blue { background: #e8f0fe; color: #1a5fb4; }

  /* Callout */
  blockquote { border-left: 2px solid #d4d1ca; padding: 0.6rem 1rem; margin: 1.2rem 0; color: #4a4a3a; background: #f5f4f0; }
  .callout-warn { border-left-color: #d4a017; background: #fdf8ec; }
  .callout-info { border-left-color: #5b8dc9; background: #f0f5fb; }
  .callout-success { border-left-color: #4a9960; background: #f0f8f2; }

  /* Timeline */
  .timeline { padding-left: 1.5rem; border-left: 2px solid #e8e6e1; margin: 1.2rem 0; }
  .timeline-item { margin-bottom: 1.2rem; }
  .timeline-dot { display: none; }
  .timeline-time { font-size: 0.8rem; color: #8b8b7a; font-weight: 500; }
  .timeline-text { margin-top: 0.15rem; }

  /* Checklist */
  .checklist { list-style: none; padding-left: 0; }
  .checklist li { padding: 0.3rem 0; }

  /* Code */
  code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 0.85em; background: #f0eeea; padding: 0.1rem 0.35rem; border-radius: 2px; }
  pre { background: #2d2d2d; color: #e8e6e1; padding: 1rem 1.2rem; overflow-x: auto; margin: 1.2rem 0; font-size: 0.85rem; line-height: 1.5; }
  pre code { background: none; color: inherit; padding: 0; border-radius: 0; }

  /* Divider */
  hr { border: none; border-top: 1px solid #e8e6e1; margin: 2rem 0; }

  /* Footer */
  .footer { text-align: center; margin-top: 3rem; font-size: 0.75rem; color: #b0ae9f; }

  /* Print */
  @media print { body { background: white; } }
</style>
</head>
<body>
  <div class="header">
    <h1>{{TITLE}}</h1>
    <div class="meta">{{META}}</div>
  </div>
  {{SUMMARY_CARDS}}
  {{BODY_SECTIONS}}
  <hr>
  <div class="footer">Generated by NanoClaw · {{DATE}}</div>
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
