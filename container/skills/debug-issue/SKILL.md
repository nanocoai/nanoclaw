---
name: debug-issue
description: Debug an issue end-to-end by reading the thread, then branching based on what's available. Persist large Skyler MCP payloads to workspace files and analyze from them (grep-first, partial reads). If an application_id is in the thread, go straight to per-application analysis (metadata, Langfuse, Grafana, E2B, app files, Vercel). If not, derive log patterns from context, run iterative cluster log searches, and if a prominent application_id emerges, continue with per-application analysis. Otherwise fall back to what evidence is available. Use when the user asks to debug, triage, or investigate an issue without strictly knowing whether it is application-scoped or platform-wide.
compatibility: autopilot
metadata:
  audience: triage
  workflow: debug
---

# Debug Issue via Skyler MCP

Unified debugging flow that adapts to what is available in the message. You may be given an `application_id` upfront, you may have to derive one from cluster log searches, or you may have to debug from what logs return. This skill handles all three paths with one consistent output format.

**Non-interactive by default:** This skill runs autonomously. Do not ask the user for confirmations or for permission to fetch data. Make all decisions from the thread content and the criteria below.

**Ask for clarity only as a last resort:** If after running all applicable steps you still cannot produce a useful analysis (e.g. the question is genuinely ambiguous, multiple equally likely interpretations, no identifiable module or error), you **may** end the output with a short clarifying question — but always present whatever partial analysis you already have first. Never open with a question.

**Self-executing:** If at any point you identify a next debugging step you *can* perform (another pattern to try, another module to inspect, a wider time window, a per-app log fetch), **do it now** instead of listing it as a recommendation. Only include "Next steps" for actions that truly require human access or decisions.

## Workspace layout

| Path | Purpose |
|------|---------|
| `/workspace/agent/debug_evidence/` | Persisted MCP payloads — create on first use |
| `/workspace/agent/output.md` | Final analysis output |

**MCP → workspace:** Large Skyler tool returns (cluster search; orchestrator summary; Langfuse / Grafana / E2B; bulky Vercel payloads) must be persisted with **Write** under `/workspace/agent/debug_evidence/` as soon as they arrive. **Each filename must encode the tool, the query window, and app scope when applicable:** use short tool ids (`cluster_search`, `langfuse`, `grafana`, `e2b`, `orchestrator`, `vercel`, …), then the **`start_time` and `end_time` actually passed** as one filesystem-safe token (compact UTC, e.g. `20260423T120000Z_20260423T130000Z` — strip `:` from ISO if needed), then the **canonical `application_id`** when that tool's args included it. Join segments with `__` so UUID hyphens stay unambiguous (example: `grafana__20260423T120000Z_20260423T130000Z__550e8400-e29b-41d4-a716-446655440000.json`). If the tool has **no** `start_time`/`end_time` (e.g. orchestrator summary), omit the range token. Re-fetch same tool/window/app → add a short suffix (`_r2`, `_b`).

**`debug_evidence/` review:** When that folder has files, use filenames to see which tools and time ranges are already captured; grep or partial read to judge whether that evidence is enough for this incident. If not, run further MCP log fetches, persist new bodies with the same naming rules, and continue from those files.

**Investigation pace:** Take the single most direct path and execute it; do not spin multiple approaches or optional planning before acting. For evidence files: search (grep / partial read) first, then read only the spans you need — avoid full-file reads unless there is no smaller way to get the answer.

## Progress updates

Send a `mcp__nanoclaw__send_message` update at every major step transition — a single sentence: what you're doing and why. For slow operations (metadata fetch, large log pulls, app file download), send an acknowledgment before the call. Do not narrate micro-steps; report meaningful transitions and final outcomes.

---

## Step 1 — Read the incoming message and identify context

### Canonical `application_id`

Accept a value as this skill's `application_id` only if it matches the UUID shape (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) after stripping a leading `app_`. Slugs and other non-UUID strings — even in fields named `application_id` — are not ids; ignore them for Path A / B → Step 3 and MCP. **Apply this same rule everywhere** you read or derive an `application_id`.

