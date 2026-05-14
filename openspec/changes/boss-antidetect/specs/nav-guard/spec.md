## MODIFIED Requirements

### Requirement: 导航守卫拦截 recommend 跳转

系统 SHALL 使用 CDP Fetch 拦截阻止 Boss 自动跳转到 `/web/chat/recommend` 页面。拦截方式为 `Fetch.fulfillRequest` 返回 204 No Content（而非 `Fetch.failRequest`）。

**变更**：移除 JS Hook 层（`_JS_ROUTER_HOOK`、`addScriptToEvaluateOnNewDocument`），仅保留 Fetch 204 拦截。

理由：JS Hook override 的 `history.pushState/replaceState` 和 `Location.prototype.assign/replace` 会失败于 Boss `security-368.js` 的 `toString().includes('[native code]')` 检查，暴露自动化特征。Fetch 204 是 CDP 协议层拦截，JS 无法感知。

#### Scenario: 拦截 recommend 导航
- **WHEN** Boss SPA 尝试导航到包含 `/web/chat/recommend` 的 URL
- **THEN** Fetch handler SHALL 返回 204 No Content，浏览器保持当前页面不变

#### Scenario: 放行正常导航
- **WHEN** 导航目标不包含 `/web/chat/recommend`（如 `/web/chat/index`、`/web/chat/job`）
- **THEN** Fetch handler SHALL 调用 `continueRequest` 正常放行

#### Scenario: 不注入任何 JS 脚本
- **WHEN** `_enable_nav_guard` 被调用
- **THEN** SHALL NOT 调用 `Page.addScriptToEvaluateOnNewDocument`
- **THEN** `history.pushState.toString()` SHALL 包含 `[native code]`
- **THEN** `Location.prototype.assign.toString()` SHALL 包含 `[native code]`

#### Scenario: localhost 端口探测拦截
- **WHEN** Boss JS 发起 `http://127.0.0.1:*` 或 `ws://127.0.0.1:*` 请求
- **THEN** Fetch handler SHALL 返回 `ConnectionRefused`，阻止端口探测

#### Scenario: 清理资源
- **WHEN** `_disable_nav_guard` 被调用
- **THEN** SHALL 调用 `Fetch.disable` 关闭拦截
- **THEN** SHALL NOT 尝试移除不存在的 JS 脚本（因为不再注入）
