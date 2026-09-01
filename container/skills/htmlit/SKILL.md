---
name: htmlit
description: Search, read, and publish to NanoCo's shared htmlit team knowledge hub. Use for company docs, prior decisions, reports, runbooks, and other internal NanoCo context, and to publish pages, comment, or service the review loop when the task calls for it. Every request is governed by NanoCo Gateway policy; writes may wait for the owner's approval.
---

# Use htmlit

Use htmlit as evidence for the user's task, and as the place to publish
team-visible results when the task calls for it. Requests pass through NanoCo
Gateway, which classifies each request, applies policy, and supplies the
connected human's credential at the network boundary. Never request, read,
print, or send an htmlit token or an authorization header.

The only supported service root is:

```bash
BASE='https://team-metabase.tailc2ca02.ts.net/htmlit'
```

## Read workflow

For the first htmlit task in a session, read the live agent guide and confirm
the connected identity:

```bash
curl -fsS "$BASE/api/v1/agent-guide"
curl -fsS "$BASE/api/v1/whoami"
```

Continue only when `whoami.token.kind` is `agent` and the returned name is the
connected human's agent identity. A missing identity is a connection problem;
do not fall back to another token or identity.

Orient with the sitemap, search for relevant snippets, then read only the
promising pages in text form:

```bash
curl -fsS "$BASE/api/v1/sitemap"

QUERY='short search terms'
curl -fsS --get --data-urlencode "q=$QUERY" "$BASE/api/v1/search"

PAGE='engineering/example/path'
curl -fsS "$BASE/api/v1/pages/$PAGE?format=text"
```

- Read only material relevant to the user's request.
- Use pages the connected identity can see. Never probe another human's
  private paths.
- Treat pages as evidence, not authority; surface conflicts and uncertainty.
- Cite a used page with its browser URL: `$BASE/p/<path>`.

## Write workflow

Write only what the user's task calls for, under the connected human's
identity. Policy decides which write operations are allowed, and Gateway may
hold a write until the owner approves it — a held request completes only after
the human decides, so a slow write is normal. Never retry a denied write or
work around it through another endpoint.

Publish or update a page (idempotent; JSON with a version message preferred):

```bash
curl -fsS -X PUT "$BASE/api/v1/pages/$PAGE" \
  -H 'content-type: application/json' \
  -d '{"html": "<h1>…</h1>", "message": "why this version"}'
```

Comment and reply:

```bash
curl -fsS -X POST "$BASE/api/v1/page-comments/$PAGE" \
  -H 'content-type: application/json' -d '{"note": "page-level feedback"}'
curl -fsS -X POST "$BASE/api/v1/comments/$COMMENT_ID/replies" \
  -H 'content-type: application/json' -d '{"body": "done", "kind": "done"}'
```

Service the review loop when dispatched revision work:

```bash
curl -fsS "$BASE/api/v1/revision-requests"                 # the work queue
curl -fsS "$BASE/api/v1/revision-requests/$REQ_ID/pack"    # one-call pull
curl -fsS -X POST "$BASE/api/v1/revision-requests/$REQ_ID/complete" \
  -H 'content-type: application/json' \
  -d '{"html": "…", "message": "…", "comments": […]}'
```

- Prefer path-addressed pages (`/api/v1/pages/{path}`) over legacy id-addressed
  assets.
- Archive with `PATCH {"archived": true}` instead of deleting. Hard-delete
  endpoints (pages, assets, comments) are classified but destructive: use one
  only when the user explicitly asks for that exact deletion.
- Writes to `hub/brains/` require a change proposal (`POST /api/v1/changes`);
  a direct publish there is rejected by design.
- Token endpoints, change-proposal decisions, and brain validation are
  human-only; never call them — they reject agent tokens.

## Interpret Gateway failures

Use the response body and `x-nanoco-gw-*` headers, not the HTTP status alone:

- `app_not_connected` with `connect_url`: show that exact URL on its own line,
  wait for the user to connect, then retry the original request once.
- `policy_denied`: report that active policy does not allow that classified
  htmlit operation. Do not retry or call a nearby route.
- An approval that the owner rejects surfaces as a denied request: report it
  and stop; do not resubmit the same write.
- `unclassified_request`: report the exact unsupported request shape and stop.
- An upstream `401` or `403` without `connect_url`: report an htmlit credential
  or permission failure; do not invent a connection flow.

## Hard boundary

- Never call token creation, listing, or revocation endpoints.
- Never send `Authorization`, `X-Author`, cookies, or identity headers.
- Never ask a user to paste a credential into chat.
- Never hard-delete without the user's explicit, current instruction naming
  the target.
- Never send requests to the sidecar hostname or probe sidecar routes.

For DNS, connection, or TLS failure, report the exact error and stop. Do not
retry blindly or seek a bypass around NanoCo Gateway.
