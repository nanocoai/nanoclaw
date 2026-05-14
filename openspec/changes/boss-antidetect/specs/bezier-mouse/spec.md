## ADDED Requirements

### Requirement: 贝塞尔曲线鼠标移动

系统 SHALL 提供 `human_mouse_move(cdp, from_x, from_y, to_x, to_y)` 异步函数，使用三次贝塞尔曲线生成鼠标移动轨迹，替代直线 CDP `Input.dispatchMouseEvent`。

轨迹参数：
- 控制点：三次贝塞尔曲线，2 个控制点（P1、P2），各在路径法线方向随机偏移，偏移量 = min(±15-30px, 路径长度 × 30%)
- 步数：20-40 步（随机），距离 < 50px 时 10-20 步
- 速度曲线：smoothstep 缓入缓出（`t * t * (3 - 2t)`）
- 微抖动：每步叠加 `gauss(0, 0.5)` 像素噪声
- 步间延迟：5-25ms 不均匀分布
- 初始位置：模块级 `_last_mouse_pos` 追踪，首次使用时初始化为视口边缘随机坐标 `(random(10,50), random(10,50))`

#### Scenario: 鼠标移动轨迹通过 ML 评分
- **WHEN** 使用 `human_mouse_move` 从 (100, 100) 移动到 (500, 400)
- **THEN** 生成的轨迹 linearity < 0.7、curvature > 0、jerkiness > 0、efficiency 在 0.7-0.95 之间

#### Scenario: 鼠标移动发送正确的 CDP 事件
- **WHEN** 调用 `human_mouse_move` 时
- **THEN** SHALL 通过 `cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", ...})` 发送每一步，坐标为整数

#### Scenario: 短距离移动
- **WHEN** 起点和终点距离 < 50px
- **THEN** 步数 SHALL 减少到 10-20 步，控制点偏移量不超过路径长度的 30%（避免极度弯曲的 S 形）

### Requirement: 鼠标点击使用贝塞尔移动

系统中所有需要鼠标点击的操作 SHALL 先调用 `human_mouse_move` 移动到目标位置，再执行 mousePressed/mouseReleased 事件。禁止使用无移动的直接点击。

#### Scenario: 点击元素
- **WHEN** 需要点击坐标 (x, y) 的元素
- **THEN** 先执行 `human_mouse_move` 从当前位置移动到 (x, y)，然后执行 mousePressed + mouseReleased

#### Scenario: 当前位置追踪
- **WHEN** 连续执行多次点击
- **THEN** 每次点击的起点 SHALL 是上一次点击的终点位置
