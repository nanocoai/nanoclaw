---
name: dev-git
description: Check a repository out into the sandbox working directory, keep Git configuration in the persistent workspace, commit cleanly, and use the credentials and trust provided by the environment.
---

# Git in a persistent workspace

## Configuration that survives a restart

The container home is replaced on restart; `/workspace` is not. Keep global
Git settings there, and repeat the export in every shell you use:

```bash
export GIT_CONFIG_GLOBAL=/workspace/.gitconfig
```

Set the author name and email the operator or the project asks for. Do not
invent an identity; ask on the chat surface when neither has said.

## Checking out into the working directory

Check the project out at `/workspace/group` itself, not in a subdirectory:
the chat surface's diff view follows a repository rooted there. The directory
is never empty (the operating manual and `.claude/skills/` are mounted into
it, read-only), so `git clone` refuses it and a plain checkout aborts when the
project tracks its own `CLAUDE.md`. This sequence works either way:

```bash
cd /workspace/group
git init
git remote add origin <url>
git fetch origin
git symbolic-ref HEAD refs/heads/<branch>
git reset origin/<branch>                 # index and HEAD; writes no files yet
git ls-files --error-unmatch CLAUDE.md >/dev/null 2>&1 && git update-index --skip-worktree CLAUDE.md
git checkout -- .                         # writes the tree, skipping the mounted manual
git branch -u origin/<branch>
printf '/CLAUDE.md\n/.claude/\n/.mcp.json\n' >> .git/info/exclude
```

The excludes keep the host-mounted files and the CLI's project config out of
`git status` and out of commits; they belong in the local exclude file, never
in a committed `.gitignore`. When the project tracks its own `CLAUDE.md`, the
mounted manual shadows it; `git show HEAD:CLAUDE.md` prints the project's
copy, and the skip-worktree mark keeps it out of status and commits.

## Commit hygiene

- One logical change per commit; the message says what changed and why.
- Run the tests you touched before committing.
- Stage deliberately with `git add <paths>` and review `git diff --cached`.
  Never commit secrets, credential stubs, tokens, or build output.
- Never force-push, rebase or amend published commits, or delete branches you
  did not create unless the task says so.

## Proxy and trust

When your environment uses an HTTP proxy, HTTPS remotes can use it. An
optional rewrite for tools that choose SSH URLs is:

```bash
git config --global url."https://github.com/".insteadOf git@github.com:
git config --global --add url."https://github.com/".insteadOf ssh://git@github.com/
```

Honor `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`. If the environment supplies
`SSL_CERT_FILE`, use that trust bundle for Git:

```bash
if [ -n "${SSL_CERT_FILE:-}" ]; then
  git config --global http.sslCAInfo "$SSL_CERT_FILE"
fi
```

## Credentials

Credentials are supplied by the configured gateway provider. Report an
authentication or authorization failure with the origin and operation; do not
persist a token in a remote URL, file, or environment variable.
