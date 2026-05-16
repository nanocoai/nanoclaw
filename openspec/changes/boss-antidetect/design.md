## Context

Boss 直聘部署了 4 层反爬检测体系（risk-detection 33KB、security-368 169KB、security-web 183KB、warlock 71KB），涵盖 DOM 监控、自动化特征检测、端口探测、鼠标轨迹 ML 评分等。

我们的 tools 服务在 sangou 上通过 Playwright + CDP 自动化操作 Boss。当前代码有两个高危暴露面被实际触发：
1. `_JS_ROUTER_HOOK` 注入的 history/location API hook 被 native code 检查识别
2. CDP 直线鼠标移动被 ML 模型评分为机器人

**代码位置**：sangou `/Users/admin/aiwork/tools/packages/boss/tools_boss/`
- `cdp_base.py`：公共 `mouse_click()`、`mouse_move()` 函数（所有文件共用）
- `playwright_boss.py`：`_enable_nav_guard()`、`_disable_nav_guard()`、`_open_boss_task_page()` 中的 sidebar CDP 点击
- `playwright_boss_job.py`：job 页面 CDP 点击（L206-210）
- `playwright_boss_job_list.py`：job list 页面 CDP 点击（L295-304）

## Goals / Non-Goals

**Goals:**
- 消除所有可被 Boss JS 检测到的自动化特征
- 鼠标轨迹通过 ML 评分（score < 0.6）
- 所有 4 个被 hook 的原生 API 恢复 `[native code]` 检查
- 账号不再因自动化操作触发风控

**Non-Goals:**
- 不绕过 Boss 的频率限流（通过合理的操作间隔自然规避）
- 不修改 Chrome 指纹（navigator.userAgent 等已正常）
- 不修改业务逻辑或搜索策略
- 不处理 IP 层面的风控（当前 IP 未被封禁）

## Decisions

### D1: 贝塞尔鼠标改造方式 — 改 `cdp_base.py` 公共函数

**选择**：修改 `cdp_base.py` 中的 `mouse_move()` 和 `mouse_click()` 函数，在底层加入贝塞尔曲线逻辑。

**替代方案**：在每个调用点单独替换 → 4 个文件 10+ 处修改，容易遗漏。

**理由**：`cdp_base.py` 是所有 boss 模块共用的底层，改一处覆盖所有调用者。新增 `human_mouse_move()` 函数，修改 `mouse_click()` 内部调用 `human_mouse_move()` 先移动再点击。

### D2: 鼠标位置追踪 — 模块级变量

**选择**：在 `cdp_base.py` 中维护 `_last_mouse_pos = {"x": random(10,50), "y": random(10,50)}` 模块级变量，每次鼠标操作更新。

**理由**：贝塞尔曲线需要起点坐标。初始位置设为视口左上边缘随机坐标，模拟鼠标从屏幕边缘移入（而非从精确的 (0,0) 起步，避免 ML 模型检测首次鼠标出现位置异常）。模块级变量足够，不需要 per-page 追踪（同时只有一个 tab 在操作）。

### D3: nav-guard 去 JS Hook — 只保留 Fetch 204

**选择**：完全删除 `_JS_ROUTER_HOOK` 常量、`addScriptToEvaluateOnNewDocument` 调用、`removeScriptToEvaluateOnNewDocument` 清理逻辑。`_nav_guard_sessions` 存储从 `(cdp, js_script_id)` 元组改回 `cdp` 单值。

**替代方案**：修复 JS Hook 让 toString() 返回 native code → 不可能，Chrome 无法伪造 `Function.prototype.toString` 返回值。

**理由**：40 秒实测 Fetch 204 独立拦截 15 次 recommend 跳转，完全覆盖。Boss 的 recommend 跳转是通过 `location.href` 赋值（Document 级导航），pushState 层根本没触发过，JS Hook 本来就是多余的。

### D4: 点击间隔 — 两层延迟分离