**Extract from the user's message:**
- `application_id` — UUID-shaped value only (per **Canonical `application_id`**).
- `environment` — one of `production`, `staging`, `development`, or `dp`. Required for every MCP log call.
  - `production` → `prodx-cluster-us-east-2`
  - `staging` or `dp` → `uatx-cluster-ap-south-1`
- `user_email` — if mentioned.
- **Incident time window** — see below.

If the user references a Slack thread, call `mcp__skyler__get_slack_thread(channel_id=…, thread_ts=…)` to retrieve the full thread before extracting any of the above.

### Identifying the incident time window

The time window is critical — it is passed as `start_time` / `end_time` to every MCP log call. Use the **first matching** source to anchor it:

1. **Explicit timestamps in message content** — Look for dates/times embedded in the text (e.g. `"around 3 PM yesterday"`, `"2026-04-06T12:21:00Z"`). These indicate when the issue was originally observed. Convert to ISO 8601 and add ±30 min buffer.
2. **Slack `thread_ts`** — Only as a **fallback** when the message body has no explicit time. Convert the Unix epoch to ISO 8601 and add ±30 min buffer.
3. **No timestamps at all** — Start with the last 1 hour from the current time.

**Common mistake to avoid:** Do NOT use the thread's creation time when the message body itself contains an earlier timestamp.

**Always derive a concrete `start_time` and `end_time` before calling any MCP log tool.** Do not omit the range. Use a conservative window — at minimum ±30 minutes around the suspected event; expand to ±2 hours when uncertain.

### Decide which path to follow

After Step 1, choose **one** of the three entry paths:

- **Path A — application_id already in message:** Skip straight to **Step 3** (per-application deep dive). Do not do pattern derivation first.
- **Path B — no application_id:** Go to **Step 2** (pattern derivation + cluster log search). If a prominent application_id emerges from the cluster logs, continue into **Step 3**.
- **Path C — pure log / context debugging:** Reached only when Path B's cluster search returns no relevant logs after all refinement rounds AND no application_id is recoverable.

---

## Step 2 — Pattern derivation and cluster log search (Path B)

Run this step only when **no** `application_id` is present in the message.

### 2a. Derive an initial search pattern

Translate the user's description into a search pattern:

1. Identify the error description, API path, or keyword from the message (e.g. `"gallery"`, `"screenshot"`, the API endpoint path).
2. Pick the most distinctive phrase, class name, or error string as the initial pattern.

Move on to 2b as soon as you have a candidate pattern.

### 2b. Call `mcp__skyler__search_cluster_logs` (MANDATORY in Path B)

```
mcp__skyler__search_cluster_logs(
    pattern=<search_pattern>,
    environment=<environment>,
    start_time=<ISO 8601 start>,
    end_time=<ISO 8601 end>
)
```

`pattern` is embedded in a LogQL double-quoted `|=` filter; any `"` in the value is escaped server-side. Prefer a **short** substring; on **400 / parse error**, retry with a shorter pattern (same window).

