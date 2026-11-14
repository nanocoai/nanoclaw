# Question design for typesafe-judge

Condensed from the TypeSafe docs (https://docs.typesafe.ai: primitives,
confidence, patterns/fan-out, patterns/confidence-routing). Read those pages
when designing a new workflow; this file is the working summary.

## The request

```json
{
  "state": "<string | object | array>",
  "model": "jev-latest",
  "questions": {
    "<id you choose>": { "type": "noul|choice|score", "instructions": "...", "criteria": ... }
  }
}
```

- `state` is everything the questions may need: source text, identities,
  relationships, policies, current facts. Prefer a JSON object with named fields
  over one long string when the context has several parts.
- Every question sees the same state, is evaluated independently, and returns
  under the same id. Ids are not sent to the model.
- Roughly 32,000 tokens (about 150,000 characters) are shared by the state and
  all questions in one request. Truncate long bodies before sending.

## The three primitives

### noul (yes/no)

```json
{ "type": "noul", "instructions": "Does `body` request a refund?", "criteria": { "true": "...", "false": "..." } }
```

Answer: `{ "noul": 0.92 }`, the probability that the answer is yes. No
separate confidence. Use one noul per label when several labels may apply at
once. Define the condition precisely; a vague "is this strong?" gives an
uninterpretable 0.5.

### choice (one of a set)

```json
{ "type": "choice", "instructions": "Which team should handle `ticket`?", "criteria": { "billing": "Payments, refunds", "technical": "Bugs, outages", "other": "Anything else" } }
```

Answer: `{ "choice": "technical", "probabilities": { ... }, "confidence": 0.82 }`.
One line of rubric per option, written so a maintainer would file it there.
Add an `other` / `none` option when the list may not cover the input; the
model cannot pick an option you did not list.

### score (position on ordered levels)

```json
{ "type": "score", "instructions": "How urgent is `issue` for maintainers?", "criteria": ["Low: ...", "Medium: ...", "High: ...", "Critical: ..."] }
```

Answer: `{ "score": 1.6, "legend": { "0": "Low: ...", ... }, "probabilities": { "0": 0.05, ... }, "confidence": 0.78 }`.
Levels must describe concrete situations and stand on their own. Round the
score half-up to a level (`--gate` does this in `gate.level`), or keep the raw
score for ranking.

## Confidence

`confidence` (choice and score) collapses the shape of `probabilities` into
0–1: concentrated on one outcome is high, spread out is low. It summarizes
how peaked the answer is, not whether the workflow is correct. Three ranges:

- high: act automatically
- medium: proceed with caution — propose, confirm, or gather more
- low: do not act — route to a person

Thresholds scale with risk: a read-only action can act at a lower confidence
than a destructive one. Start conservative, measure on real items, adjust.

## Patterns

**Speculative fan-out.** Ask every question the workflow might need in one
call, including ones whose answer only matters for some inputs (a bug's
severity when you do not yet know it is a bug). Code decides which answers to
use. A second request is only warranted when the first answer is needed to
fetch more evidence or to build the next question's options.

**Confidence-gated routing.** Route on the answer, gate on the confidence.
Below a floor, route to a human regardless of the answer; above it, each action
has its own bar.

**Composite scoring.** Score independent dimensions separately (severity,
frustration, evidence quality) and weight them in code. Changing a weight does
not need another inference.

**Verify and escalate.** Ask a noul per claim against its evidence; send the
uncertain ones to a person or to your own reasoning.

## Errors

| Status | Meaning | CLI behavior |
|---|---|---|
| 401 / 403 | Credential missing or rejected at the gateway | exit 2, no retry |
| 422 | Malformed request; body names the field | exit 3 with the body excerpt |
| 429 / 529 | Rate limited / overloaded | retried with backoff, then exit 3 |
