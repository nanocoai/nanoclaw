#!/usr/bin/env python3
"""
Unit tests for pap_failure_log — Step 2-D failure-resilience contract.

Stdlib-only (unittest) so the container — which has no pytest by default —
can run the suite with `python3 -m unittest test_pap_failure_log -v`.

Coverage matrix (PapRentalCFBypassMigration AC 5):

  * Single failure → counter=1, structured log emitted, NO Discord
    alert decision.
  * Two consecutive failures → counter=2, log emitted, still NO alert.
  * Three consecutive failures (threshold) → counter=3, log emitted,
    will_alert=True, evaluate_pap_alert returns (True, message).
  * After mark_pap_alert_sent — subsequent failures within dedupe
    window log only (no second Discord card).
  * Past dedupe window → next over-threshold failure realerts.
  * reset_pap_fetch_counter on success clears counter+reason but
    preserves dedupe timestamp (sustained-flapping protection).
  * Reason truncation cap (300ch) is honoured for both the persisted
    state and the structured-log line.
  * Newline collapsing in the reason keeps the log line single-line.
  * Old/legacy ISO strings (`Z`-suffix, naive) parse cleanly so dedupe
    arithmetic works across the AC 2 state-shape boundary.

Run:
    cd container/skills/paris-rental-watch
    python3 -m unittest test_pap_failure_log -v
"""
from __future__ import annotations

import io
import json
import os
import sys
import unittest

# Hyphenated parent path → always patch sys.path before importing.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pap_failure_log import (  # noqa: E402
    DEFAULT_DEDUPE_WINDOW_S,
    EVENT_PAP_ALERT_FIRED,
    EVENT_PAP_FETCH_FAILURE,
    REASON_MAX_CHARS,
    STATE_KEY_ALERT_TS,
    STATE_KEY_CONSEC,
    STATE_KEY_REASON,
    evaluate_pap_alert,
    log_pap_fetch_failure,
    mark_pap_alert_sent,
    reset_pap_fetch_counter,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _empty_state() -> dict:
    """A fresh state mirroring what SKILL.md Section 1 seeds."""
    return {
        STATE_KEY_CONSEC: 0,
        STATE_KEY_REASON: None,
        STATE_KEY_ALERT_TS: None,
    }


def _parse_log_lines(buf: io.StringIO) -> list[dict]:
    """Return every structured-log record the helper emitted."""
    out = []
    for line in buf.getvalue().splitlines():
        line = line.strip()
        if not line:
            continue
        out.append(json.loads(line))
    return out


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class SingleFailure(unittest.TestCase):
    """Seed: 1회 실패 → log only, no Discord."""

    def test_first_failure_logs_but_does_not_alert(self):
        state = _empty_state()
        buf = io.StringIO()
        log_pap_fetch_failure(
            "page 1 web-fetch rc=3: sidecar 503",
            state=state,
            threshold=3,
            now_iso="2026-05-10T12:00:00+00:00",
            stream=buf,
        )
        self.assertEqual(state[STATE_KEY_CONSEC], 1)
        self.assertEqual(
            state[STATE_KEY_REASON], "page 1 web-fetch rc=3: sidecar 503"
        )
        records = _parse_log_lines(buf)
        self.assertEqual(len(records), 1)
        rec = records[0]
        self.assertEqual(rec["event"], EVENT_PAP_FETCH_FAILURE)
        self.assertEqual(rec["consec_failures"], 1)
        self.assertEqual(rec["threshold"], 3)
        self.assertFalse(rec["will_alert"])

    def test_first_failure_evaluate_alert_returns_false(self):
        state = _empty_state()
        log_pap_fetch_failure(
            "transient",
            state=state,
            threshold=3,
            now_iso="2026-05-10T12:00:00+00:00",
            stream=io.StringIO(),
        )
        fire, msg = evaluate_pap_alert(
            state=state, threshold=3, now_iso="2026-05-10T12:00:01+00:00"
        )
        self.assertFalse(fire)
        self.assertIsNone(msg)


class CrossingThreshold(unittest.TestCase):
    """Seed: 연속 실패 임계 N=3 초과 시에만 Discord 알림."""

    def test_three_consecutive_failures_cross_threshold(self):
        state = _empty_state()
        buf = io.StringIO()
        for n, ts in enumerate(
            [
                "2026-05-10T12:00:00+00:00",
                "2026-05-10T13:00:00+00:00",
                "2026-05-10T14:00:00+00:00",
            ],
            start=1,
        ):
            log_pap_fetch_failure(
                f"page {n} fail",
                state=state,
                threshold=3,
                now_iso=ts,
                stream=buf,
            )
        self.assertEqual(state[STATE_KEY_CONSEC], 3)
        records = _parse_log_lines(buf)
        self.assertEqual([r["consec_failures"] for r in records], [1, 2, 3])
        self.assertEqual(
            [r["will_alert"] for r in records], [False, False, True]
        )
        fire, msg = evaluate_pap_alert(
            state=state, threshold=3, now_iso="2026-05-10T14:00:00+00:00"
        )
        self.assertTrue(fire)
        self.assertIsNotNone(msg)
        self.assertIn("3회 연속 실패", msg)
        self.assertIn("≥3", msg)

    def test_threshold_two_alerts_on_second_failure(self):
        """Threshold is configurable. With threshold=2 we alert at 2."""
        state = _empty_state()
        buf = io.StringIO()
        log_pap_fetch_failure(
            "f1", state=state, threshold=2,
            now_iso="2026-05-10T12:00:00+00:00", stream=buf,
        )
        rec_first = _parse_log_lines(buf)[-1]
        self.assertFalse(rec_first["will_alert"])
        log_pap_fetch_failure(
            "f2", state=state, threshold=2,
            now_iso="2026-05-10T12:30:00+00:00", stream=buf,
        )
        rec_second = _parse_log_lines(buf)[-1]
        self.assertTrue(rec_second["will_alert"])
        fire, _ = evaluate_pap_alert(
            state=state, threshold=2, now_iso="2026-05-10T12:30:00+00:00"
        )
        self.assertTrue(fire)


