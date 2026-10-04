# Authenticated Bureaucracy Automation (MVP) — Design

**Status:** Draft, awaiting user review.

## 1. Problem

`daniel-personal`'s `agent-browser` can now reach the open internet (this
session's direct-browser-egress feature — `src/browser-direct-egress.ts`).
That solved *reachability*. It did not solve the actual goal: Daniel wants
Gromit to act as him on personal bureaucracy sites — check status, and fill
and submit forms — across a long tail of services (Clal Insurance, Har
HaKesef / itur.mof.gov.il, Bituach Leumi and other government services,
utility bills, Technion SAP, miluim, restaurant reservation systems, and
more).

Live testing today surfaced the real blocker: these sites require
interactive authentication a headless browser cannot complete unattended.
Har HaKesef explicitly requires ID number plus SMS/biometric 2FA. This is not
a browsing problem; it is an identity problem.

Given the breadth of the target list, this MVP builds one **generic
mechanism** — not a scraper per site — and proves it against one pilot site.

## 2. Scope

**In scope (this spec):**
- A per-(agent-group, site) credential store, host-only, never readable by
  the agent (the LLM).
- A login flow: agent-driven navigation, host-injected static credentials,
  chat-relayed one-time codes.
- Session persistence across runs (skip login once a valid session exists).
- An approval gate for anything submission-shaped, reusing the existing
  approvals primitive.
- One pilot: Har HaKesef, read-only (balance/status checks only — the site
  has nothing to submit, so this MVP does not exercise the submission path
  end-to-end; the first site that needs it proves that path).

**Out of scope (this spec):**
- Any second site beyond the pilot. Once Har HaKesef works, later sites are
  new *credential setups* against the same mechanism, not new engineering —
  each gets evaluated (and, if it defeats scripted login outright — heavy
  CAPTCHA, aggressive bot detection — may need Approach 3 from the
  brainstorming discussion, the remote-viewable browser, as a separate
  future spec).
- Cookie-export-from-Daniel's-own-browser (brainstorming Approach 2) as a
  fallback path for sites that reject scripted login — not needed unless the
  pilot proves the primary path insufficient.
