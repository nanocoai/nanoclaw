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
}) => { state: 'success' | 'failure' | null };

type ShouldPostComplianceComment = (state: string | null, existingCommentBodies: Array<string | null>) => boolean;

interface ExtractedLogic {
  computeLabels: ComputeLabels;
  decideCompliance: DecideCompliance;
  shouldPostComplianceComment: ShouldPostComplianceComment;
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
    `${code}\nreturn { computeLabels, decideCompliance, shouldPostComplianceComment };`,
  )() as ExtractedLogic;
}

const { computeLabels, decideCompliance, shouldPostComplianceComment } = extractLogic();

/** Full pipeline as the driver runs it: parse, then judge compliance. */
function complianceFor(body: string, title: string, currentLabels: string[] = []) {
  const { add } = computeLabels({ body, title, author: 'drive-by-contributor', currentLabels });
  return decideCompliance({ body, add, currentLabels });
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

describe('template-compliance (report-only)', () => {
  it('v2 body with zero kind verdict: failing status', () => {
    expect(complianceFor(v2Body([]), 'Update stuff').state).toBe('failure');
  });

  it('good bodies are green: checkbox verdict, title fallback, or an already-applied kind', () => {
    expect(complianceFor(v2Body(['kind/bug']), 'x').state).toBe('success');
    expect(complianceFor(v2Body([]), 'fix: something').state).toBe('success');
    // Maintainer classified at triage; blank body must NOT go red.
    expect(complianceFor(v2Body([]), 'Update stuff', ['kind/cleanup']).state).toBe('success');
  });

  it('v1 and no-marker bodies are untouched: no status at all', () => {
    expect(complianceFor('<!-- contributing-guide: v1 -->\n- [x] **Fix** - bug fix', 'x').state).toBeNull();
    expect(complianceFor('just a hand-written body', 'fix: x').state).toBeNull();
  });

  it('the fix comment posts once, ever — idempotent across pushes', () => {
    // First failing push: no comments yet -> post.
    expect(shouldPostComplianceComment('failure', [])).toBe(true);
    // Later pushes: our marker comment exists -> never repeat.
    const marked = ['<!-- nanoclaw-template-compliance -->\nThis PR uses the v2 template…'];
    expect(shouldPostComplianceComment('failure', marked)).toBe(false);
    // Unrelated comments do not suppress it.
    expect(shouldPostComplianceComment('failure', ['LGTM', null])).toBe(true);
    // Green states never comment.
    expect(shouldPostComplianceComment('success', [])).toBe(false);
    expect(shouldPostComplianceComment(null, [])).toBe(false);
  });

  it('decideCompliance recognizes every kind computeLabels can emit', () => {
    // computeLabels and decideCompliance share one MANAGED_KINDS declaration.
    // This pins the property that declaration exists to protect: a kind the
    // parser can emit must also count as a classification, so an honestly
    // filled-in template can never leave the status red.
    for (const kind of TEMPLATE_KINDS) {
      const res = computeLabels({ body: v2Body([kind]), title: 'Update stuff', author: FORK_AUTHOR });
      expect(res.add).toContain(kind);
      expect(complianceFor(v2Body([kind]), 'Update stuff').state).toBe('success');
      // Same kind arriving as maintainer triage rather than a checkbox.
      expect(complianceFor(v2Body([]), 'Update stuff', [kind]).state).toBe('success');
    }
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