class DedupeBehavior(unittest.TestCase):
    """Seed: 한 번 알린 뒤 24h 안 추가 실패는 dedupe."""

    def _push_to_threshold(self, state: dict, ts: str, threshold: int = 3) -> None:
        for _ in range(threshold):
            log_pap_fetch_failure(
                "fail", state=state, threshold=threshold,
                now_iso=ts, stream=io.StringIO(),
            )

    def test_alert_dedup_within_24h_window(self):
        state = _empty_state()
        self._push_to_threshold(state, "2026-05-10T14:00:00+00:00")
        # Mark first alert.
        mark_pap_alert_sent(state, "2026-05-10T14:00:00+00:00")

        # 4th failure 1h later — still within dedupe.
        buf = io.StringIO()
        rec = log_pap_fetch_failure(
            "fail",
            state=state,
            threshold=3,
            now_iso="2026-05-10T15:00:00+00:00",
            stream=buf,
        )
        self.assertEqual(rec["consec_failures"], 4)
        self.assertFalse(
            rec["will_alert"], "dedupe should suppress will_alert"
        )
        fire, _ = evaluate_pap_alert(
            state=state, threshold=3, now_iso="2026-05-10T15:00:00+00:00"
        )
        self.assertFalse(fire)

    def test_alert_realerts_past_dedupe_window(self):
        state = _empty_state()
        self._push_to_threshold(state, "2026-05-10T14:00:00+00:00")
        mark_pap_alert_sent(state, "2026-05-10T14:00:00+00:00")

        # 24h + 1s later → should realert.
        future = "2026-05-11T14:00:01+00:00"
        rec = log_pap_fetch_failure(
            "fail",
            state=state,
            threshold=3,
            now_iso=future,
            stream=io.StringIO(),
        )
        self.assertTrue(rec["will_alert"])
        fire, msg = evaluate_pap_alert(
            state=state, threshold=3, now_iso=future
        )
        self.assertTrue(fire)
        self.assertIn("연속 실패", msg)

    def test_custom_dedupe_window(self):
        """A 1h window lets the second alert fire after 70min."""
        state = _empty_state()
        for _ in range(3):
            log_pap_fetch_failure(
                "fail", state=state, threshold=3,
                now_iso="2026-05-10T14:00:00+00:00", stream=io.StringIO(),
                dedupe_window_s=3600,
            )
        mark_pap_alert_sent(state, "2026-05-10T14:00:00+00:00")
        fire, _ = evaluate_pap_alert(
            state=state, threshold=3,
            now_iso="2026-05-10T14:30:00+00:00",
            dedupe_window_s=3600,
        )
        self.assertFalse(fire, "30min later, still within 1h window")
        fire, _ = evaluate_pap_alert(
            state=state, threshold=3,
            now_iso="2026-05-10T15:10:00+00:00",
            dedupe_window_s=3600,
        )
        self.assertTrue(fire, "70min later, past 1h window")

    def test_legacy_z_suffix_iso_parses(self):
        """Pre-AC2 state may carry `2026-05-10T14:00:00Z` — must still
        compare correctly against an aware now_iso."""
        state = _empty_state()
        for _ in range(3):
            log_pap_fetch_failure(
                "fail", state=state, threshold=3,
                now_iso="2026-05-10T14:00:00+00:00", stream=io.StringIO(),
            )
        state[STATE_KEY_ALERT_TS] = "2026-05-10T14:00:00Z"
        # 1h after the Z-suffixed timestamp → dedupe must hold.
        fire, _ = evaluate_pap_alert(
            state=state, threshold=3,
            now_iso="2026-05-10T15:00:00+00:00",
        )
        self.assertFalse(fire)

    def test_naive_iso_treated_as_utc(self):
        state = _empty_state()
        for _ in range(3):
            log_pap_fetch_failure(
                "fail", state=state, threshold=3,
                now_iso="2026-05-10T14:00:00+00:00", stream=io.StringIO(),
            )
        state[STATE_KEY_ALERT_TS] = "2026-05-10T14:00:00"  # no tz
        fire, _ = evaluate_pap_alert(
            state=state, threshold=3,
            now_iso="2026-05-10T15:00:00+00:00",
        )
        self.assertFalse(fire, "naive should still dedupe vs aware")


