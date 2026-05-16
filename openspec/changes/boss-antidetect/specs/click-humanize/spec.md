## ADDED Requirements

### Requirement: 点击按压时间随机化

mousePressed 到 mouseReleased 的间隔 SHALL 为 80-150ms 随机值，模拟真人手指按压节奏。

#### Scenario: 单次点击间隔
- **WHEN** 执行一次鼠标点击
- **THEN** mousePressed 和 mouseReleased 之间 SHALL 等待 80-150ms（均匀随机）

#### Scenario: 不触发快速点击检测
- **WHEN** 单次点击的按压间隔设为 80-150ms
- **THEN** 不会触发 Boss risk-detection 的 code=99005（连续点击间隔 ≤ 50ms）检测

### Requirement: 连续点击间隔随机化

连续两次独立点击操作之间 SHALL 间隔 500ms-2000ms 随机值。此延迟由调用方（业务逻辑层）负责注入，不在 `mouse_click()` 内部实现。`mouse_click()` 只负责单次点击内部的按压时长。

#### Scenario: 连续操作间隔
- **WHEN** 执行完一个点击操作后需要执行下一个点击
- **THEN** 调用方 SHALL 在两次 `mouse_click()` 之间等待 500-2000ms（均匀随机）

#### Scenario: 累积计数不触发阈值
- **WHEN** 在一个操作流程中连续执行 10+ 次点击
- **THEN** 所有点击间隔均 > 50ms，不触发 Boss 的累积 10 次快速点击上报
