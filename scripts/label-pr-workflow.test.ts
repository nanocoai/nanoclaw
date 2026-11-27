/**
 * Fixture tests for the PR labeling decision logic (CI-04 acceptance
 * criteria). The logic ships inline in .github/workflows/label-pr.yml (the
 * pull_request_target workflow is metadata-only and never checks out the
 * repo, so it cannot read a script file at runtime); these tests extract the
 * exact code between the NANOCLAW-LABEL-LOGIC markers from the workflow file
 * and evaluate it, so the tested function and the shipped function cannot
 * drift.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface LabelDecision {
  add: string[];
  remove: string[];
  coreTeam: boolean;
}

type ComputeLabels = (args: {
  body?: string | null;
  title?: string | null;
  author?: string | null;
  currentLabels?: string[];
}) => LabelDecision;

type DecideCompliance = (args: {
  body?: string | null;
  add: string[];
  currentLabels?: string[];
  author?: string | null;
}) => { state: 'success' | 'failure'; missing: string[]; exempt: boolean; description: string };

interface ComplianceCommentPlan {
  action: 'create' | 'update' | 'none';
  commentId?: number;
  body?: string;
}

type PlanComplianceComment = (
  compliance: { state: 'success' | 'failure'; missing: string[]; exempt: boolean },
  existingComments: Array<{ id: number; body?: string | null; user?: { login?: string } | null }>,
) => ComplianceCommentPlan;

interface ExtractedLogic {
  computeLabels: ComputeLabels;
  decideCompliance: DecideCompliance;
  planComplianceComment: PlanComplianceComment;
  REQUIRED_SECTIONS: string[];
}

function extractLogic(): ExtractedLogic {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'label-pr.yml'),
    'utf8',
  );
  const start = workflow.indexOf('NANOCLAW-LABEL-LOGIC-START');
  const end = workflow.indexOf('NANOCLAW-LABEL-LOGIC-END');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('NANOCLAW-LABEL-LOGIC markers not found in label-pr.yml');
  }
  const block = workflow.slice(start, end);
  // Strip the YAML block-scalar indentation so the code parses standalone.
  const code = block
    .split('\n')
    .slice(1) // drop the START marker line itself
    .map((line) => line.replace(/^ {12}/, ''))
    .join('\n');
  return new Function(
    `${code}\nreturn { computeLabels, decideCompliance, planComplianceComment, REQUIRED_SECTIONS };`,
  )() as ExtractedLogic;
}

const { computeLabels, decideCompliance, planComplianceComment, REQUIRED_SECTIONS } = extractLogic();

/** Full pipeline as the driver runs it: parse, then judge compliance. */
function complianceFor(body: string, title: string, currentLabels: string[] = [], author = 'drive-by-contributor') {
  const { add } = computeLabels({ body, title, author, currentLabels });
  return decideCompliance({ body, add, currentLabels, author });
}

/** Raw workflow text, for fixtures that couple prose promises to parser behavior. */
function workflowText(): string {
  return fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'label-pr.yml'), 'utf8');
}

const V2 = '<!-- nanoclaw-pr-template:v2 -->\n';
/** The kind boxes the PR template offers, i.e. every kind a verdict can name. */
const TEMPLATE_KINDS = ['kind/bug', 'kind/feature', 'kind/documentation', 'kind/cleanup', 'kind/hardening'];
// Blank template: no kind box, neither skill box. `skill: true` checks the
// Skill box; `notSkill: true` checks the "Not a skill" box.
const v2Body = (kinds: string[], opts: { skill?: boolean; notSkill?: boolean } = {}) =>
  V2 +
  '## Change kind\n' +
  TEMPLATE_KINDS
    .map((k) => `- [${kinds.includes(k) ? 'x' : ' '}] \`${k}\``)
    .join('\n') +
  '\n## Skill delivery\n' +
  `- [${opts.notSkill ? 'x' : ' '}] Not a skill\n` +
  `- [${opts.skill ? 'x' : ' '}] Skill: apply/remove footprint and fresh-clone verification are described above\n`;