Note that errors from PM2 / Node.js and many GNU tools use **asymmetric GNU-style quotes** `` `…' `` (left grave + right apostrophe) — copy them verbatim into the pattern.

This queries `{container=~"kite|kite-worker", cluster="<cluster>"}` for the pattern without needing an `application_id`.

### 2c. Iterative refinement loop (up to 5 rounds)

The user's description of an issue often does not match the exact string logged by the platform. Iteratively refine pattern AND window until you find matching logs.

**Window adjustment** (try before changing pattern):

| Attempt | Window | Action |
|---------|--------|--------|
| 1 | Message-derived window (±30 min) | Initial call |
| 2 | Last 2 hours from `end_time` | Widen if ≤ 5 relevant lines |
| 3 | Last 6 hours from `end_time` | Widen further if still sparse |
| 4 | Shift earlier / later | If logs at the window edge are cut off |

- **Shift** the window when results exist but the failure sequence is clearly incomplete at an edge.
- **Widen** the window when there are no results at all.

**Pattern refinement** (when widening does not help, rounds 2–5):

1. Try a related error string, exception class, or API path derived from the user's description.
2. Re-call `mcp__skyler__search_cluster_logs` with the new pattern (and the chosen window).
3. Repeat until you hit ≥ 5 relevant lines **or** you have exhausted 5 rounds.

**Stop conditions (whichever comes first):**
- ≥ 5 relevant log lines found → scan them for `application_id`, `applicationId`, or similar fields; keep only values that satisfy **Canonical `application_id`**. Collect all unique qualifying ids.
  - If at least one id remains → proceed to **Step 3** for that `application_id`.
  - If no application_id can be derived → produce the infrastructure-only analysis (see Output rules).
- 5 refinement rounds exhausted with no results → go to **Step 4**.

---

## Step 3 — Per-application deep dive (Path A, or Path B with application_id discovered)

Run this step when an `application_id` is available — either from the message (Path A) or extracted from cluster logs in Step 2 (Path B).

**When multiple application_ids appear in cluster logs:** pick the one with the most log activity / errors around the incident window, or the one most relevant to the user's question / `user_email`.

### 3a. Fetch application metadata (Path B only — skip in Path A if metadata is already in the message)

Before calling metadata:
- If `environment` is already known from message context, pass it through.
- If `application_url` is present, deduce environment from host:
  - `v2dp<digits>.dp.appsmith.com` → `development` and set `dp_number=<digits>`
  - `staging.kite.ai` → `staging`
  - `kite.ai` → `production`

```
mcp__skyler__get_application_metadata(
    application_id=<application_id>,
    environment=<environment or null>,
    dp_number=<dp_number when v2dp host, else null>
)
```

Use the returned `environment` for all subsequent calls. Note `vercel_project_id`, `vercel_team_id`.

### 3b. Orchestrator conversation context

Call `mcp__skyler__get_latest_orchestrator_summary` **before** the time-scoped log tools in 3c. Use it for what the user was doing and surrounding context; **when the summary implies clearer activity times**, adjust `start_time`/`end_time` for 3c — otherwise keep the Step 1 window.

```
mcp__skyler__get_latest_orchestrator_summary(
    application_id=<application_id>,
    environment=<environment>
)
```

If you need the **full set** of orchestrator observations across the run (errors, retries, every turn), call `mcp__skyler__get_all_orchestrator_observations` instead.

### 3c. Primary debug bundle (fast path)

`mcp__skyler__fetch_all_debug_logs` returns the slim Langfuse trace timeline, full observations, Grafana cluster logs, and E2B sandbox logs in one call. Use this as the first fetch for the incident window; fall back to the individual tools below only if you need a narrower slice or a different time range.

```
mcp__skyler__fetch_all_debug_logs(
    application_id=<application_id>,
    environment=<environment>,
    start_time=<ISO 8601 start>,   # omit to auto-derive from app's Langfuse traces
    end_time=<ISO 8601 end>        # omit to auto-derive from app's Langfuse traces
)
```

When you need per-source granularity or targeted re-fetches, use the individual tools:

```
mcp__skyler__get_langfuse_observations(
    application_id=<application_id>,
    environment=<environment>,
    start_time=<ISO 8601 start>,
    end_time=<ISO 8601 end>
)
```
**What it provides:** All LLM spans, generations, events, workflow traces, errors for this application.
Key fields: `id`, `traceId`, `startTime`, `endTime`, `metadata.workflow_name`, `model`, `level`, `input`, `output`, `usage`.

```
mcp__skyler__get_cluster_logs(
    application_id=<application_id>,
    environment=<environment>,
    start_time=<ISO 8601 start>,
    end_time=<ISO 8601 end>
)
```
**What it provides:** Platform backend logs scoped to this application: HTTP lifecycle, Celery tasks, E2B sandbox ops, LLM interactions, SSE, database.
Key fields: `timestamp`, `requestId`, `level`, `message`, `application_id`, `trace_id`, `exception`.

```
mcp__skyler__get_e2b_sandbox_logs(
    application_id=<application_id>,
    environment=<environment>,
    start_time=<ISO 8601 start>,
    end_time=<ISO 8601 end>
)
```
**What it provides:** Logs from inside the application's E2B sandbox: generated app frontend (Vite/HMR/build errors), backend (Fastify/Pino), Caddy proxy.
Sources: `frontend.log`, `backend.log`, `caddy.log`, `alloy.log`.

### 3d. Application files — generated app source

**Step A — Get the curl command:**
```
mcp__skyler__get_download_app_files_curl_url(
    application_id=<application_id>,
    environment=<environment>,
    extract_path="/workspace/agent/debug_evidence/<application_id>.zip"
)
```

**Step B — Execute immediately** (the embedded auth token expires in ~60s). Retry with a fresh command on HTTP 401.

**Step C — Unzip and explore:**
```bash
mkdir -p /workspace/agent/debug_evidence/<application_id> && unzip -o /workspace/agent/debug_evidence/<application_id>.zip -d /workspace/agent/debug_evidence/<application_id>
```

If `unzip` is missing: `python3 -m zipfile -e /workspace/agent/debug_evidence/<application_id>.zip /workspace/agent/debug_evidence/<application_id>/`

**Step D — Analyze app files:**

1. List top-level to see structure (`docs/`, `frontend/`, `prototype/`, `workpad.json`, `middleware.ts`).
2. For pipeline/artifact issues: `docs/iter{N}/` — `brand_personality.json`, `design_spec.md`, `content_spec.json`, `prototype/index.html`, `prompts-used/`.
3. For UI/runtime issues: `frontend/src/`, `frontend/integrations/`, `middleware.ts`.

**This is not optional when application_id is available.** Always download, unzip, and analyze app files to corroborate errors with generated code. If empty/missing, use logs only.

### 3e. Vercel deployment logs (mandatory evaluation)

**You must autonomously decide** whether to call this — never ask the user. Scan the message and any thread context for any of: deploy, publish, deployment, published, live, hosted, production, vercel, `.vercel.app`, deployment URL, custom domain. Also evaluate whether the error relates to the published/live app vs the E2B sandbox preview. **If any match, call Vercel immediately.**

Call `mcp__skyler__get_vercel(environment=<environment>, tool_name="list_tools")` to discover tools, then use `listDeployments` and `getDeploymentLog` (or other relevant tools) to fetch deployment data for the incident window. Use `vercel_project_id` and `vercel_team_id` from Application Metadata (Path A) or Step 3a (Path B).

**Skip only when all are true:** (a) zero keyword matches in message and thread, (b) no deployment activity in cluster logs near the incident, (c) the issue is strictly sandbox/generation-time with no production context.

### 3f. Targeted re-fetches (if needed)

If the initial window is too narrow, key errors are cut off, or a specific trace needs deep inspection, re-call the Step 3c log tools with an adjusted range. For deep span inspection:

```
mcp__skyler__get_langfuse_observations(
    application_id=<application_id>,
    environment=<environment>,
    start_time=<ISO 8601>,
    end_time=<ISO 8601>,
    trace_id=<optional — for deep span inspection>
)
```

---

## Step 4 — Fallback: no application_id, no cluster log hits

Reached only when:
- Path B's refinement loop exhausted without meaningful cluster log hits, **and**
- No `application_id` could be derived from any source (message, logs, user_email correlation).

At this point retrieval options are exhausted. Focus on what you have:

1. Re-read the message to re-center on what was actually reported.
2. Summarize what was searched, what the patterns were, and what the logs (if any) contained.
3. If partial evidence exists, analyze it: which containers/services, which time range, any common error strings.
4. Propose the most plausible hypothesis and what additional information (application_id, exact time, user email) would allow a definitive answer.

---

## Output rules

### Structure (exact order, exact strings, case-sensitive)

Write a final analysis message to the user via `mcp__nanoclaw__send_message`. Also write the canonical output to `/workspace/agent/output.md` using the following structure:

1. A line with exactly: `###OUTPUT_START###`
2. Blank line
3. Your analysis content
4. Blank line
5. A line with exactly: `###OUTPUT_END###`
6. Blank line
7. **JSON filter block** — `###JSON_OUTPUT_START###` … `###JSON_OUTPUT_END###` (see below)
8. Blank line
9. **MCP call log** (see below)

