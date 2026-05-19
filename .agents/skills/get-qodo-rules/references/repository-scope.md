# Repository Scope Detection

## Extracting Repository Scope from Git Remote URL

Parse the `origin` remote URL to derive the scope path. Both URL formats are supported:

- SSH: `git@github.com:org/repo.git` → `/org/repo/`
- HTTPS: `https://github.com/org/repo.git` → `/org/repo/`

If no remote is found, exit silently. If the URL cannot be parsed, inform the user and exit gracefully.

## Module-Level Scope Detection

If the current working directory is inside a `modules/*` subdirectory relative to the repository root, use it as the query scope:

- `modules/rules/src/service.py` → query scope: `/org/repo/modules/rules/`
- repository root or any other path → query scope: `/org/repo/`

## Scope Hierarchy

The API returns all rules matching the query scope via prefix matching:

| Query scope | Rules returned |
|---|---|
| `/org/repo/modules/rules/` | universal + org + repo + path-level rules |
| `/org/repo/` | universal + org + repo-level rules |
