# Scrub rules

Anything leaving this fork (branch name, commit messages, code, tests, docs, PR title and body,
issue text) must contain no internal information. The scrub check catches patterns. You catch
context.

## Always remove or replace

| Kind | Examples | Replace with |
|------|----------|--------------|
| Employer and product names | organization name, internal product or team names | nothing, or a neutral noun ("an LLM gateway") |
| Internal hosts, URLs, IPs | `*.internal`, cluster domains, private IP ranges | `example.com`, `localhost`, env var names |
| Internal tools and MCP servers | internal monitoring servers, internal ticket projects, ticket keys | generic role ("a read-only monitoring MCP server") |
| Credentials of any kind | tokens, keys, `.env` values, profile secrets | never included, not even as placeholders that look real |
| Personal data | home paths, emails, chat/user IDs, phone numbers, handles in code | `~`, `user@example.com`, `<chat-id>` |
| Operational data | logs, traces, telemetry, alert contents, error samples from real systems | synthetic fixtures written from scratch |
| This fork's naming | the local code folder name, local group names, local model aliases | neutral names matching upstream style |
| Model / provider choices of this install | specific model aliases, gateway profile names | config keys only, defaults neutral |

## Hard excludes (route `local-only`, do not scrub and ship)

- Code whose purpose is integrating the internal systems of your employer or organization. It is
  never contributed, scrubbed or not.
- Any file that was ever derived from customer data, support tickets, or production telemetry.
- The denylist file itself and anything under `.nanoclaw-contrib/`, `groups/`, `data/`, `logs/`.

## Denylist

The denylist (default `.nanoclaw-contrib/scrub-denylist.txt`) holds this install's internal terms:
the fork's name, the local code folder name, the operator's work handle and work email domain,
employer and product names, internal hostnames. One entry per line: plain text (case-insensitive
literal) or `/regex/flags`. `#` starts a comment. Add a term the moment you notice a new internal
name. Contribution worktrees branch from `upstream/main`, so the file never ships; add it to
`.gitignore` too if the fork itself is public.

`scrub-check.ts` warns when the denylist is missing or empty. Treat that warning as a blocker: the
built-in rules cannot know your internal names.

## When in doubt

Treat it as internal and ask the operator. Unsure whether content is shareable externally means
no, until the operator confirms.
