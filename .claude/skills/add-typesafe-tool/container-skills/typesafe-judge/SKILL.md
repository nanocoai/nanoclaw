---
name: typesafe-judge
description: Ask TypeSafe's Jev decision model for a typed judgment instead of reasoning it out yourself. Use for every classification, routing, ranking, verification, or yes/no call — pick a label, choose a handler, rate urgency, check whether two things match, decide whether a condition holds. Returns probabilities and confidence, never text. You still do the reasoning and writing around the answer.
---

# typesafe-judge

You have a "System One" decision model, TypeSafe Jev, reachable through the
`typesafe-judge` CLI. It answers small, well-defined questions about a piece of
state with typed, calibrated answers: a probability, a chosen option with a
distribution, or a position on a scale. It does not generate text and it does
not reason. You reason, gather evidence, and write; Jev makes the snap
judgments a knowledgeable person makes in a second.

## When to ask Jev instead of deciding yourself

Ask Jev whenever the decision is one of these, and act on its answer:

| Decision shape | Primitive | Example |
|---|---|---|
| Is this true? (yes/no) | `noul` | "Does `body` contain reproduction steps?" |
| Which one of these? (route, classify, label) | `choice` | "Which `area/*` label fits this issue?" |
| How much? (rank, prioritize, grade) | `score` | "How urgent is this for maintainers?" |
| Same or different? (dedupe, verify, match) | `noul` per candidate | "Does `candidate` report the same defect as `issue`?" |

Do it yourself when the task is reasoning, synthesis, or writing: explaining a
diff, drafting a comment, summarizing a thread, planning a fix. Use Jev to
decide *what* to do; use your own judgment for *how* to say it.

Rules of thumb from the TypeSafe docs:

- One narrow judgment per question. "Is this urgent?" is good. "Analyze this and
  pick the best course of action" is not: split it into questions and combine
  the answers in your own logic.
- Send every question about the same state in **one call** (fan-out). Questions
  run in parallel, cost only their own tokens, and cannot see each other. Ask
  speculative questions too and ignore the answers you do not need.
- Give the state everything the question needs, as named JSON fields. Reference
  fields in the instructions with backticked paths: `` `body` ``, `` `changed_files` ``.
- Include a no-match option in a `choice` when nothing may fit. A noul near 0.5
  means "as likely yes as no", not "medium".
- Question ids are for you; the model never sees them. Put the full question in
  `instructions`.

## Running it

The CLI lives at `/app/skills/typesafe-judge/scripts/typesafe-judge.ts` and runs
under `bun`. Define this once per session:

```bash
alias typesafe-judge='bun /app/skills/typesafe-judge/scripts/typesafe-judge.ts'
```

Feed it `{state, questions}` JSON on stdin (or `--input file.json`) and read the
answers as JSON on stdout:

```bash
cat > /tmp/req.json <<'EOF'
{
  "state": { "title": "Container never starts after update", "body": "Ran nanoclaw.sh, then ... docker: exit 137" },
  "questions": {
    "kind": {
      "type": "choice",
      "instructions": "What kind of report is this, judging from `title` and `body`?",
      "criteria": { "kind/bug": "A defect, crash or regression", "kind/feature": "A request for new behavior", "kind/question": "A usage question" }
    },
    "priority": {
      "type": "score",
      "instructions": "How urgent is this for maintainers, judging from the impact in `body`?",
      "criteria": ["Low: cosmetic or rare", "Medium: real defect with a workaround", "High: core flow broken, no workaround", "Critical: data loss or nothing runs"]
    },
    "has_repro": {
      "type": "noul",
      "instructions": "Does `body` include concrete reproduction steps, exact error text, or a log excerpt?"
    }
  }
}
EOF
typesafe-judge --input /tmp/req.json --gate
```

Shorthand flags build one question of each type without writing JSON:

```bash
typesafe-judge --state @item.json \
  --noul "Does `body` report a defect that a maintainer could act on?" \
  --choice "Which team owns this?" --options "core:host code|skills:skill packages|docs:documentation" \
  --score "How urgent?" --levels "low|medium|high|critical" \
  --gate
```

Output shape (`--compact` for one line):

```json
{
  "model": "jev-latest",
  "answers": {
    "kind": { "type": "choice", "choice": "kind/bug", "probabilities": { "kind/bug": 0.9, "...": 0.1 }, "confidence": 0.86 },
    "priority": { "type": "score", "score": 2.3, "legend": { "0": "Low: ...", "3": "Critical: ..." }, "probabilities": { "...": 0.1 }, "confidence": 0.71 },
    "has_repro": { "type": "noul", "noul": 0.93 }
  },
  "usage": { "input_tokens": 512, "output_tokens": 60 },
  "gate": {
    "kind": { "decision": "act", "certainty": 0.86, "value": "kind/bug" },
    "priority": { "decision": "propose", "certainty": 0.71, "value": 2.3, "level": { "index": 2, "text": "High: ..." } },
    "has_repro": { "decision": "act", "certainty": 0.93, "value": true }
  }
}
```

## The gate: act, propose, withhold

`--gate` turns each answer into one of three decisions so your workflow can be
consistent about risk:

| Decision | Meaning | What you do |
|---|---|---|
| `act` | The model is sure. | Apply the label, route the item, take the reversible action. |
| `propose` | Reasonable answer, not certain. | Do not apply. Write the proposal where a human will see it (a comment, a digest line) with the certainty. |
| `withhold` | Not enough signal. | Do nothing with this answer; mark the item for human triage. |

Default thresholds (override with `--act`, `--propose`, `--noul-act`,
`--noul-propose`): choice/score act at confidence ≥ 0.8 and propose at ≥ 0.6;
noul act when max(p, 1−p) ≥ 0.85 and propose at ≥ 0.7. These came from
measured triage runs on nanocoai/nanoclaw, where 0.6 (choice/score) and 0.7
(noul) were the proposal floors. Raise the `act` thresholds for anything hard to
reverse; a read-only action can use lower ones. Thresholds are yours to tune;
the raw probabilities are always in the output.

For a noul, `gate.value` is the yes/no reading (`p >= 0.5`) and `certainty` is
how far from 0.5 it is. For a score, `gate.level` is the nearest level with its
legend text, so a priority score maps to a label without arithmetic.

## Credentials

Never look for, ask for, or handle a TypeSafe API key. The request carries the
placeholder `Authorization: Bearer placeholder`; the credential gateway swaps
in the real key at the network edge. If the CLI exits with code 2 (a 401/403),
the key is not connected: tell the user an operator must run
`/add-typesafe-tool` on the host to store the api.typesafe.ai credential, then
retry. Exit code 3 is an upstream or network failure (the CLI already retried
429/529 with backoff); report it, do not loop.

## Reference

Question design notes and the API shapes: [references/question-design.md](references/question-design.md).
