# E2E Plan: Codex GitNexus Tool Availability

## Scope

This E2E plan verifies the deployed NanoClaw Codex path, not only local unit tests. Config files are supporting evidence; at least one case must prove a real Codex turn invoked GitNexus through MCP rather than CLI fallback, `rg`, or `git diff`.

Local E2E catalog lookup note: the expected `e2e-test-catalog.md` was not present in this worktree's accessible wiki paths, so this plan defines new cases from the OpenSpec requirements.

## Environment

- Platform: NanoClaw local service after this branch is merged/deployed.
- Test chat: current Feishu group `oc_30a73bdf0717a83512ed3f7e15c8e818` or another Codex-mode group.
- Trigger: send a real Feishu message or NanoClaw Debug API `POST http://127.0.0.1:19877/send` with `jid=fs:oc_...`.
- Evidence sources:
  - lark-cli real Feishu message list for user-visible reply.
  - Per-group `.codex-home/config.toml`.
  - Per-group `.codex-home/sessions/**/rollout-*.jsonl` or equivalent structured Codex JSON trace to prove MCP tool invocation.
  - NanoClaw logs for absence of error/fallback messages.

## Cases

### CTG-01: Real Codex config injects GitNexus without secrets

- Level: L2
- Trigger: send a simple Codex-mode message that causes a new turn, for example `请回复 CTG01_<marker>，不用查代码。`
- Expected:
  - User receives a normal bot reply.
  - Generated `.codex-home/config.toml` contains `[mcp_servers.nanoclaw]` and `[mcp_servers.gitnexus]`.
  - Generated config does not contain `[mcp_servers.gitnexus.env]`, `GITNEXUS_EMBEDDING_API_KEY`, or any `sk-` API-key-like literal.
  - If `gitnexus` command is available, GitNexus MCP entry uses the wrapper command.
- Verification:
  - lark-cli confirms the bot reply exists for the marker.
  - Config file timestamp or containing session path proves the checked config belongs to this test turn, not an old leftover config.
  - `grep` generated config for required sections and forbidden secret strings.

### CTG-02: Indexed repository query uses GitNexus MCP in a real Codex turn

- Level: L1
- Trigger: send a real Codex-mode message:
  - `请必须使用 GitNexus MCP 查询 nanoclaw 仓库里 buildCodexConfigToml 的调用方；不要使用 CLI、rg、git diff 兜底。回复里带 CTG02_<marker> 和调用方名字。`
- Expected:
  - User-visible reply contains `CTG02_<marker>`.
  - Reply includes the real caller `runCodexQuery`.
  - Reply must not say `当前环境没有暴露 gitnexus_*`、`降级为 rg`、`git diff`、`CLI fallback` or similar fallback wording.
  - Codex trace shows at least one structured GitNexus MCP tool call and one matching tool result in that exact marker turn.
  - String matches alone are not sufficient. `gitnexus`, `buildCodexConfigToml`, or `runCodexQuery` appearing only in the prompt, final answer, config, or stderr does not pass this case.
- Required structured evidence:
  - The marker turn's rollout/JSON trace contains a tool call event whose server/name identifies GitNexus MCP, for example `gitnexus_context`, `gitnexus_query`, `mcp_servers.gitnexus`, or an equivalent structured MCP tool-call field.
  - The same turn contains the corresponding tool result event, and the result body contains `buildCodexConfigToml` and `runCodexQuery`.
  - If rollout JSON does not record MCP tool names, use an equivalent structured source, such as Codex tool inventory plus a per-turn tool invocation/result log. Plain text grep over the final answer is not acceptable.
- Verification:
  - lark-cli confirms final message content.
  - Inspect newest Codex rollout JSONL for the marker turn and extract the structured GitNexus MCP tool call/result pair.
  - NanoClaw logs confirm no fallback warning/error for missing GitNexus MCP.

### CTG-03: Unindexed repository is fail-visible and does not silently run embeddings

- Level: L1
- Trigger: send a real Codex-mode message:
  - `请用 GitNexus MCP 查询仓库 e2e-unindexed-<marker> 的任意调用链。你必须先实际调用 GitNexus 查询这个仓库；如果 GitNexus 返回未索引或找不到仓库，不要执行 analyze，不要跑 embeddings，只告诉我未索引并给出需要确认后才能执行的命令。回复带 CTG03_<marker>。`
- Expected:
  - User-visible reply contains `CTG03_<marker>`.
  - Reply states the repository is not indexed.
  - Reply asks for explicit confirmation before indexing.
  - Reply offers fast static index and full embeddings index options.
  - Codex trace proves the turn attempted a GitNexus MCP query against `e2e-unindexed-<marker>` and received an unindexed/not-found style result.
  - The turn does not run `gitnexus analyze` or `--embeddings`.
  - The turn completes without several-minute hang.
- Required anti-false-green evidence:
  - The marker turn's structured trace contains a GitNexus MCP query/context/impact call with repo `e2e-unindexed-<marker>` or equivalent argument.
  - The corresponding tool result shows the repository is missing, unindexed, or not found.
  - A final answer that merely repeats the prompt's desired wording without this tool call/result evidence is a failure.
- Verification:
  - lark-cli confirms final message content and no long delay.
  - Inspect the marker turn's rollout/JSON trace for the GitNexus MCP query and its not-found result.
  - Codex rollout/logs for this turn do not contain `gitnexus analyze` or `--embeddings`.
  - Logs do not show fallback presented as GitNexus success.

### CTG-04: Missing GitNexus command is covered by local regression tests

- Level: L3
- Scope: no real Feishu E2E required.
- Rationale:
  - Simulating a missing `gitnexus` command in a deployed Codex group would require mutating PATH or runtime environment and risks breaking unrelated turns.
  - Unit tests already cover this contract: when `gitnexus`/`GITNEXUS_BIN` is unavailable, generated Codex config still contains `nanoclaw` MCP and omits GitNexus MCP without preventing Codex startup.
- Verification:
  - Local targeted tests for `isGitNexusCommandAvailable()` and config generation pass.
  - E2E focuses on the deployed positive path and fail-visible unindexed path.

## Pass Criteria

- CTG-01, CTG-02, and CTG-03 all pass.
- CTG-02 must include structured MCP tool call/result evidence; config-only evidence, prompt text, stderr, or final-answer grep is not sufficient.
- CTG-03 must include structured evidence that GitNexus was actually queried for the missing repository and returned a missing/unindexed result.
- Any failure must include expected-vs-actual user-visible message content and raw log/rollout evidence before retrying.
