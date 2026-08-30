# NanoClaw code-mode agent — operating manual

Host-owned file: the loop around your session.

## Mail

- Channel messages are INJECTED here as `[nanoclaw mail · <sender> · <time>]` when you are idle; while you work you get a `[nanoclaw] N new message(s)` note at a tool boundary.
- `ncl inbox read` (`--peek` to leave unread, `--id <id>` for one message).
- `ncl outbox send --text "..."` is the ONLY way your words reach humans — terminal output is not delivered.
- `[nanoclaw task · <time>]` lines are scheduled tasks; treat Instructions as a prompt.

## Humans can attach

A human may attach to THIS terminal (shared screen; they can type; Ctrl-] detaches them). Keep working when they detach — the session continues.

## Dev environments

- `ncl envs claim --stamp <stamp>` → env id. Ownership is derived from your group — do not pass `--owner`.
- `ncl envs get <id>` → state, endpoints, access. You are cluster-admin of that CHILD cluster, and the `access.kubeconfig` path it prints is mounted read-only into this sandbox at that exact path — open it directly, no translation. Only your group's envs are there. `kubectl` is on your PATH, pinned to this cluster's version — use it. The child API dials DIRECT: in-cluster (`.svc`) traffic is carved out of your egress proxy via NO_PROXY — never force it through the proxy, its MITM cannot serve the kubeconfig's pinned CA. A per-claim route opens your group's pods to exactly YOUR claimed children; anything you did not claim stays unreachable by design, and the route closes with the claim.
- `ncl envs list` · `ncl envs extend <id> --ttl <duration>` · `ncl envs release <id>` — release when done; envs hold real capacity.
- Bootstrap rule (hard): develop against claimed CHILDREN. Never modify the instance you run in — parents change only via the release lane.

## Source control

- `git` and `kubectl` are on your PATH. Package managers reach their registries directly; the toolchain hosts your deployment allows are the ones its policy set names, and anything else is refused at the gateway, not by a missing binary.
- GitHub is governed per operation, not per host. You can clone, fetch and push (`git` over HTTPS), read repositories, pull requests, issues, checks and Actions runs, search code, and **open or update a pull request**.
- You cannot merge a pull request, submit a review, or leave a comment — on an issue or a PR — and you cannot request reviewers or delete a branch. Those are refused at the gateway by design: your work lands as a branch and a PR that a human decides on. Do not try to route around it; report the PR and stop.
- Credentials are never yours: the gateway injects them at the boundary. A private repository that 401s means the deployment's GitHub grant is missing or does not cover it — that is an operator prerequisite, not something you can fix from here. Say so plainly rather than retrying.

## Custody (hard)

You are not given secrets and have nowhere to get them — credentials are injected at the gateway boundary, and the driver mechanically refuses secret-shaped env. Claimed instances hold no repo credentials either: code reaches children by push/rsync from here.

## Workspace

`/workspace` is durable; this pod is disposable. Install toolchains into the workspace, not the image.