const FORK_AUTHOR = 'drive-by-contributor';
const LEGACY_TWINS = ['PR: Fix', 'PR: Feature', 'PR: Docs', 'PR: Refactor'];

describe('v2 bodies — explicit checkbox verdicts', () => {
  it('one checked kind: adds it + its legacy twin, reconciles BOTH vocabularies', () => {
    const res = computeLabels({ body: v2Body(['kind/bug']), title: 'anything', author: FORK_AUTHOR });
    expect(res.add).toContain('kind/bug');
    expect(res.add).toContain('PR: Fix');
    expect(res.add).toContain('follows-guidelines');
    expect(res.remove).toEqual(
      expect.arrayContaining(['kind/feature', 'kind/documentation', 'kind/cleanup', 'kind/hardening']),
    );
    // B2: the stale kinds' legacy twins go too — no PR: Fix + PR: Refactor pileup.
    expect(res.remove).toEqual(expect.arrayContaining(['PR: Feature', 'PR: Docs', 'PR: Refactor']));
    expect(res.remove).not.toContain('kind/bug');
    expect(res.remove).not.toContain('PR: Fix');
  });

  it('reclassifying bug -> cleanup removes kind/bug AND PR: Fix in the same pass', () => {
    const res = computeLabels({
      body: v2Body(['kind/cleanup']),
      title: 'x',
      author: FORK_AUTHOR,
      currentLabels: ['kind/bug', 'PR: Fix'],
    });
    expect(res.add).toEqual(expect.arrayContaining(['kind/cleanup', 'PR: Refactor']));
    expect(res.remove).toContain('kind/bug');
    expect(res.remove).toContain('PR: Fix');
  });

  it('kind/hardening has no legacy PR:* twin, added or removed', () => {
    const res = computeLabels({ body: v2Body(['kind/hardening']), title: 'x', author: FORK_AUTHOR });
    expect(res.add).toContain('kind/hardening');
    expect(res.add.filter((l) => l.startsWith('PR: '))).toEqual([]);
    expect(res.remove).toEqual(expect.arrayContaining(LEGACY_TWINS));
  });

  it('skill checkbox adds delivery/skill + PR: Skill; "Not a skill" removes both; neither box changes nothing', () => {
    const on = computeLabels({ body: v2Body(['kind/bug'], { skill: true }), title: 'x', author: FORK_AUTHOR });
    expect(on.add).toEqual(expect.arrayContaining(['delivery/skill', 'PR: Skill']));

    const off = computeLabels({ body: v2Body(['kind/bug'], { notSkill: true }), title: 'x', author: FORK_AUTHOR });
    expect(off.remove).toEqual(expect.arrayContaining(['delivery/skill', 'PR: Skill']));

    const blank = computeLabels({ body: v2Body(['kind/bug']), title: 'x', author: FORK_AUTHOR });
    expect(blank.add).not.toContain('delivery/skill');
    expect(blank.remove).not.toContain('delivery/skill');
  });
});

