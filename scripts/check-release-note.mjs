#!/usr/bin/env node

// Decides whether a pull request description satisfies the "User and release
// impact" section of .github/PULL_REQUEST_TEMPLATE.md and reports the verdict
// the way GitHub Actions expects. .github/workflows/release-note.yml runs it on
// every pull request event that can change the description.
//
// A description passes when it either checks the "No user-visible behavior
// change" box or carries a non-empty ```release-note fenced block. "Non-empty"
// is decided by extractReleaseNote from release-notes.mjs — the function the
// changelog harvest uses — so a note that passes here is a line the harvest
// will find, and the template's untouched prompt counts as no note in both
// places.
//
// The body arrives through the PR_BODY environment variable, never as an
// argument or interpolated into a shell line: a description is
// contributor-controlled text.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { extractReleaseNote, isBoxChecked } from './release-notes.mjs';

// Checkbox labels: byte-for-byte prefixes of the template's lines under
// "User and release impact". check-release-note.test.ts pins them to the file.
export const NO_CHANGE_BOX = 'No user-visible behavior change';
export const USER_VISIBLE_BOX = 'User-visible change';
export const BREAKING_BOX = 'Breaking change';

export const TEMPLATE_PATH = '.github/PULL_REQUEST_TEMPLATE.md';
export const TEMPLATE_SECTION = 'User and release impact';

/**
 * The verdict for one description.
 *   ok: whether the check passes.
 *   verdict: 'note' (a release note is present), 'no-change' (the no-change
 *     box carries it), or 'missing' (neither).
 *   claimsChange: the user-visible or breaking box is checked.
 *   warnings: advisory lines for a passing description that still looks
 *     inconsistent; they never fail the check.
 */
export function decideReleaseNote(body) {
  const note = extractReleaseNote(body);
  const noChange = isBoxChecked(body, NO_CHANGE_BOX);
  const claimsChange = isBoxChecked(body, USER_VISIBLE_BOX) || isBoxChecked(body, BREAKING_BOX);

  if (note !== null) return { ok: true, verdict: 'note', note, claimsChange, warnings: [] };
  if (noChange) {
    const warnings = claimsChange
      ? [
          `"${NO_CHANGE_BOX}" is checked next to "${USER_VISIBLE_BOX}" or "${BREAKING_BOX}", and the release-note block is empty. ` +
            'The no-change box makes this pass; if the change is user-visible, write the line.',
        ]
      : [];
    return { ok: true, verdict: 'no-change', note: null, claimsChange, warnings };
  }
  return { ok: false, verdict: 'missing', note: null, claimsChange, warnings: [] };
}

/** What a contributor reads when the check fails: the cause, then the two ways to fix it. */
export function failureMessage({ claimsChange }) {
  const cause = claimsChange
    ? `the "${USER_VISIBLE_BOX}" or "${BREAKING_BOX}" box is checked, but the release-note block is empty.`
    : `the description neither checks "${NO_CHANGE_BOX}" nor carries a release note.`;
  return [
    `Release-note check failed: ${cause}`,
    '',
    `Edit the "${TEMPLATE_SECTION}" section of the pull request description (copy it from ${TEMPLATE_PATH} if it is missing), then either:`,
    `- check \`- [x] ${NO_CHANGE_BOX}\` when nothing an operator sees changes, or`,
    '- replace the prompt inside the `release-note` fenced block with one user-facing line; an untouched prompt counts as no note.',
    '',
    'Saving the description re-runs this check. RELEASING.md explains how the line reaches the changelog.',
  ].join('\n');
}

function successMessage({ verdict, note }) {
  if (verdict === 'note') return `Release note found:\n${note}`;
  return `"${NO_CHANGE_BOX}" is checked; no release note required.`;
}

// Workflow-command payloads are single-line; GitHub decodes these escapes back.
function escapeAnnotation(text) {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** Runs the check against env.PR_BODY, printing through `out`; returns the process exit code. */
export function run(
  env = process.env,
  out = (line) => {
    process.stdout.write(`${line}\n`);
  },
) {
  const result = decideReleaseNote(env.PR_BODY);
  const report = result.ok ? successMessage(result) : failureMessage(result);

  out(report);
  for (const warning of result.warnings) out(`::warning title=Release note::${escapeAnnotation(warning)}`);
  if (!result.ok) out(`::error title=Release note::${escapeAnnotation(report)}`);

  if (env.GITHUB_STEP_SUMMARY) {
    const heading = result.ok ? '### Release note: pass' : '### Release note: fail';
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${heading}\n\n${report}\n\n${result.warnings.join('\n\n')}\n`);
  }
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run();
}