### JSON filter block (after `###OUTPUT_END###`)

Always emit it — even in Path A and Path C — using the best values you have.

```
###JSON_OUTPUT_START###
{
  "pattern": "<primary search pattern — see below>",
  "environment": "<environment>",
  "range_from": "<ISO 8601 start of the final log search window>",
  "range_to": "<ISO 8601 end of the final log search window>",
  "application_id": "<application_id or null>",
  "user_email": "<user_email or null>"
}
###JSON_OUTPUT_END###
```

How to fill `pattern`:
- **Path B** (cluster log search was run): the pattern that returned the most relevant results.
- **Path A** (no cluster search): use `application_id` as the pattern so the deep link still scopes to this app.
- **Path C / Step 4** (no cluster logs at all): use the most distinctive string from the user's description.

Use the **final** window actually queried / used (after any widening/shifting).

How to fill `application_id` and `user_email`:
- **From context first:** If `application_id` or `user_email` were present in the original message and the id satisfies **Canonical `application_id`**, use them; otherwise `null`.
- **From the debugged application otherwise:** Use the `application_id` this session actually investigated and find the associated `user_email` from those logs.
- Set to `null` only if no application was identified.

### MCP call log (after `###JSON_OUTPUT_END###`)

Append every Skyler MCP tool call made during this run, in chronological order — including calls that errored or returned empty.

