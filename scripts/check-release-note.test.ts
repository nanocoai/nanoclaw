/**
 * Fixture tests for the release-note check that .github/workflows/release-note.yml
 * runs on every pull request. The decision lives in scripts/check-release-note.mjs
 * and is imported directly; the fixtures below also pin the script to the template
 * it enforces and to the workflow that runs it, so none of the three can drift
 * from the others unnoticed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BREAKING_BOX,
  NO_CHANGE_BOX,
  TEMPLATE_PATH,
  TEMPLATE_SECTION,
  USER_VISIBLE_BOX,
  decideReleaseNote,
  failureMessage,
  run,
} from './check-release-note.mjs';

const ROOT = path.join(__dirname, '..');
const TEMPLATE = fs.readFileSync(path.join(ROOT, TEMPLATE_PATH), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-note.yml'), 'utf8');
const SCRIPT = path.join(ROOT, 'scripts', 'check-release-note.mjs');

// The prompt the template ships inside its fence: the line after the opener.
const TEMPLATE_LINES = TEMPLATE.split('\n');
const PLACEHOLDER = TEMPLATE_LINES[TEMPLATE_LINES.indexOf('```release-note') + 1];

/** The real template with the named boxes checked and, optionally, the prompt replaced by a note. */
function filled(opts: { check?: string[]; note?: string; crlf?: boolean } = {}): string {
  let body = TEMPLATE;
  for (const label of opts.check ?? []) {
    const line = `- [ ] ${label}`;
    expect(body, `template line "${line}"`).toContain(line);
    body = body.replace(line, `- [x] ${label}`);
  }
  if (opts.note !== undefined) body = body.replace(PLACEHOLDER, opts.note);
  return opts.crlf ? body.replaceAll('\n', '\r\n') : body;
}

describe('decideReleaseNote', () => {
  it('fails the untouched template: no box checked and the prompt still inside the fence', () => {
    expect(PLACEHOLDER).toContain(NO_CHANGE_BOX);
    const res = decideReleaseNote(filled());
    expect(res).toMatchObject({ ok: false, verdict: 'missing', note: null, claimsChange: false });
  });

  it('passes on the no-user-visible-change box alone', () => {
    const res = decideReleaseNote(filled({ check: [NO_CHANGE_BOX] }));
    expect(res).toMatchObject({ ok: true, verdict: 'no-change', note: null, warnings: [] });
  });

  it('passes on a written release note, with or without a box', () => {
    const withBox = decideReleaseNote(filled({ check: [USER_VISIBLE_BOX], note: 'Setup no longer hangs on Linux.' }));
    expect(withBox).toMatchObject({ ok: true, verdict: 'note', note: 'Setup no longer hangs on Linux.' });
    // A description that dropped the checkboxes but kept the block.
    const noBoxes = '## Summary\n\nx\n\n```release-note\nThe line.\n```\n';
    expect(decideReleaseNote(noBoxes)).toMatchObject({ ok: true, verdict: 'note', note: 'The line.' });
  });

  it('takes a line written under the untouched prompt as the note', () => {
    const res = decideReleaseNote(filled({ note: `${PLACEHOLDER}\nWebhook retries now back off.` }));
    expect(res).toMatchObject({ ok: true, verdict: 'note', note: 'Webhook retries now back off.' });
  });

  it('fails when the user-visible or breaking box is checked but the block still holds the prompt', () => {
    for (const box of [USER_VISIBLE_BOX, BREAKING_BOX]) {
      const res = decideReleaseNote(filled({ check: [box] }));
      expect(res.ok, box).toBe(false);
      expect(res.claimsChange, box).toBe(true);
    }
  });

  it('a whitespace-only block is empty', () => {
    expect(decideReleaseNote(filled({ check: [USER_VISIBLE_BOX], note: '   \n\t' })).ok).toBe(false);
  });

  it('no-change box next to a claimed change with no note: passes with one warning, never fails', () => {
    const res = decideReleaseNote(filled({ check: [NO_CHANGE_BOX, BREAKING_BOX] }));
    expect(res).toMatchObject({ ok: true, verdict: 'no-change', claimsChange: true });
    expect(res.warnings).toHaveLength(1);
  });

  it('a note wins over every box combination and carries no warning', () => {
    const res = decideReleaseNote(filled({ check: [NO_CHANGE_BOX, USER_VISIBLE_BOX], note: 'A line.' }));
    expect(res).toMatchObject({ ok: true, verdict: 'note', warnings: [] });
  });

  it('empty, missing, and pre-template bodies fail', () => {
    expect(decideReleaseNote('').ok).toBe(false);
    expect(decideReleaseNote(null).ok).toBe(false);
    expect(decideReleaseNote(undefined).ok).toBe(false);
    expect(decideReleaseNote('<!-- contributing-guide: v1 -->\n- [x] **Fix** - bug fix').ok).toBe(false);
  });

  it('reads GitHub bodies with CRLF line endings', () => {
    expect(decideReleaseNote(filled({ check: [NO_CHANGE_BOX], crlf: true })).verdict).toBe('no-change');
    expect(decideReleaseNote(filled({ note: 'A line.', crlf: true })).verdict).toBe('note');
  });

  it('checkbox tokens count only flush-left and outside fences; [X] counts as checked', () => {
    expect(decideReleaseNote(`  - [x] ${NO_CHANGE_BOX}\n`).ok).toBe(false);
    expect(decideReleaseNote(`\`\`\`\n- [x] ${NO_CHANGE_BOX}\n\`\`\`\n`).ok).toBe(false);
    expect(decideReleaseNote(`- [X] ${NO_CHANGE_BOX}\n`).verdict).toBe('no-change');
  });

  it('accepts tilde fences and the release-notes plural, exactly as the harvest does', () => {
    expect(decideReleaseNote('~~~release-note\nTilde.\n~~~\n').verdict).toBe('note');
    expect(decideReleaseNote('```release-notes\nPlural.\n```\n').verdict).toBe('note');
  });
});

