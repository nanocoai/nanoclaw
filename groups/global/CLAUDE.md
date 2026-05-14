# Global Rules

## 发送文件和图片

### 默认方式：上传到飞书云盘（推荐）

发文件给用户时，**默认上传到飞书云盘 nanoclaw 目录**，然后把链接发给用户：

1. 先用 Write/Bash 工具在磁盘上创建文件（用绝对路径）
2. 用 feishu-docs skill 上传到云盘：
   ```bash
   node /Users/dajay/AI_Workspace/nanoclaw/container/skills/feishu-docs/feishu-docs.mjs upload /path/to/file --folder nanoclaw
   ```
3. 把返回的云盘链接发给用户

### 备用方式：直接发文件消息

仅当用户**明确要求"直接发文件"、"本地文件发我"**时，才用此方式：

在回复文本中包含标记（编排层会自动拦截、上传到飞书消息）：
- 发送文件: [文件: /实际存在的绝对路径/report.pdf]
- 发送图片: [图片: /实际存在的绝对路径/screenshot.png]

⚠️ 路径必须是实际存在的宿主机绝对路径，不是示例。先确认文件存在再引用。
⚠️ 不要在代码块或反引号里写这个标记，否则编排层匹配不到。

### 发送图片

图片始终用标记方式直接发（不传云盘）：
- [图片: /实际存在的绝对路径/screenshot.png]

## ⛔ NanoClaw 项目目录注意事项

在 `/Users/dajay/AI_Workspace/nanoclaw/` 目录下：
- ✅ 可以执行 `npm run build`（tsc 编译）
- ⛔ 禁止执行 `npm install` / `npm ci` / `npm update` / `npm rebuild`
- ⛔ 禁止删除或修改 `node_modules/` 下的任何文件

原因：npm install 会破坏 native module（better-sqlite3），导致主进程崩溃。

## ⛔ 定位问题必须先看证据

遇到 bug、报错、异常行为时，**禁止先推理后验证**，必须**先收集证据再下结论**。

### 强制流程

1. **先看日志/错误信息** — 不是"我觉得可能是"，是"日志里写的是"
2. **先查 git 历史** — `git log`、`git blame` 确认最近改了什么
3. **先复现** — 能稳定复现才能定位，不能复现就说"无法复现，需要更多信息"
4. **再给结论** — 结论必须引用具体的日志行/代码行/commit，不能凭空推理

### 禁止行为

- ⛔ 没看日志就说"可能是 XX 导致的"
- ⛔ 没查代码就说"应该是 XX 的问题"
- ⛔ 没复现就说"我已经修好了"
- ⛔ 脑补时序/状态，不看实际运行数据

### 加载 Skill

定位 bug 时应加载 `systematic-debugging` skill，按其 4 阶段流程执行。

## ⛔ Nine 项目查日志必须用 Skill

排查 Nine 平台问题（报错、超时、日志查询）时，**必须先加载 `nine-observability` skill**，按其 5 步法执行（GlitchTip → Jaeger → Loki）。

**禁止**直接 `ssh dev "docker logs xxx | grep yyy"` 手动查日志。skill 里有完整的命令模板和踩坑记录，手动 grep 效率低且遗漏结构化信息。

## Internal thoughts

在思考时，用 💭 开头简短标注思路即可，不要输出大段内部独白。
