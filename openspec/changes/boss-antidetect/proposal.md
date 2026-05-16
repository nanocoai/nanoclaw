## Why

Boss 直聘的反爬系统（4 个 JS 脚本，总计 456KB）会检测自动化特征并触发风控，导致账号登录状态被清除。当前 tools 的 Playwright 自动化存在两个高危暴露面：

1. **JS Hook 暴露**：`_enable_nav_guard` 通过 `addScriptToEvaluateOnNewDocument` 注入的 `_JS_ROUTER_HOOK` override 了 `history.pushState/replaceState` 和 `Location.prototype.assign/replace`，全部失败于 Boss `security-368.js` 的 `toString().includes('[native code]')` 检查
2. **直线鼠标轨迹**：CDP `Input.dispatchMouseEvent` 产生完美直线移动，Boss `security-web.js` 的 ML 模型 6 个维度全部触发（linearity=1.0, curvature=0, jerkiness=0, efficiency=1.0, stops=0, velocity autocorrelation=极高）

搜索简历操作已实际触发风控导致登录态丢失，必须立即修复。

## What Changes

- **移除 JS Hook**：从 `_enable_nav_guard` 中去掉 `_JS_ROUTER_HOOK` 和 `addScriptToEvaluateOnNewDocument`，只保留 Fetch 204 拦截（已验证可独立覆盖所有 recommend 跳转）
- **贝塞尔曲线鼠标模拟**：实现 `human_mouse_move()` 函数，用三次贝塞尔曲线 + smoothstep 缓入缓出 + 高斯微抖动替代直线 CDP 鼠标事件
- **CDP 点击间隔随机化**：mousePressed → mouseReleased 间隔 80-150ms，连续点击间隔 500ms-2s
- **localhost 端口拦截加固**：确认 WebSocket 升级请求也被 Fetch patterns 正确拦截
- **Playwright binding 时序加固**：确认 `--disable-blink-features=AutomationControlled` 已在 Chrome 启动参数中

## Capabilities

### New Capabilities
- `bezier-mouse`: 贝塞尔曲线鼠标模拟引擎，替代所有直线 CDP 鼠标事件
- `click-humanize`: 点击间隔随机化，防止快速点击检测（code=99005）

### Modified Capabilities
- `nav-guard`: 去除 JS Hook 层，仅保留 Fetch 204 拦截，消除 native code 检测暴露

## Impact

- **代码**：`packages/boss/tools_boss/playwright_boss.py`（sangou 远程机器）
- **API**：无外部 API 变更，纯内部实现
- **依赖**：无新依赖（纯 Python math/random）
- **系统**：Chrome 启动参数可能需要加 `--disable-blink-features=AutomationControlled`
- **风险**：Fetch 204 拦截是 CDP 协议层，Boss JS 无法感知；贝塞尔鼠标需要 ML 评分验证
