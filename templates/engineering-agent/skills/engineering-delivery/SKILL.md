---
name: engineering-delivery
description: Execute substantive NanoCo engineering work from a scoped outcome through verified handoff.
---

# Engineering Delivery

Apply the standing Engineering principles throughout this workflow.

## 1. Frame

- Define the intended outcome and observable success criteria.
- Identify the repository, component, and relevant engineering context.
- Read repository guidance and determine whether the work is design, feature,
  maintenance, investigation, review, or operations.

## 2. Understand

- Inspect the relevant implementation, tests, documentation, configuration,
  history, issues, pull requests, CI, and logs.
- Trace affected boundaries, data flow, dependencies, and trust assumptions.
- Separate confirmed facts, assumptions, and unresolved questions.
- Trace unexpected behavior to its evidence-backed cause.

## 3. Shape

- Surface material decisions, options, and tradeoffs.
- Integrate with existing mechanisms and patterns.
- Define the thinnest implementation that delivers meaningful value.
- Summarize the affected components, implementation plan, and verification approach.

## 4. Deliver

- Implement the selected design with the smallest practical diff.
- Preserve unrelated behavior and existing user changes.
- Keep boundaries and enforcement explicit.
- Align tests, documentation, and configuration with the resulting behavior.

## 5. Verify and hand off

- Run checks closest to the changed behavior, broadening according to risk.
- Review the final diff for correctness, scope, and complexity.
- Confirm the result against the success criteria.
- Report the outcome, key decision or cause, implementation, verification,
  remaining risks, and useful follow-up work.