```
## MCP Calls
- [<ISO 8601 timestamp>] <tool_name>(<arg1>=<value1>, <arg2>=<value2>, ...)
- [<ISO 8601 timestamp>] <tool_name>(<arg1>=<value1>, ...)
```

This section is for debugging and is not included in the user-facing message.

### Answer shape by scenario

- **Path A — application_id in message (full application analysis):** Full analysis scoped to the application — incident overview, error grouping by cluster, evidence, root cause, execution progress, corroboration with app files. Structure by error clusters: short overview, then what failed, why, evidence, code refs.
- **Path B — application_id discovered from cluster search:** Begin with a brief **Cluster-level context** paragraph (how many apps/lines matched, common error). Then provide per-application analysis like Path A.
- **Path B — no application_id discovered (infrastructure-only):**
  - **Section 1 — Incident summary:** What happened at the cluster level. How many lines matched, which containers/services, time range.
  - **Section 2 — Root cause:** From cluster log evidence. Explain WHY at a code/architecture level.
  - **Section 3 — Affected scope:** Which services / endpoints / log categories. Infrastructure-wide vs localized.
  - **Section 4 — Timeline:** When it started, whether ongoing, whether self-resolved.
  - **Section 5 — Next steps:** Only items requiring human decisions/access.
- **Step 4 — no hits:** Short framing of what was searched and what was found. Most plausible hypothesis. What additional info (application_id, time, user email) would allow a definitive answer. Optionally close with a clarifying question.
- **Focused questions** ("which workflow failed?", "list the trace for 400", "share cloudinary URLs"): Direct, concise — answer only what was asked. No overview, no extra sections. Still process all retrieved data internally.

### Ask-for-clarity fallback (optional)

If after running the applicable steps you genuinely cannot produce a confident analysis, you may end the analysis content with one short clarifying question. Rules:

- Always present whatever partial analysis you have first.
- Never open with the question. Never use it as a substitute for running the skill.
- One question only. Make it specific and answerable in one sentence.

### Content constraints

