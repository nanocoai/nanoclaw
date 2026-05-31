#!/usr/bin/env python3
"""
pap.fr fetch-failure log + threshold + Discord-alert dedupe helpers.

PapRentalCFBypassMigration AC 5 (Step 2-D — failure resilience).

Why this module exists
======================
The Seed's `failure_resilience` evaluation principle splits transient and
chronic pap.fr failures:

  * 1회 실패 (transient)        → structured log only · NO Discord alert.
  * `pap_consec_failures ≥ N`    → log AND Discord alert (default N = 3,
                                   `failure_threshold` ontology constant).
  * 한 번 알린 뒤 추가 실패     → 24h 안에는 dedupe — 같은 사이드카 사고로
                                   스팸이 쌓이지 않도록.
  * 다음 성공                   → 카운터 reset, 다음 사이클부터 처음으로.

The container-side skill embeds Python pseudocode in SKILL.md, so the LLM
can wire-up the workflow each cycle. Encapsulating the failure-handling
contract in one importable module gives us:

  * One place to change the structured-log shape (operators grep one
    `event` name across container logs).
  * A self-contained surface that `python3 -m unittest test_pap_failure_log`
    can exercise inside the container, no network or sidecar required.
  * A clean import seam for the SKILL.md `Section C` and `Section 6`
    blocks (no inline-state mutation at the call site).

Public surface
==============
    log_pap_fetch_failure(reason, *, state, threshold, now_iso, stream)
        Increment `state["pap_consec_failures"]`, persist the truncated
        `reason` to `state["pap_last_failure_reason"]`, and emit ONE
        single-line JSON record to `stream` (stderr by default).

    reset_pap_fetch_counter(state)
        Called after a successful pap fetch (pages_done > 0 OR healthy
        empty). Resets counter + last-reason to clean values.

    evaluate_pap_alert(*, state, threshold, now_iso, dedupe_window_s)
        Pure decision function. Returns (should_alert: bool, message: str
        | None). The caller (SKILL.md Section 6) is responsible for
        actually delivering the message via mcp__nanoclaw__send_message
        — this module does not import any messaging API.

    mark_pap_alert_sent(state, now_iso)
        Stamp `state["pap_failure_last_alert"]` so subsequent calls within
        `dedupe_window_s` short-circuit to should_alert=False.

State shape (as persisted by SKILL.md to /workspace/extra/webdav-data/
.paris-rental-seen.json — keys this module touches):

    {
      "pap_consec_failures":      <int, default 0>,
      "pap_last_failure_reason":  <str | None, default None, truncated 300ch>,
      "pap_failure_last_alert":   <iso str | None, default None>
    }

Structured log shape (single-line JSON to stderr — operators grep `event`):

    {
      "event":            "paris-rental-watch.pap.fetch.failure",
      "ts":               "<now_iso>",
      "consec_failures":  <int, post-increment>,
      "threshold":        <int>,
      "reason":           "<truncated 300ch>",
      "will_alert":       <bool>,   # true → this tick crosses threshold
                                    # AND dedupe window is clear → caller
                                    # is expected to fire Discord
    }

The "will_alert" flag mirrors `evaluate_pap_alert`'s decision so an
operator scrolling the container log can tell at a glance whether a
failure was log-only (transient) or escalated. The flag is informational
— the caller MUST still call evaluate_pap_alert before sending a message
(in case the SKILL.md wiring drifts).

Run the tests:
    cd container/skills/paris-rental-watch
    python3 -m unittest test_pap_failure_log -v
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any, IO

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Single source of truth for the structured-log event name. SKILL.md and
# evidence files reference this string so operators can grep one keyword
# across container stderr to find every transient pap.fr failure.
EVENT_PAP_FETCH_FAILURE = "paris-rental-watch.pap.fetch.failure"

# Single source of truth for the structured-log event name we emit when
# the threshold is crossed AND the alert is actually queued.  Distinct
# from the per-failure event so an operator can grep escalations alone.
EVENT_PAP_ALERT_FIRED = "paris-rental-watch.pap.fetch.alert"

# State-key vocabulary. Centralising these makes a future rename (or
# adding a ".bak" key) one diff.
STATE_KEY_CONSEC = "pap_consec_failures"
STATE_KEY_REASON = "pap_last_failure_reason"
STATE_KEY_ALERT_TS = "pap_failure_last_alert"

# Hard upper bound on how much of the failure reason we keep around. The
# reason can carry truncated `web-fetch` stderr (Cloudflare HTML, Python
# tracebacks) — keep it short enough that the state JSON stays readable
# and the log line stays grep-able. SKILL.md uses the same 300ch cap.
REASON_MAX_CHARS = 300

# Default 24h dedupe so a sustained sidecar outage produces ONE alert per
# day, not 24 (assuming the cron is hourly). Callers can override.
DEFAULT_DEDUPE_WINDOW_S = 86400  # 24h


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def _parse_iso(ts: str | None) -> datetime | None:
    """Lenient ISO-8601 parser.

    The skill's `now_iso()` produces `2026-05-10T12:34:56+00:00` — but old
    state files (pre-AC 2) may carry a `Z` suffix or a naive timestamp.
    We accept all three so a state migration is not required just to make
    the dedupe arithmetic work.
    """
    if not ts:
        return None
    # `fromisoformat` accepts +00:00 but not Z prior to 3.11 in some envs;
    # normalise defensively.
    candidate = ts.strip()
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if dt.tzinfo is None:
        # Treat naive as UTC — the skill always produces aware ISO strings,
        # so a naive value means the value pre-dates AC 2. Treating it as
        # UTC means dedupe arithmetic stays monotonic across the boundary.
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _truncate_reason(reason: str | None) -> str:
    """Squash the failure reason to a stable, single-line representation.

    Mirrors what SKILL.md was doing inline (`(reason or "?")[:300]`) but
    additionally collapses internal newlines so a multi-line `web-fetch`
    stderr trace lands on one log line. That keeps the structured log
    grep-friendly: one failure = one line.
    """
    s = (reason or "?").strip()
    s = s.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    if len(s) > REASON_MAX_CHARS:
        s = s[:REASON_MAX_CHARS]
    return s


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def reset_pap_fetch_counter(state: dict[str, Any]) -> None:
    """Reset consecutive-failure tracking after a successful fetch tick.

    A "success" can be either:
      * pages_done > 0 (got at least one page of cards), or
      * a healthy empty response (the site genuinely returned 0 cards on
        page 1 without erroring — last-page-of-pagination behaviour).

    SKILL.md decides which of those to call; this helper just clears the
    persisted counter and last-reason. We deliberately do NOT clear
    `pap_failure_last_alert` — its 24h dedupe should survive the
    next-cycle recovery so a flapping sidecar (fail / recover / fail) can
    not re-spam Discord every cron tick.
    """
    state[STATE_KEY_CONSEC] = 0
    state[STATE_KEY_REASON] = None


def log_pap_fetch_failure(
    reason: str | None,
    *,
    state: dict[str, Any],
    threshold: int,
    now_iso: str,
    stream: IO[str] | None = None,
    dedupe_window_s: int = DEFAULT_DEDUPE_WINDOW_S,
) -> dict[str, Any]:
    """Record a single web-fetch ok=false (or rc≠0) tick.

    Effects:
      * `state[STATE_KEY_CONSEC]` += 1
      * `state[STATE_KEY_REASON]` ← truncated `reason`
      * One JSON line emitted to `stream` (stderr by default).

    Returns the dict that was logged so callers (and tests) can assert
    on the exact shape without re-parsing stderr.

    The Seed contract: a single failure must NOT alert. This helper
    therefore never delivers a Discord message — it just persists state
    and logs. The caller follows up with `evaluate_pap_alert` after all
    sources have run (SKILL.md Section 6) to decide whether to escalate.
    """
    if stream is None:
        stream = sys.stderr

    # Increment the counter FIRST so the log line reflects the post-failure
    # value (matches operator intuition — "this is the Nth failure").
    current = int(state.get(STATE_KEY_CONSEC, 0) or 0)
    new_count = current + 1
    state[STATE_KEY_CONSEC] = new_count
    state[STATE_KEY_REASON] = _truncate_reason(reason)

    # Compute the dedupe-aware will_alert prediction. This is the same
    # decision evaluate_pap_alert will make at the end of the cycle —
    # we surface it on the log line so an operator does not have to
    # re-read 200 lines of skill output to know "did this tick alert?"
    will_alert, _ = evaluate_pap_alert(
        state=state,
        threshold=threshold,
        now_iso=now_iso,
        dedupe_window_s=dedupe_window_s,
    )

    record = {
        "event": EVENT_PAP_FETCH_FAILURE,
        "ts": now_iso,
        "consec_failures": new_count,
        "threshold": int(threshold),
        "reason": state[STATE_KEY_REASON],
        "will_alert": bool(will_alert),
    }
    # `ensure_ascii=False` keeps non-ASCII reasons (e.g. "잠시만 기다려주세요")
    # readable in the log without surrogate escapes. `separators` keeps the
    # line compact so a typical record fits in one terminal row.
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    stream.write(line + "\n")
    try:
        stream.flush()
    except (AttributeError, OSError):
        # Best effort — a closed/non-flushable stream still got the write.
        pass
    return record


def evaluate_pap_alert(
    *,
    state: dict[str, Any],
    threshold: int,
    now_iso: str,
    dedupe_window_s: int = DEFAULT_DEDUPE_WINDOW_S,
) -> tuple[bool, str | None]:
    """Decide whether to fire a Discord alert for chronic pap.fr failure.

    Returns (should_alert, message). When should_alert is False, message
    is None. When True, message is a Korean-prefixed Discord card with
    the consec count, threshold, and last reason — suitable to pass to
    `mcp__nanoclaw__send_message(target_jid="dc:1485303434541273220",
    message=...)`.

    Decision matrix:
      * consec < threshold         → (False, None) — transient, log only.
      * consec >= threshold AND
        last_alert IS None         → (True, message) — first escalation.
      * consec >= threshold AND
        now − last_alert > window  → (True, message) — past 24h dedupe.
      * consec >= threshold AND
        now − last_alert ≤ window  → (False, None) — within dedupe.

    The message itself is intentionally short and operator-actionable —
    "page X failed because Y, sidecar likely needs attention" — not a
    full failure history. SKILL.md's bookkeeping makes the history
    available in `state["pap_last_failure_reason"]` and the structured
    log on stderr.
    """
    consec = int(state.get(STATE_KEY_CONSEC, 0) or 0)
    if consec < int(threshold):
        return False, None

    last_alert_dt = _parse_iso(state.get(STATE_KEY_ALERT_TS))
    now_dt = _parse_iso(now_iso)
    if last_alert_dt is not None and now_dt is not None:
        delta_s = (now_dt - last_alert_dt).total_seconds()
        if delta_s <= float(dedupe_window_s):
            return False, None

    reason = state.get(STATE_KEY_REASON) or "?"
    msg = (
        f"⚠️ pap.fr 페치 {consec}회 연속 실패 (≥{threshold}). "
        f"cf-fetch-server 점검 필요.\n사유: {reason}"
    )
    return True, msg


def mark_pap_alert_sent(state: dict[str, Any], now_iso: str) -> dict[str, Any]:
    """Stamp the dedupe timestamp after a Discord alert is delivered.

    Also emits a single-line JSON `paris-rental-watch.pap.fetch.alert`
    record on stderr so the escalation is searchable independently of
    the per-tick failure events. Returns the logged record (for tests).
    """
    state[STATE_KEY_ALERT_TS] = now_iso
    record = {
        "event": EVENT_PAP_ALERT_FIRED,
        "ts": now_iso,
        "consec_failures": int(state.get(STATE_KEY_CONSEC, 0) or 0),
        "reason": state.get(STATE_KEY_REASON) or "?",
    }
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    sys.stderr.write(line + "\n")
    try:
        sys.stderr.flush()
    except (AttributeError, OSError):
        pass
    return record


# ---------------------------------------------------------------------------
# Self-test (mirrors the unit-test core so install.sh smoke-tests work)
# ---------------------------------------------------------------------------


def _selftest() -> int:
    """Tiny embedded self-test invoked via `python3 pap_failure_log.py
    --self-test`. Returns 0 on success, 1 on the first assertion miss.

    This does NOT replace test_pap_failure_log.py — it is a lightweight
    sanity check we can run from inside the container before relying on
    unittest discovery (e.g. early in container/build.sh).
    """
    import io

    # 1. First failure → counter=1, will_alert=False (threshold=3)
    state: dict[str, Any] = {}
    buf = io.StringIO()
    rec = log_pap_fetch_failure(
        "page 1 web-fetch rc=3: bla",
        state=state,
        threshold=3,
        now_iso="2026-05-10T12:00:00+00:00",
        stream=buf,
    )
    assert rec["consec_failures"] == 1, rec
    assert rec["will_alert"] is False, rec
    assert state[STATE_KEY_CONSEC] == 1

    # 2. Second failure → counter=2, will_alert=False
    rec = log_pap_fetch_failure(
        "page 1 web-fetch rc=3: bla",
        state=state,
        threshold=3,
        now_iso="2026-05-10T13:00:00+00:00",
        stream=buf,
    )
    assert rec["consec_failures"] == 2, rec
    assert rec["will_alert"] is False, rec

    # 3. Third failure → counter=3, will_alert=True (threshold reached)
    rec = log_pap_fetch_failure(
        "page 1 web-fetch rc=3: bla",
        state=state,
        threshold=3,
        now_iso="2026-05-10T14:00:00+00:00",
        stream=buf,
    )
    assert rec["consec_failures"] == 3, rec
    assert rec["will_alert"] is True, rec

    # 4. evaluate_pap_alert → should_alert True, message non-empty
    fire, msg = evaluate_pap_alert(
        state=state, threshold=3, now_iso="2026-05-10T14:00:00+00:00"
    )
    assert fire is True
    assert msg and "3회 연속 실패" in msg

    # 5. mark_pap_alert_sent + within dedupe → should_alert False
    mark_pap_alert_sent(state, "2026-05-10T14:00:00+00:00")
    fire, msg = evaluate_pap_alert(
        state=state, threshold=3, now_iso="2026-05-10T15:00:00+00:00"
    )
    assert fire is False, "dedupe not enforced"
    assert msg is None

    # 6. Past dedupe window → should_alert True again
    fire, msg = evaluate_pap_alert(
        state=state, threshold=3, now_iso="2026-05-11T14:00:01+00:00"
    )
    assert fire is True

    # 7. reset_pap_fetch_counter clears counter+reason but NOT alert ts
    reset_pap_fetch_counter(state)
    assert state[STATE_KEY_CONSEC] == 0
    assert state[STATE_KEY_REASON] is None
    assert state[STATE_KEY_ALERT_TS] == "2026-05-10T14:00:00+00:00"

    # 8. After reset, evaluate_pap_alert returns False (consec back to 0)
    fire, msg = evaluate_pap_alert(
        state=state, threshold=3, now_iso="2026-05-11T15:00:00+00:00"
    )
    assert fire is False

    # 9. Truncation cap holds
    long_reason = "x" * (REASON_MAX_CHARS + 100)
    rec = log_pap_fetch_failure(
        long_reason,
        state=state,
        threshold=3,
        now_iso="2026-05-12T00:00:00+00:00",
        stream=buf,
    )
    assert len(rec["reason"]) == REASON_MAX_CHARS

    print("pap_failure_log self-test: OK (9 cases)")
    return 0


if __name__ == "__main__":  # pragma: no cover
    if "--self-test" in sys.argv[1:]:
        raise SystemExit(_selftest())
    print(__doc__)