**选择**：
1. **按压时长**（mousePressed→mouseReleased）：在 `mouse_click()` 内部处理，默认随机 80-150ms
2. **连续操作间隔**（两次独立点击之间）：由调用方负责，在业务逻辑层的连续点击之间加 `asyncio.sleep(random.uniform(0.5, 2.0))`

**理由**：按压时长是通用行为，适合在底层统一处理；连续操作间隔取决于业务上下文（搜索简历的节奏 vs 填写表单的节奏），不适合在 `mouse_click()` 里一刀切。

## Risks / Trade-offs

| 风险 | 概率 | 缓解 |
|------|------|------|
| 贝塞尔曲线增加操作时间（每次点击 +100-500ms） | 必然 | 可接受，人类操作本来就有延迟 |
| Boss 更新探测端口含 39222 | 低 | 改用随机端口启动 Chrome |
| Boss 检测 Fetch 拦截本身 | 极低 | Fetch 是 CDP 协议层，JS 无法感知；如需要可改 Service Worker |
| `_last_mouse_pos` 在并发场景不准 | 低 | 当前 Boss 操作单线程，不存在并发 |

## Migration Plan

1. SSH 到 sangou，`git stash` 保存当前工作
2. 修改 `cdp_base.py`：新增 `human_mouse_move()`，修改 `mouse_click()`/`mouse_move()`
3. 修改 `playwright_boss.py`：去掉 JS Hook，简化 `_enable_nav_guard`/`_disable_nav_guard`
4. 修改 `playwright_boss.py` 中 `_open_boss_task_page` 的 sidebar 点击，使用 `cdp_base.mouse_click()`
5. 修改 `playwright_boss_job.py`（L206-210）和 `playwright_boss_job_list.py`（L295-304）的内联 CDP 点击，统一使用 `cdp_base.mouse_click()`
6. 检查 Chrome 启动参数是否含 `--disable-blink-features=AutomationControlled`，如未配置则添加
7. 重启 tools 服务
6. 运行审计脚本验证所有检测点
7. 执行搜索简历冒烟测试
8. 回滚：`git stash pop` 恢复原代码 + 重启

## Open Questions

（已在 Migration Plan 中解决，无遗留问题）

## 测试计划

### P0 测试（必须通过）

| # | 测试 | 类型 | 验证方式 |
|---|------|------|----------|
| 1 | native code 检查 | 静态 | 浏览器控制台 `history.pushState.toString().includes('[native code]')` → true |
| 2 | Location API 检查 | 静态 | `Location.prototype.assign.toString().includes('[native code]')` → true |
| 3 | 鼠标轨迹非直线 | 动态 | 生成轨迹坐标序列，本地计算 linearity（点到起终直线的平均偏差/路径长度）≠ 0，efficiency < 0.95 |
| 4 | recommend 跳转拦截 | E2E | 导航到 /web/chat/index，40s 内页面不跳转到 recommend |
| 5 | 搜索简历不触发风控 | E2E | 执行一次完整搜索，登录状态保持有效 |

### P1 测试（应该通过）

| # | 测试 | 类型 | 验证方式 |
|---|------|------|----------|
| 6 | localhost 端口拦截 | 动态 | `fetch('http://127.0.0.1:9222')` 和 `new WebSocket('ws://127.0.0.1:18789')` 被拦截 |
| 7 | Playwright binding 清理 | 静态 | `typeof __playwright__binding__` === 'undefined' |
| 8 | 可疑全局变量扫描 | 静态 | window 中无 playwright/selenium/webdriver 相关变量 |

### P2 测试（锦上添花）

| # | 测试 | 类型 | 验证方式 |
|---|------|------|----------|
| 9 | 点击间隔统计 | 日志 | 所有 mousePressed→mouseReleased 间隔 > 50ms |
| 10 | 连续操作间隔 | 日志 | 连续独立点击间隔 > 500ms |

**预估用例数**：5 P0 + 3 P1 + 2 P2 = 10 个测试用例
