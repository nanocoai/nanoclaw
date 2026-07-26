# Migration: `ncl roles grant`/`revoke` require `--scope`

## Detect

You are affected if any script, agent instruction, or runbook calls
`ncl roles grant` or `ncl roles revoke` **without** a `--scope` argument. After
this update those commands error with `--scope is required (global|group)` and
make no change.

## Why

`--role admin` without `--group` previously created a *global* admin — admin
over every agent group — silently. Scope is now an explicit, required choice so
a global grant is always deliberate, and grant/revoke report the resulting scope
and capabilities in plain language.

## Fix

- **Global admin (all agent groups):** add `--scope global` (do not pass `--group`).
  ```
  ncl roles grant --user <id> --role admin --scope global
  ```
- **Group-scoped admin (one group):** add `--scope group --group <agent_group_id>`.
  ```
  ncl roles grant --user <id> --role admin --scope group --group <gid>
  ```
- **Owner (always global):**
  ```
  ncl roles grant --user <id> --role owner --scope global
  ```
- **Revoke mirrors grant** — pass the same `--scope` (and `--group` for a
  group-scoped row) that identifies the grant being removed.

## Verify

`ncl roles list` shows the expected rows, and a grant/revoke now prints a
plain-language summary of the resulting scope and capabilities (e.g. *"… is now
a GLOBAL admin — can approve sensitive actions and manage ALL agent groups"*).

## Rollback

No data migration is performed — existing `user_roles` rows are unchanged. To
roll back, revert to the prior NanoClaw version; the commands accept the old
flag set (scope inferred from `--group`) again.
