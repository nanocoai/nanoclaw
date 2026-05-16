## ADDED Requirements

### Requirement: ContainerConfig 支持 useCliMode 字段
`ContainerConfig` 接口 SHALL 新增可选字段 `useCliMode: boolean`，默认为 false。

#### Scenario: 字段存在且为 true
- **WHEN** 群的 container_config 包含 `useCliMode: true`
- **THEN** 该群的 agent 使用 CLI 模式运行

#### Scenario: 字段不存在或为 false
- **WHEN** 群的 container_config 不包含 `useCliMode` 或值为 false
- **THEN** 该群的 agent 使用 SDK 模式运行（默认行为不变）

### Requirement: container-runner 传递 useCliMode 到 agent-runner
`container-runner.ts` SHALL 从群配置中读取 `useCliMode` 并通过 ContainerInput 传递给 agent-runner 进程。

#### Scenario: 配置传递
- **WHEN** container-runner 启动 agent-runner
- **THEN** ContainerInput JSON 中包含 `useCliMode` 字段值

### Requirement: 通过命令或 API 设置 useCliMode
SHALL 支持通过更新 registered_groups 的 container_config 来设置 useCliMode。

#### Scenario: 数据库直接更新
- **WHEN** 管理员更新 registered_groups 表的 container_config JSON
- **THEN** 下次该群消息处理时读取新配置生效
