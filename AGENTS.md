<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **nanoclaw** (6121 symbols, 8443 relationships, 175 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If the index is stale or points at another checkout, treat it as advisory and fall back to current-worktree evidence. Never rebuild an index from a task worktree.

## Always Do

- **Use GitNexus for high-risk changes:** shared entry points, public interfaces, schemas/migrations, auth/security, concurrency/state machines, cross-module behavior, and renames/refactors.
- **Use judgment for medium-risk changes:** unfamiliar modules or unclear call chains benefit from `query`/`context`/`impact` when the shared index is current.
- **Skip GitNexus for low-risk changes:** docs, tests, config, generated files, isolated leaf functions, and newly added symbols with no indexed callers. Use `rg`, `git diff`, and targeted tests instead.
- **Use `gitnexus_detect_changes()` only when it is scoped to the current worktree.** Git diff remains the source of truth.
- **If GitNexus tools are unavailable**, say that explicitly, do not claim they were run, and fall back to `rg`, `git log`, `git diff`, targeted tests, and manual call-chain review.
- **Warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER pretend GitNexus was used when the tools were not available.
- NEVER run `gitnexus analyze` from a task worktree. Shared indexes are refreshed separately from their tracked upstream branches.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER present stale, wrong-worktree, `UNKNOWN`, or `Target not found` output as a valid risk assessment.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/nanoclaw/context` | Codebase overview, check index freshness |
| `gitnexus://repo/nanoclaw/clusters` | All functional areas |
| `gitnexus://repo/nanoclaw/processes` | All execution flows |
| `gitnexus://repo/nanoclaw/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
