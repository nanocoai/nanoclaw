## 1. Immediate Mitigation

- [x] 1.1 Run GitNexus indexing for `/Users/dajay/AI_Workspace/nine-recruit-api` and record command output
- [x] 1.2 Verify `nine-recruit-api` appears in `gitnexus list`

## 2. Code-Graph Skill Fail-Visible Behavior

- [x] 2.1 Update `container/skills/code-graph/SKILL.md` to remove unconditional `gitnexus analyze --embeddings`
- [x] 2.2 Document the unindexed repo flow: report missing index, ask for confirmation, offer fast static index and full embeddings index
- [x] 2.3 Add timeout guidance and manual continuation command to the skill
- [x] 2.4 Add a test or static assertion that the skill no longer instructs agents to run embeddings indexing automatically

## 3. Codex GitNexus MCP Injection

- [x] 3.1 Add a typed extra MCP server config path to `buildCodexConfigToml()`
- [x] 3.2 Add GitNexus wrapper command support that sources `~/.gitnexus/env` only when present and still starts `gitnexus mcp` when env is absent
- [x] 3.3 Inject GitNexus MCP when the `gitnexus` command is available; do not require embedding env for already-indexed repo queries
- [x] 3.4 Ensure generated config, source, tests, snapshots, and normal logs do not contain secret API keys
- [x] 3.5 Keep `nanoclaw` MCP generation unchanged

## 4. Unit Tests

- [x] 4.1 Add/extend codex-runner tests for `nanoclaw` + `gitnexus` TOML generation
- [x] 4.2 Add missing-env test: GitNexus unavailable does not break `nanoclaw` MCP config
- [x] 4.3 Add secret-safety test: generated TOML/logs/snapshots do not contain raw API key
- [x] 4.4 Add code-graph skill regression test for fail-visible indexing instructions

## 5. Local Verification

- [x] 5.1 Run targeted tests for codex-runner and code-graph skill behavior
- [x] 5.2 Run `npm run build`
- [x] 5.3 Run `git diff --check`
- [x] 5.4 Run GitNexus impact/detect-changes or document fallback if GitNexus cannot analyze this NanoClaw worktree

## 6. C3 Code Review

- [x] 6.1 Send code diff and verification evidence to C3
- [x] 6.2 Fix P0/P1 review findings until C3 returns GO

## 7. E2E Plan

- [x] 7.1 Design E2E-01: real Codex turn proves at least one GitNexus MCP tool call succeeds
- [x] 7.2 Design E2E-02: unindexed repository path is fail-visible and does not silently run embeddings
- [x] 7.3 Design E2E-03: indexed repository query uses GitNexus successfully
- [x] 7.4 Send E2E plan to C3 and iterate until GO

## 8. Merge, Deploy, and E2E Evidence

- [ ] 8.1 Create PR and wait for user confirmation before merge
- [ ] 8.2 Merge with merge commit after confirmation
- [ ] 8.3 Deploy/restart NanoClaw as needed
- [ ] 8.4 Execute approved E2E cases and collect config/log/user-visible evidence
- [ ] 8.5 Send E2E evidence to C3 and iterate until GO
- [ ] 8.6 Report final result to user with PR, deploy, and E2E evidence