describe('v2 bodies — advisory title fallback (B1: never removes, never overrules)', () => {
  it('zero boxes + mappable title + no existing kind: adds kind + twin, removes NOTHING', () => {
    const res = computeLabels({
      body: v2Body([]),
      title: 'fix(host-sweep): make the ceiling configurable',
      author: FORK_AUTHOR,
      currentLabels: [],
    });
    expect(res.add).toEqual(expect.arrayContaining(['kind/bug', 'PR: Fix']));
    expect(res.remove).toEqual([]);
  });

  it("maintainer reclassification survives a later edited event: fallback adds nothing when a managed kind is present", () => {
    // PR titled fix:, no box checked; maintainer set kind/cleanup at triage.
    const res = computeLabels({
      body: v2Body([]),
      title: 'fix: something',
      author: FORK_AUTHOR,
      currentLabels: ['kind/cleanup', 'PR: Refactor'],
    });
    expect(res.add.filter((l) => l.startsWith('kind/') || l.startsWith('PR: '))).toEqual([]);
    expect(res.remove).toEqual([]);
  });

  it('multiple checked boxes: no checkbox verdict — title is advisory, no removals', () => {
    const res = computeLabels({
      body: v2Body(['kind/bug', 'kind/feature']),
      title: 'docs: fix a typo',
      author: FORK_AUTHOR,
      currentLabels: [],
    });
    expect(res.add).toContain('kind/documentation');
    expect(res.add).not.toContain('kind/bug');
    expect(res.remove).toEqual([]);
  });

  it('still ambiguous (no boxes, unmappable title): applies no kind and removes nothing', () => {
    const res = computeLabels({ body: v2Body([]), title: 'Update stuff', author: FORK_AUTHOR });
    expect(res.add.filter((l) => l.startsWith('kind/'))).toEqual([]);
    expect(res.remove).toEqual([]);
  });

  it('repo-convention prefixes ci/test/build/style/perf map to kind/cleanup, chore/refactor too', () => {
    for (const title of ['ci(labels): x', 'test: y', 'build(deps): z', 'style: w', 'perf: v', 'chore(deps): u', 'refactor: t']) {
      const res = computeLabels({ body: v2Body([]), title, author: FORK_AUTHOR, currentLabels: [] });
      expect(res.add, title).toContain('kind/cleanup');
    }
  });

  it('follows-guidelines is earned only by a checkbox verdict, not by the bare marker or the fallback', () => {
    const unfilled = computeLabels({ body: v2Body([]), title: 'fix: x', author: FORK_AUTHOR });
    expect(unfilled.add).not.toContain('follows-guidelines');
    const filled = computeLabels({ body: v2Body(['kind/bug']), title: 'x', author: FORK_AUTHOR });
    expect(filled.add).toContain('follows-guidelines');
  });
});