class CounterReset(unittest.TestCase):
    """Seed: 다음 성공 시 카운터 reset."""

    def test_reset_clears_counter_and_reason(self):
        state = {
            STATE_KEY_CONSEC: 5,
            STATE_KEY_REASON: "old reason",
            STATE_KEY_ALERT_TS: "2026-05-10T14:00:00+00:00",
        }
        reset_pap_fetch_counter(state)
        self.assertEqual(state[STATE_KEY_CONSEC], 0)
        self.assertIsNone(state[STATE_KEY_REASON])

    def test_reset_preserves_alert_timestamp(self):
        """Sustained flapping (fail / recover / fail) must NOT re-spam."""
        state = {
            STATE_KEY_CONSEC: 5,
            STATE_KEY_REASON: "old",
            STATE_KEY_ALERT_TS: "2026-05-10T14:00:00+00:00",
        }
        reset_pap_fetch_counter(state)
        self.assertEqual(state[STATE_KEY_ALERT_TS], "2026-05-10T14:00:00+00:00")

    def test_after_reset_alert_not_fired(self):
        """A successful tick clears the counter, so evaluate_pap_alert
        returns False even if dedupe window has passed."""
        state = _empty_state()
        for _ in range(3):
            log_pap_fetch_failure(
                "fail", state=state, threshold=3,
                now_iso="2026-05-10T14:00:00+00:00", stream=io.StringIO(),
            )
        mark_pap_alert_sent(state, "2026-05-10T14:00:00+00:00")
        # Recovery — pap fetch succeeds.
        reset_pap_fetch_counter(state)
        # 25h later, no further failures.
        fire, _ = evaluate_pap_alert(
            state=state, threshold=3,
            now_iso="2026-05-11T15:00:00+00:00",
        )
        self.assertFalse(fire)


class ReasonHandling(unittest.TestCase):
    """Operational sanity — reason field stays grep-friendly."""

    def test_reason_truncation(self):
        state = _empty_state()
        long_reason = "x" * (REASON_MAX_CHARS + 50)
        rec = log_pap_fetch_failure(
            long_reason, state=state, threshold=3,
            now_iso="2026-05-10T14:00:00+00:00", stream=io.StringIO(),
        )
        self.assertEqual(len(state[STATE_KEY_REASON]), REASON_MAX_CHARS)
        self.assertEqual(len(rec["reason"]), REASON_MAX_CHARS)

    def test_newlines_collapsed(self):
        state = _empty_state()
        multi = "page 1 fail\nTraceback (most recent call last):\n  File ..."
        rec = log_pap_fetch_failure(
            multi, state=state, threshold=3,
            now_iso="2026-05-10T14:00:00+00:00", stream=io.StringIO(),
        )
        self.assertNotIn("\n", rec["reason"])
        self.assertIn("Traceback", rec["reason"])

    def test_none_reason_falls_back_to_question_mark(self):
        state = _empty_state()
        rec = log_pap_fetch_failure(
            None, state=state, threshold=3,
            now_iso="2026-05-10T14:00:00+00:00", stream=io.StringIO(),
        )
        self.assertEqual(rec["reason"], "?")
        self.assertEqual(state[STATE_KEY_REASON], "?")

    def test_log_line_is_single_line_json(self):
        state = _empty_state()
        buf = io.StringIO()
        log_pap_fetch_failure(
            "fail", state=state, threshold=3,
            now_iso="2026-05-10T14:00:00+00:00", stream=buf,
        )
        contents = buf.getvalue()
        # Exactly one trailing newline; no embedded newlines on the JSON.
        self.assertTrue(contents.endswith("\n"))
        self.assertEqual(contents.count("\n"), 1)


class AlertEventLog(unittest.TestCase):
    """`mark_pap_alert_sent` emits a separate searchable event."""

    def test_alert_event_emitted_to_stderr(self):
        state = _empty_state()
        for _ in range(3):
            log_pap_fetch_failure(
                "fail", state=state, threshold=3,
                now_iso="2026-05-10T14:00:00+00:00", stream=io.StringIO(),
            )
        # Capture stderr while we mark.
        buf = io.StringIO()
        old = sys.stderr
        sys.stderr = buf
        try:
            mark_pap_alert_sent(state, "2026-05-10T14:00:00+00:00")
        finally:
            sys.stderr = old
        records = _parse_log_lines(buf)
        self.assertEqual(len(records), 1)
        rec = records[0]
        self.assertEqual(rec["event"], EVENT_PAP_ALERT_FIRED)
        self.assertEqual(rec["consec_failures"], 3)
        self.assertEqual(state[STATE_KEY_ALERT_TS], "2026-05-10T14:00:00+00:00")


class DefaultDedupeWindow(unittest.TestCase):
    """Default window is 24h."""

    def test_default_is_24h(self):
        self.assertEqual(DEFAULT_DEDUPE_WINDOW_S, 86400)


if __name__ == "__main__":  # pragma: no cover
    unittest.main(verbosity=2)
