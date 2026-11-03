# Contributor Experience Improvement Plan

## Goal

Make it easier for a new contributor to understand where to start, validate a
change locally, and know which documentation to update—without adding
unnecessary process or tooling.

## Current strengths

- `CONTRIBUTING.md` explains what belongs in core versus a skill or fork, how
  to report issues, and what maintainers expect in a pull request.
- GitHub issue forms guide bug, capability, documentation, and hardening
  reports.
- CI validates both the Node/pnpm host and the Bun agent runner.
- The architecture and skill guides provide detailed technical references.

## Initial scope

Start with these three documentation improvements:

1. **Add a contributor quickstart.**
   - Add a short first-contribution path near the start of `CONTRIBUTING.md`.
   - State the prerequisites and point to the existing local setup instructions.
   - Show how to install the host and agent-runner dependencies.
   - Link to the local validation steps, architecture overview, and skill
     authoring guide.
   - Keep it concise and link to authoritative detail instead of duplicating
     the full guides.

2. **Document local validation in CI order.**
   - List the existing format check, host and container typechecks, host tests,
     and container tests.
   - Explain which runtime/package manager applies to each package tree.
   - Make clear that CI runs host tests across Node versions and shards, while a
     local run can use the existing full test commands.
   - Prefer documenting existing commands over adding a wrapper script unless
     one can stay accurately aligned with CI.

3. **Clarify documentation ownership.**
   - Update `docs/README.md` to distinguish the published user documentation
     from repository-local developer references and design documents.
   - Explain where contributors should make changes for each type of
     documentation.
   - Link to the contributor, architecture, build/runtime, and skill guides as
     appropriate.
   - Avoid implying repository docs are authoritative for current user-facing
     behavior where the published site is the source of truth.

## Follow-up opportunities

4. **Lightweight docs validation:** Consider internal-link checks and selected
   command-example checks in CI, beginning with contributor-facing documents.
   Keep checks focused to avoid brittle validation of prose.

5. **Maintainer triage guide:** Add a concise checklist for first responses to
   issues and PRs, including reproduction requirements, label transitions,
   when to request changes, and how to route proposals to a skill or fork.
   Align it with the existing contribution policy rather than creating a
   conflicting process.

6. **Fresh-checkout usability review:** Periodically ask someone unfamiliar
   with the repository to follow the contributor path from a clean checkout.
   Record points of confusion and remove redundant or unclear steps.

## Boundaries

- This plan does not change contribution acceptance policy or add new
  requirements for contributors.
- The initial work is documentation-only and should reuse existing commands,
  issue forms, and guides.
- Do not add a combined check script or new CI tooling as part of the initial
  scope.
- Treat the follow-up opportunities as separate decisions after the initial
  documentation updates are reviewed.

## Validation

- Check all new relative links and command names against the repository.
- Read the contributor quickstart and documentation-source guidance as a
  first-time contributor would.
- Documentation-only changes do not need a build or test run unless a
  documentation-specific check is introduced.