describe('v2 bodies — token robustness', () => {
  it('marker requires the exact HTML comment: a prose mention stays on the v1 path', () => {
    const res = computeLabels({
      body: 'I copied nanoclaw-pr-template:v2 from docs\n- [x] `kind/bug`',
      title: 'feat: x',
      author: FORK_AUTHOR,
    });
    // v1 path: backticked kind tokens mean nothing there, and no v1 boxes are checked.
    expect(res.add.filter((l) => l.startsWith('kind/') || l.startsWith('PR: '))).toEqual([]);
    expect(res.remove).toEqual([]);
  });

  it('checkbox tokens must start the line: inline and indented mentions do not register', () => {
    const body =
      V2 +
      'see - [x] `kind/bug` discussed inline\n' +
      '  - [x] `kind/feature` (indented, quoted from another PR)\n';
    const res = computeLabels({ body, title: 'Update stuff', author: FORK_AUTHOR });
    expect(res.add.filter((l) => l.startsWith('kind/'))).toEqual([]);
  });

  it('checkbox case: [X] counts as checked', () => {
    const body = V2 + '- [X] `kind/feature`\n';
    const res = computeLabels({ body, title: 'x', author: FORK_AUTHOR });
    expect(res.add).toContain('kind/feature');
  });

  it('a filled release-note block carries no label semantics', () => {
    const note =
      '## User and release impact\n' +
      '- [x] User-visible change — release note below\n' +
      '```release-note\n' +
      'Fixes `kind/bug` handling.\n' +
      '- [x] `kind/feature`\n' +
      '```\n';
    const res = computeLabels({ body: v2Body(['kind/cleanup']) + note, title: 'x', author: FORK_AUTHOR });
    expect(res.add.filter((l) => l.startsWith('kind/'))).toEqual(['kind/cleanup']);
    expect(res.remove).toContain('kind/bug');
    expect(res.remove).toContain('PR: Fix');
  });

  it('~~~ fences hide checkbox-looking text too', () => {
    const body = v2Body(['kind/cleanup']) + '~~~\n- [x] `kind/bug`\n~~~\n';
    const res = computeLabels({ body, title: 'x', author: FORK_AUTHOR });
    expect(res.add.filter((l) => l.startsWith('kind/'))).toEqual(['kind/cleanup']);
  });

  it('an unterminated fence hides everything after it', () => {
    const body = v2Body([]) + '```\n- [x] `kind/bug`\n';
    const res = computeLabels({ body, title: 'Update stuff', author: FORK_AUTHOR });
    expect(res.add.filter((l) => l.startsWith('kind/'))).toEqual([]);
  });

  it('the Validation test-coverage checkbox carries no label semantics', () => {
    const validation =
      '## Validation\n' +
      '- [x] Tests cover the changed behavior (or Validation says why not)\n';
    const withKind = computeLabels({ body: v2Body(['kind/bug']) + validation, title: 'x', author: FORK_AUTHOR });
    expect(withKind.add.filter((l) => l.startsWith('kind/'))).toEqual(['kind/bug']);
    expect(withKind.add).not.toContain('delivery/skill');

    // Checked with no kind box: still no verdict from it — title fallback decides.
    const alone = computeLabels({ body: v2Body([]) + validation, title: 'docs: x', author: FORK_AUTHOR });
    expect(alone.add).toContain('kind/documentation');
  });

  it('AI-assistance checkboxes carry no label semantics and do not confuse the kind parser', () => {
    const ai =
      '## AI assistance\n' +
      '- [x] AI tools or agents helped produce this change\n' +
      '- [x] A human has reviewed this PR and stands behind every change\n';
    const withKind = computeLabels({ body: v2Body(['kind/bug']) + ai, title: 'x', author: FORK_AUTHOR });
    expect(withKind.add.filter((l) => l.startsWith('kind/'))).toEqual(['kind/bug']);
    expect(withKind.add).not.toContain('delivery/skill');
  });

  it('never emits a label outside the fixed vocabularies', () => {
    const KNOWN = new Set([
      'kind/bug', 'kind/feature', 'kind/documentation', 'kind/cleanup', 'kind/hardening',
      'PR: Fix', 'PR: Feature', 'PR: Docs', 'PR: Refactor', 'PR: Skill',
      'delivery/skill', 'follows-guidelines', 'core-team',
    ]);
    for (const body of [v2Body(['kind/bug'], { skill: true }), v2Body([]), v2Body(['kind/hardening'], { notSkill: true })]) {
      const res = computeLabels({ body, title: 'feat!: breaking', author: 'glifocat' });
      for (const label of [...res.add, ...res.remove]) {
        expect(KNOWN.has(label), label).toBe(true);
      }
    }
  });
});

describe('v1 bodies (frozen pre-v2 behavior)', () => {
  it('checkbox substring adds both vocabularies, add-only', () => {
    const res = computeLabels({ body: '<!-- contributing-guide: v1 -->\n- [x] **Fix** - bug fix', title: 'x', author: FORK_AUTHOR });
    expect(res.add).toContain('PR: Fix');
    expect(res.add).toContain('kind/bug');
    expect(res.add).toContain('follows-guidelines');
    expect(res.remove).toEqual([]);
  });

  it('feature skill emits the full four-label set', () => {
    const res = computeLabels({ body: '- [x] **Feature skill** - adds a channel', title: 'x', author: FORK_AUTHOR });
    expect(res.add).toEqual(expect.arrayContaining(['PR: Skill', 'PR: Feature', 'kind/feature', 'delivery/skill']));
  });

  it('first checked box wins, exactly as before', () => {
    const res = computeLabels({
      body: '- [x] **Fix** - bug fix\n- [x] **Documentation** - docs only',
      title: 'x',
      author: FORK_AUTHOR,
    });
    expect(res.add).toContain('PR: Fix');
    expect(res.add).not.toContain('PR: Docs');
  });

  it('v1 matching stays case-sensitive: [X] is not recognized', () => {
    const res = computeLabels({ body: '- [X] **Fix** - bug fix', title: 'x', author: FORK_AUTHOR });
    expect(res.add.filter((l) => l.startsWith('PR: '))).toEqual([]);
  });

  it('missing body: no labels, no removals, no crash', () => {
    const res = computeLabels({ body: null, title: null, author: FORK_AUTHOR });
    expect(res.add).toEqual([]);
    expect(res.remove).toEqual([]);
  });
});