- **No redundant content:** Say each fact, error, URL, trace, or explanation once.
- **No stack traces.** No `sandbox_id`, `trace_id`, `span_id` unless the question specifically asks.
- **No MCP tool names in output.** Use human-friendly labels: "Cluster logs", "LLM Provider logs", "E2B sandbox logs", "Application files", "Vercel deployment logs".
- **No absolute workspace paths in analysis output.** Use relative filenames or descriptive labels instead of `/workspace/agent/...` paths.

### Referring to missing or empty data (strict)

Never expose MCP tool names, field names, or file paths in the output. Use plain, human-friendly names:

| Source | Do NOT say | Say instead |
|--------|-----------|-------------|
| Cluster logs (pattern search) | "search_cluster_logs returned nothing" | "No cluster logs matched the pattern in the searched window" |
| Per-app cluster logs | "get_cluster_logs failed" | "No Grafana logs found for this application" |
| E2B logs | "get_e2b_sandbox_logs returned nothing" | "There are no E2B logs" or "E2B logs are empty" |
| LLM logs (Langfuse) | "get_langfuse_observations empty" | "There are no LLM Provider logs" |
| App files | curl 401/error | "There are no app files" or "No generated app code is available" |
| Vercel logs | naming MCP errors | If not in scope, silently skip. If in scope but unavailable: "Couldn't retrieve Vercel deployment logs for this incident" |

Keep it brief: one short sentence noting the absence, then move on.

---

## Analysis principles

### RCA and fixes

- **Be skeptical of logs:** A logged error is not automatically the root cause. Verify the error caused the user-observed symptom.
- **First failure vs cascading:** Identify the **first** failure in the timeline; later errors are often cascading. Explain why.
- **Infrastructure vs application:** Distinguish a platform-wide failure (affects all apps) from an application-specific failure (affects one). The path you took (A/B/C) is a hint but not the answer — verify from evidence.
- **Fix suggestions:** (1) **Prompt changes — subtract, don't add.** (2) **Image fixes:** Include before/after Cloudinary URLs. (3) **Minimal change:** Smallest change that resolves the issue. (4) Ask about solution direction when there are real trade-offs.

### Error grouping and attribution (detailed answers only)

For focused questions, skip error clusters; answer only what was asked.

1. Identify distinct errors from Langfuse (`metadata.workflow_name`, `startTime`, `level=ERROR`, `output`), Grafana (`level=ERROR/CRITICAL`, `exception`, `requestId` near the error time), and cluster log search (`message`, `exception`, `level`). When citing errors, reference **LLM Provider logs**, **Grafana logs**, or **Cluster logs** and the **time period** — never MCP tool names or raw JSON field paths.
2. Group related errors only if they share a cause (same workflow/node, same canonical error, same service/endpoint). Do not group different workflows or when time gaps suggest separate incidents.
3. For each cluster: explain WHY using request/response data, Grafana evidence, workflow position, corroboration with app files.

### Log correlation (Grafana and E2B)

- Process Grafana cluster logs and E2B sandbox logs fully so you can answer trace/400/log-line questions.
- For **focused** questions, output only the requested trace(s)/lines. For **detailed** answers, use these logs to confirm failure reason; do not narrate full log timelines.
- Prefer lines showing: command failure, non-zero exit codes, parsing errors, sandbox lifecycle issues, backend exceptions near the error time.

### Timestamped log references when citing Grafana or E2B

When citing log lines from Grafana or E2B in your output, include a timestamped reference.

- **Format:** `grafana_<start>_<end>` or `e2b_<start>_<end>` with **start** and **end** in compact UTC: `YYYYMMDDTHHmmSS` (e.g. `20250115T080000`).
- **Derive start/end from the actual log entry timestamps in the evidence you are citing** — not from the MCP call parameters.
- **Buffer (required):** Subtract **10 seconds** from start and add **10 seconds** to end.
- **Verification:** Buffered start must be ≤ every cited timestamp; buffered end must be ≥ every cited timestamp.
- **Example:** Evidence at `2025-01-15T08:00:00Z` and `2025-01-15T08:05:30Z` → `grafana_20250115T075950_20250115T080540`.