describe('coupling to the template and the workflow', () => {
  it('the checkbox labels are the template lines under "User and release impact"', () => {
    const section = TEMPLATE.split(`## ${TEMPLATE_SECTION}`)[1]?.split('\n## ')[0] ?? '';
    const boxes = section
      .split('\n')
      .filter((line) => line.startsWith('- [ ] '))
      .map((line) => line.slice('- [ ] '.length));
    expect(boxes).toHaveLength(3);
    for (const label of [NO_CHANGE_BOX, USER_VISIBLE_BOX, BREAKING_BOX]) {
      expect(
        boxes.some((box) => box.startsWith(label)),
        label,
      ).toBe(true);
    }
  });

  it('the failure message names the template file and section a contributor must edit', () => {
    for (const claimsChange of [false, true]) {
      const message = failureMessage({ claimsChange });
      expect(message).toContain(TEMPLATE_PATH);
      expect(message).toContain(`"${TEMPLATE_SECTION}"`);
      expect(message).toContain(`- [x] ${NO_CHANGE_BOX}`);
      expect(message).toContain('`release-note`');
    }
    expect(fs.existsSync(path.join(ROOT, TEMPLATE_PATH))).toBe(true);
    expect(TEMPLATE).toContain(`## ${TEMPLATE_SECTION}`);
  });

  it('the workflow runs this script on pull_request for every event that can change a description', () => {
    expect(WORKFLOW).toContain('pull_request:');
    expect(WORKFLOW).not.toContain('pull_request_target');
    const types = /types:\s*\[([^\]]+)\]/
      .exec(WORKFLOW)?.[1]
      .split(',')
      .map((t) => t.trim())
      .sort();
    expect(types).toEqual(['edited', 'opened', 'reopened', 'synchronize']);
    expect(WORKFLOW).toContain('PR_BODY: ${{ github.event.pull_request.body }}');
    expect(WORKFLOW).toContain('run: node scripts/check-release-note.mjs');
    // The description reaches the script through the environment only, never a shell line.
    expect(WORKFLOW).not.toMatch(/run:.*pull_request\.body/);
  });
});

describe('run', () => {
  function capture(env: Record<string, string | undefined>) {
    const lines: string[] = [];
    const code = run(env, (line) => lines.push(line));
    return { code, text: lines.join('\n') };
  }

  it('prints the failure, one error annotation, and the summary when GITHUB_STEP_SUMMARY is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-note-'));
    try {
      const summary = path.join(dir, 'summary.md');
      const { code, text } = capture({ PR_BODY: filled(), GITHUB_STEP_SUMMARY: summary });
      expect(code).toBe(1);
      expect(text.match(/^::error title=Release note::/gm)).toHaveLength(1);
      expect(text).toContain(TEMPLATE_SECTION);
      expect(fs.readFileSync(summary, 'utf8')).toContain(TEMPLATE_PATH);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes quietly on a note and warns without failing on contradictory boxes', () => {
    const note = capture({ PR_BODY: filled({ note: 'Operators see this.' }) });
    expect(note.code).toBe(0);
    expect(note.text).toContain('Operators see this.');
    expect(note.text).not.toContain('::error');
    expect(note.text).not.toContain('::warning');

    const contradictory = capture({ PR_BODY: filled({ check: [NO_CHANGE_BOX, USER_VISIBLE_BOX] }) });
    expect(contradictory.code).toBe(0);
    expect(contradictory.text.match(/^::warning title=Release note::/gm)).toHaveLength(1);
  });
});

describe('command line', () => {
  function exec(body: string | undefined) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    if (body === undefined) delete env.PR_BODY;
    else env.PR_BODY = body;
    return spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  }

  it('exits 1 on the untouched template and with no PR_BODY at all', () => {
    const untouched = exec(filled());
    expect(untouched.status).toBe(1);
    expect(untouched.stdout).toContain('::error title=Release note::');
    expect(exec(undefined).status).toBe(1);
  });

  it('exits 0 on the no-change box and on a written note', () => {
    expect(exec(filled({ check: [NO_CHANGE_BOX] })).status).toBe(0);
    expect(exec(filled({ note: 'A line.' })).status).toBe(0);
  });
});