- Scheduled/recurring monitoring (e.g. "check Har HaKesef every week and
  tell me if it changes") — the MVP is invoked on request; recurrence can
  reuse nanoclaw's existing `ncl tasks create` scheduling once the
  one-shot flow works.

## 3. Non-negotiable constraint

**The agent (the LLM) must never see a stored static credential's plaintext
value.** nanoclaw's existing mount-class system (`src/drivers/types.ts`)
already enforces "no credentials in the agent container" for
provisioner-issued identity material; this feature must not quietly regress
that invariant just because the new secret is a *website* password instead
of a service API key. A leaked value here is Daniel's real bank/insurance/
government login, not a rotatable API key.

One-time SMS/biometric codes are explicitly exempt from this: they are
single-use, expire in minutes, and carry no standing value if the agent
sees one in its own transcript.

## 4. Components

### 4.1 Site credential store

A new table, `site_credentials`, host-side only:

```
site_credentials
  id               TEXT PRIMARY KEY
  agent_group_id   TEXT NOT NULL        -- scope: never cross-group
  site_key         TEXT NOT NULL        -- e.g. "har-hakesef"
  field            TEXT NOT NULL        -- "username" | "password" | ...
  value_encrypted  BLOB NOT NULL        -- encrypted at rest
  created_at       TEXT NOT NULL
  updated_at       TEXT NOT NULL
  UNIQUE(agent_group_id, site_key, field)
```

Encrypted at rest using the same host-side key-management approach the
install already uses for other at-rest secrets (concrete KMS choice is an
implementation-time decision, not a design one — the requirement is "not
plaintext on disk," not a specific library). Rows are never sent to the
container as env vars or file mounts — the container has no read path to
this table at all. Only the host-side `agent-browser` credential-fill
mechanism (4.3) reads it, and only long enough to inject one value into one
browser field.

### 4.2 Setup flow (one-time, per site)

Daniel initiates via chat ("set up Har HaKesef"). Gromit asks for
username/password conversationally, same as any question — but the *answer
message itself* is intercepted host-side before it reaches the agent's own
context: the chat-sdk-bridge delivery path recognizes a pending
credential-capture request for this session (a new, narrow variant of the
existing `ask_question` flow — see 4.5) and routes the raw reply straight
into `site_credentials`, replacing it in what the agent sees with an opaque
confirmation ("saved") rather than the literal password. This is the one new
piece of host-side plumbing this spec requires beyond the table itself.

### 4.3 Login + OTP flow

New `agent-browser` subcommand, `fill-credential`:

```
agent-browser fill-credential @e2 --site har-hakesef --field username
```

Unlike `agent-browser fill @e2 "<value>"` — where the agent constructs the
literal string it wants typed, so the value passes through the agent's own
tool call and transcript — `fill-credential` takes no value argument. The
agent-browser daemon (host-adjacent, per the direct-egress work's shim
design) resolves `site` + `field` against `site_credentials` itself and
injects the value directly into the DOM node behind `@e2`. The agent decides
*where* to click (it can see the page structure via `snapshot`), never
*what* gets typed there.

For the SMS/biometric step: no new tool is needed. The agent reads the
challenge page like a human would (via `snapshot`), sends Daniel a normal
chat message asking for the code, and ends its turn. nanoclaw containers run
continuously (the agent-runner poll loop and the `agent-browser` daemon both
persist independently of any single LLM turn), so the in-progress browser
session is untouched while waiting. Daniel's Telegram reply arrives as a
normal inbound message; the agent picks the conversation back up with full
context of what it asked, types the code via ordinary `agent-browser fill`
(codes are single-use, no injection needed — see §3), and continues.

### 4.4 Session persistence

On successful login, agent-browser's underlying browser context is saved to
`data/v2-sessions/<group>/browser-sites/<site_key>/storage-state.json` (cookies
+ localStorage) — a `group-state` mount, scoped to the group, matching the
existing mount-class rules in `src/drivers/types.ts` (this is ordinary
session state the group owns, not provisioner-issued identity material, so
`group-state` is the correct class, not `identity-material`).

Before starting any login flow, agent-browser checks for a valid saved
session for the target site first (a lightweight "am I still logged in"
probe — e.g., load the site's authenticated landing page and check it didn't
bounce to a login redirect) and reuses it, skipping 4.2/4.3 entirely until
the site invalidates it.

### 4.5 Submission approval

Any agent-browser action shaped like "submit" (the agent's own judgment,
matching how it already recognizes a login challenge) routes through
`requestApproval()` (`src/modules/approvals/primitive.ts`) before the actual
submit click: a new `action: 'bureaucracy_submit'` request, payload
including a human-readable summary of the filled form (site, form fields,
values — the agent constructs this from what it filled, so all approval-card
content is non-credential form data, never a stored secret) and a
screenshot. The admin/owner approval card uses the existing three-button UI
(Approve / Reject / Reject with reason). On approval, `registerApprovalHandler`
resumes the agent, which clicks submit. On reject, the agent reports back
and does not submit.

The pilot (Har HaKesef, read-only) does not exercise this path — it is built
and unit-tested against the approvals primitive's existing contract, but its
first live exercise is the next site that actually submits something.

## 5. Error handling

- **Site changed its login flow / OTP never arrives / session probe fails
  unexpectedly:** the agent reports the failure in chat rather than
  retrying blindly — matches the existing pattern in
  `gromit-mail-calendar`'s Global Constraints (loud failure, no silent data
  loss), applied here as "loud failure, no silent wrong-site-state."
- **Credential fill targets the wrong field:** `fill-credential` refuses
  (returns an error the agent sees, not the value) if the resolved `site` +
  `field` pair has no stored credential — never silently no-ops.
- **Stored session is stale but the probe doesn't catch it** (site accepts
  the cookie but serves a logged-out-looking page for an unrelated reason):
  treated as a normal page-read failure the agent already knows how to
  report; not a special case.

## 6. Testing

- `site_credentials` CRUD: encryption round-trip, per-group scoping (a
  credential for group A is never readable under group B's key), unique
  constraint on (group, site, field).
- The credential-capture interception in the delivery path: a reply to a
  pending capture request never reaches `writeSessionMessage` verbatim (unit
  test asserts the agent-visible content is the opaque confirmation, not the
  raw text).
- `fill-credential`: refuses on missing site/field; on a fixture DOM,
  correctly injects into the targeted node without the value passing through
  any logged argv.
- Session persistence: save/load round-trip of storage state; the "still
  logged in" probe against a fixture page.
- `bureaucracy_submit` approval: request → approve → agent resumes; request →
  reject → agent does not resume with a submit action. Reuses the same test
  patterns as `install_packages`'s existing approval tests.
- Live verification (manual, against the real Har HaKesef site, same
  discipline as this session's browser-direct-egress work): one real
  first-time login (credential fill + real SMS code relay), confirm session
  persists (second run skips login), confirm a forced-invalid session falls
  back to the login flow correctly.

## 7. Open questions carried into the plan

- Exact at-rest encryption mechanism for `site_credentials` (host key file?
  OS keychain? something else) — an implementation-time choice within "must
  not be plaintext on disk," not blocking this design.
- Whether `fill-credential`'s daemon-side resolution needs its own
  short-lived auth to the credential store, or trusts the same host-adjacency
  the direct-egress shim already trusts — worth one focused look during
  planning rather than deciding here.