/** The sections the template header requires in every PR. */
const REQUIRED = ['Summary', 'Change kind', 'Validation', 'Security and trust boundaries', 'AI assistance'];
/** A complete v2 body: every required section, plus v2Body's kind and skill blocks. */
const fullBody = (kinds: string[], opts: { omit?: string[]; extra?: string } = {}) =>
  v2Body(kinds) +
  REQUIRED.filter((h) => h !== 'Change kind' && !(opts.omit || []).includes(h))
    .map((h) => `\n## ${h}\n\nSomething real.\n`)
    .join('') +
  (opts.extra || '');
/** fullBody with the Change kind heading itself removed. */
const withoutKindHeading = (kinds: string[]) => fullBody(kinds).replace('## Change kind\n', '');

describe('template-compliance', () => {
  it('requires exactly the sections the template header names', () => {
    expect(REQUIRED_SECTIONS).toEqual(REQUIRED);
    const template = fs.readFileSync(path.join(__dirname, '..', '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8');
    for (const h of REQUIRED_SECTIONS) expect(template).toMatch(new RegExp(`^## ${h}$`, 'm'));
  });

  it('complete v2 body with one kind box: success', () => {
    const res = complianceFor(fullBody(['kind/bug']), 'Update stuff');
    expect(res.state).toBe('success');
    expect(res.missing).toEqual([]);
    expect(res.exempt).toBe(false);
  });

  it('optional sections may be deleted', () => {
    const body = fullBody(['kind/bug']).replace(/\n## Skill delivery\n[\s\S]*?(?=\n## )/, '\n');
    expect(body).not.toContain('Skill delivery');
    expect(complianceFor(body, 'x').state).toBe('success');
  });

  it('no v2 marker: failure, even with every section present', () => {
    const res = complianceFor(fullBody(['kind/bug']).replace(V2, ''), 'fix: x');
    expect(res.state).toBe('failure');
    expect(res.missing).toContain('v2 template marker');
    expect(res.description).toMatch(/v2 template/);
  });

  it('a filled-in template that lost its marker is blamed for the marker only', () => {
    // Real case: the marker line dropped, every section and a kind box kept.
    // The v1 parser ignores the box, so "kind classification" would be false.
    const res = complianceFor(fullBody(['kind/bug']).replace(V2, ''), 'Update stuff');
    expect(res.missing).toEqual(['v2 template marker']);
  });

  it('v1 and hand-written bodies now fail instead of getting no status', () => {
    expect(complianceFor('<!-- contributing-guide: v1 -->\n- [x] **Fix** - bug fix', 'x').state).toBe('failure');
    expect(complianceFor('just a hand-written body', 'fix: x').state).toBe('failure');
    expect(complianceFor('', 'fix: x').state).toBe('failure');
  });

  it('each missing required section fails and is named', () => {
    for (const h of REQUIRED.filter((x) => x !== 'Change kind')) {
      const res = complianceFor(fullBody(['kind/bug'], { omit: [h] }), 'x');
      expect(res.state, h).toBe('failure');
      expect(res.missing, h).toEqual([`${h} section`]);
      expect(res.description, h).toContain(h);
    }
    const noKindHeading = complianceFor(withoutKindHeading(['kind/bug']), 'x');
    expect(noKindHeading.state).toBe('failure');
    expect(noKindHeading.missing).toEqual(['Change kind section']);
  });

  it('a heading only inside a code fence or an HTML comment does not count', () => {
    const fenced = fullBody(['kind/bug'], { omit: ['Validation'], extra: '\n```md\n## Validation\n```\n' });
    expect(complianceFor(fenced, 'x').missing).toEqual(['Validation section']);
    const tilde = fullBody(['kind/bug'], { omit: ['Validation'], extra: '\n~~~\n## Validation\n~~~\n' });
    expect(complianceFor(tilde, 'x').missing).toEqual(['Validation section']);
    const commented = fullBody(['kind/bug'], { omit: ['AI assistance'], extra: '\n<!--\n## AI assistance\n-->\n' });
    expect(complianceFor(commented, 'x').missing).toEqual(['AI assistance section']);
    // An unterminated comment hides the rest of the body when GitHub renders it.
    const open = fullBody(['kind/bug'], { omit: ['AI assistance'], extra: '\n<!-- oops\n## AI assistance\n' });
    expect(complianceFor(open, 'x').missing).toEqual(['AI assistance section']);
  });

  it('CommonMark block rules: indented fences, inline `<!--`, fence text inside a comment', () => {
    // Inline code mentioning `<!--` opens no comment.
    const inline = fullBody(['kind/bug']).replace('Something real.', 'Handles the literal `<!--` token.');
    expect(complianceFor(inline, 'x').state).toBe('success');
    // A fence opened with one space of indent still closes on a flush-left fence.
    // (Placed after the kind boxes: the kind parser's stripFences, unchanged
    // here, is flush-left only.)
    const indentedOpen = fullBody(['kind/bug']).replace('## Validation', ' ```\ncode\n```\n## Validation');
    expect(complianceFor(indentedOpen, 'x').state).toBe('success');
    // Headings inside an indented fence are code, not sections.
    const hiddenInFence = fullBody(['kind/bug'], { omit: ['Validation'], extra: '\n   ```\n## Validation\n   ```\n' });
    expect(complianceFor(hiddenInFence, 'x').missing).toEqual(['Validation section']);
    // A fence marker inside an HTML comment is comment text; the comment still closes.
    const fenceInComment = fullBody(['kind/bug']).replace('## Validation', '<!--\n   ```\n-->\n## Validation');
    expect(complianceFor(fenceInComment, 'x').state).toBe('success');
    // A fence opened on a list item closes on its indented closing line.
    const listFence = fullBody(['kind/bug']).replace('## Validation', '- ~~~sh\n  echo ok\n  ~~~\n\n## Validation');
    expect(complianceFor(listFence, 'x').state).toBe('success');
    // A shorter or different-character line does not close a fence.
    const unclosed = fullBody(['kind/bug'], { omit: ['Validation'], extra: '\n````\n```\n~~~~\n## Validation\n````\n' });
    expect(complianceFor(unclosed, 'x').missing).toEqual(['Validation section']);
  });

  it('heading matching tolerates case, level, CRLF, up to three leading spaces, and a trailing note', () => {
    const body = fullBody(['kind/bug'])
      .replace('## Validation', '### validation (manual)')
      .replace('## Summary', '   ## Summary')
      .replace(/\n/g, '\r\n');
    expect(complianceFor(body, 'x').state).toBe('success');
    // But a heading that merely starts with the word does not count.
    const prefixed = fullBody(['kind/bug']).replace('## Summary', '## Summaryish');
    expect(complianceFor(prefixed, 'x').missing).toEqual(['Summary section']);
    // Four spaces make it indented code, not a heading.
    const indented = fullBody(['kind/bug']).replace('## Summary', '    ## Summary');
    expect(complianceFor(indented, 'x').missing).toEqual(['Summary section']);
  });

  it('a section must be a heading, not prose that mentions it', () => {
    const body = fullBody(['kind/bug'], { omit: ['Summary'], extra: '\nSee ## Summary above.\n' });
    expect(complianceFor(body, 'x').missing).toEqual(['Summary section']);
  });

  it('kind rule unchanged: no verdict fails, and every classification path passes', () => {
    const none = complianceFor(fullBody([]), 'Update stuff');
    expect(none.state).toBe('failure');
    expect(none.missing).toEqual(['kind classification']);
    expect(complianceFor(fullBody([]), 'fix: something').state).toBe('success');
    // Maintainer classified at triage; blank kind box must NOT go red.
    expect(complianceFor(fullBody([]), 'Update stuff', ['kind/cleanup']).state).toBe('success');
    // Several boxes with no fallback: still unclassified.
    expect(complianceFor(fullBody(['kind/bug', 'kind/feature']), 'Update stuff').state).toBe('failure');
  });

  it('decideCompliance recognizes every kind computeLabels can emit', () => {
    // computeLabels and decideCompliance share one MANAGED_KINDS declaration.
    // This pins the property that declaration exists to protect: a kind the
    // parser can emit must also count as a classification, so an honestly
    // filled-in template can never leave the status red.
    for (const kind of TEMPLATE_KINDS) {
      const res = computeLabels({ body: fullBody([kind]), title: 'Update stuff', author: FORK_AUTHOR });
      expect(res.add).toContain(kind);
      expect(complianceFor(fullBody([kind]), 'Update stuff').state).toBe('success');
      // Same kind arriving as maintainer triage rather than a checkbox.
      expect(complianceFor(fullBody([]), 'Update stuff', [kind]).state).toBe('success');
    }
  });

  it('bot authors are exempt: success, never failure', () => {
    for (const bot of ['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]', 'some-app[bot]', 'Dependabot[BOT]']) {
      const res = complianceFor('Bumps foo from 1.0 to 1.1.', 'chore(deps): bump foo', [], bot);
      expect(res.state, bot).toBe('success');
      expect(res.exempt, bot).toBe(true);
      expect(res.missing, bot).toEqual([]);
    }
    // A human login that merely contains "bot" is not exempt.
    expect(complianceFor('hand-written', 'x', [], 'robotics-fan').state).toBe('failure');
  });

  it('status description names what is missing and fits GitHub\'s 140-char cap', () => {
    const worst = complianceFor('nothing here', 'Update stuff');
    expect(worst.state).toBe('failure');
    expect(worst.missing).toEqual(['v2 template marker', ...REQUIRED.map((h) => `${h} section`)]);
    const v2Worst = complianceFor(V2 + 'nothing here', 'Update stuff');
    expect(v2Worst.missing).toEqual([...REQUIRED.map((h) => `${h} section`), 'kind classification']);
    expect(v2Worst.description.length).toBeLessThanOrEqual(140);
    expect(worst.description.length).toBeLessThanOrEqual(140);
    expect(worst.description).not.toMatch(/report-only|does not block/i);
    const one = complianceFor(fullBody(['kind/bug'], { omit: ['Validation'] }), 'x');
    expect(one.description).toBe('Missing: Validation section');
    expect(complianceFor(fullBody(['kind/bug']), 'x').description.length).toBeLessThanOrEqual(140);
  });
});

describe('template-compliance comment', () => {
  const ACTIONS = { login: 'github-actions[bot]' };
  const failing = () => complianceFor(fullBody(['kind/bug'], { omit: ['Validation'] }), 'x');

  it('first failure creates one comment naming what is missing, with template and CONTRIBUTING links', () => {
    const plan = planComplianceComment(failing(), []);
    expect(plan.action).toBe('create');
    expect(plan.body).toContain('<!-- nanoclaw-template-compliance -->');
    expect(plan.body).toContain('Validation section');
    expect(plan.body).toContain('https://github.com/nanocoai/nanoclaw/blob/main/.github/PULL_REQUEST_TEMPLATE.md');
    expect(plan.body).toContain('https://github.com/nanocoai/nanoclaw/blob/main/CONTRIBUTING.md');
    expect(plan.body).not.toMatch(/report-only|does not block/i);
  });

  it('later failures update our existing comment instead of posting another', () => {
    const first = planComplianceComment(failing(), []);
    const existing = [
      { id: 1, body: 'LGTM', user: { login: 'someone' } },
      { id: 7, body: first.body, user: ACTIONS },
    ];
    // Same content: nothing to do (no edit churn on every push).
    expect(planComplianceComment(failing(), existing).action).toBe('none');
    // Different gaps: edit comment 7 in place.
    const other = complianceFor(fullBody(['kind/bug'], { omit: ['Summary'] }), 'x');
    const plan = planComplianceComment(other, existing);
    expect(plan).toMatchObject({ action: 'update', commentId: 7 });
    expect(plan.body).toContain('Summary section');
    expect(plan.body).not.toContain('Validation section');
  });

  it('only our own marker comment counts: a pasted marker neither suppresses nor gets edited', () => {
    const spoof = [{ id: 3, body: '<!-- nanoclaw-template-compliance -->\nfake', user: { login: 'drive-by-contributor' } }];
    expect(planComplianceComment(failing(), spoof).action).toBe('create');
  });

  it('once fixed, our comment is edited to say so; with no comment, nothing is posted', () => {
    const green = complianceFor(fullBody(['kind/bug']), 'x');
    expect(planComplianceComment(green, []).action).toBe('none');
    const first = planComplianceComment(failing(), []);
    const plan = planComplianceComment(green, [{ id: 7, body: first.body, user: ACTIONS }]);
    expect(plan).toMatchObject({ action: 'update', commentId: 7 });
    expect(plan.body).toContain('<!-- nanoclaw-template-compliance -->');
    expect(plan.body).not.toContain('Validation section');
    // And it is not re-edited on every later green push.
    expect(planComplianceComment(green, [{ id: 7, body: plan.body, user: ACTIONS }]).action).toBe('none');
  });

  it('bot-authored PRs never get a comment', () => {
    const bot = complianceFor('Bumps foo.', 'chore: bump', [], 'dependabot[bot]');
    expect(planComplianceComment(bot, []).action).toBe('none');
  });

  it('comment text is built only from fixed vocabulary, never PR content', () => {
    const hostile = '<!-- nanoclaw-pr-template:v2 -->\n## Summary\n@everyone <script>x</script>\n';
    const plan = planComplianceComment(complianceFor(hostile, '@everyone'), []);
    expect(plan.body).not.toContain('@everyone');
    expect(plan.body).not.toContain('<script>');
  });

  it('every conventional-commit prefix the fix comment promises actually maps to a kind', () => {
    // The comment tells contributors a conventional-commit title will classify
    // the PR, and names the prefixes. Read them back out of that sentence so
    // the promise cannot drift away from what the parser accepts.
    const line = workflowText()
      .split('\n')
      .find((l) => l.includes('give the PR a conventional-commit title'));
    expect(line, 'fix-comment prefix sentence not found in label-pr.yml').toBeDefined();
    const promised = [...(line as string).matchAll(/`([a-z]+):`/g)].map((m) => m[1]);
    expect(promised).toEqual(['fix', 'feat', 'docs', 'refactor', 'chore', 'ci', 'test', 'build', 'style', 'perf']);
    for (const prefix of promised) {
      const res = computeLabels({
        body: v2Body([]),
        title: `${prefix}: something`,
        author: FORK_AUTHOR,
        currentLabels: [],
      });
      expect(res.add.filter((l) => l.startsWith('kind/')), `prefix ${prefix}: promised a kind, got none`).toHaveLength(1);
    }
  });
});

describe('author handling (both paths)', () => {
  it('fork-authored PR gets no core-team label', () => {
    const res = computeLabels({ body: v2Body(['kind/bug']), title: 'x', author: FORK_AUTHOR });
    expect(res.add).not.toContain('core-team');
    expect(res.coreTeam).toBe(false);
  });

  it('core-team roster match is case-insensitive on the login', () => {
    const res = computeLabels({ body: v2Body(['kind/bug']), title: 'x', author: 'Glifocat' });
    expect(res.add).toContain('core-team');
    expect(res.coreTeam).toBe(true);
  });
});
