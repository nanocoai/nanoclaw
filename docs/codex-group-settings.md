# Codex 群级配置

Codex 模式按群读取下面这个文件：

`data/sessions/<groupFolder>/.claude/settings.json`

示例：

```json
{
  "codex": {
    "model": "gpt-5.6-sol",
    "effortLevel": "medium",
    "serviceTier": "fast"
  }
}
```

`serviceTier` 只接受两个值：

- `fast`：启用 Codex 官方快速模式。
- `standard`：使用标准模式；不配置时也按标准模式运行。

设置在每轮 Codex 启动前读取，因此修改后下一条群消息生效，不需要重启 NanoClaw。该配置只影响对应群，不会改变其他群或 Claude SDK 模式。

快速模式通常更快，但会消耗更多额度，不建议全局默认开启。
