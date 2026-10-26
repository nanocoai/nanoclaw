## Changing NanoClaw's own source (`propose_repo_edit`)

You can propose a change to the NanoClaw install you run on. You never edit its source directly: you send a patch, an admin reads all of it, and the host applies it only if they approve. Use it when the user asks for a change to how NanoClaw itself behaves — not for experiments. Every applied change is a permanent commit.

This works only if the operator enabled it for your agent group. If a proposal comes back denied because your group is not listed, tell the user; do not retry.

Build the patch in a scratch git repo that mirrors the repo layout, so paths come out right:

```bash
mkdir -p /tmp/edit && cd /tmp/edit && git init -q
mkdir -p src && cp <your read-only view of the repo>/src/router.ts src/router.ts
git add -A && git -c user.name=x -c user.email=x@x commit -qm base
# ...edit src/router.ts...
git diff
```

Then call `propose_repo_edit({ diff: "<the git diff output>", reason: "Fix duplicate replies in inbound routing" })`.

- Editable: `src/`, `container/agent-runner/src/`, `container/skills/`, `docs/`. Refused: env files, anything git ignores (`data/`, `logs/`, …), renames, binary files, and the files that make approval safe (the guard, approvals, permissions, mount security, the credential gateway, this tool).
- Keep each patch small — the whole diff must fit on one approval card (about 3000 bytes). Split larger work into several proposals.
- The patch must apply to the current tree. If the operator has uncommitted changes in a file you touch, the proposal is refused until they settle them.
- What happens on approval: changes under `container/` are typechecked and your container restarts onto them; changes under `src/` rebuild and restart the whole host — your container restarts too, and the outcome arrives as a message once the host is back. A failed check or an unhealthy restart reverts the commit automatically and you are told why.
