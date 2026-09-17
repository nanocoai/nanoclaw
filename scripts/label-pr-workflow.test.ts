/** Exercise the exact metadata-only script shipped by the privileged workflow. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

type ChangedFile = string | { filename: string; status?: string; previous_filename?: string };
type AreaRules = Record<string, string[]>;
interface LabelDecision {
  add: string[];
  remove: string[];
}
interface LabelInput {
  body?: string | null;
  title?: string | null;
  currentLabels?: string[];
  files?: ChangedFile[];
  areaRules?: AreaRules;
}
const root = path.join(__dirname, '..');
const workflowText = fs.readFileSync(path.join(root, '.github/workflows/label-pr.yml'), 'utf8');
const workflow = parse(workflowText);
const script = workflow.jobs.label.steps.find((step: { with?: { script?: string } }) => step.with?.script).with
  .script as string;
const start = script.indexOf('// NANOCLAW-LABEL-LOGIC-START');
const end = script.indexOf('// NANOCLAW-LABEL-LOGIC-END');
if (start < 0 || end <= start) throw new Error('Missing labeling logic markers');
const { computeLabels, selectPrimaryArea, decideCompliance, shouldPostComplianceComment } = new Function(
  `${script.slice(start, end)}\nreturn { computeLabels, selectPrimaryArea, decideCompliance, shouldPostComplianceComment };`,
)() as {
  computeLabels: (input: LabelInput) => LabelDecision;
  selectPrimaryArea: (files: ChangedFile[], rules: AreaRules) => string | null;
  decideCompliance: (input: { body?: string | null; add: string[]; currentLabels?: string[] }) => {
    state: string | null;
  };
  shouldPostComplianceComment: (state: string | null, bodies: Array<string | null>) => boolean;
};
const areaRules: AreaRules = JSON.parse(fs.readFileSync(path.join(root, '.github/pr-label-areas.json'), 'utf8'));
const V2 = '<!-- nanoclaw-pr-template:v2 -->\n';
const kinds = ['kind/bug', 'kind/feature', 'kind/documentation', 'kind/cleanup', 'kind/hardening'];
const retired = ['PR: Fix', 'PR: Feature', 'PR: Docs', 'PR: Refactor', 'PR: Skill', 'core-team', 'follows-guidelines'];
function body(selected: string[] = [], delivery: 'skill' | 'none' | 'both' | 'blank' = 'blank') {
  return (
    V2 +
    kinds.map((kind) => `- [${selected.includes(kind) ? 'x' : ' '}] \`${kind}\``).join('\n') +
    `\n- [${delivery === 'skill' || delivery === 'both' ? 'x' : ' '}] Skill: apply/remove footprint\n` +
    `- [${delivery === 'none' || delivery === 'both' ? 'x' : ' '}] Not a skill\n`
  );
}
function apply(current: string[], result: LabelDecision) {
  return [...new Set([...current.filter((label) => !result.remove.includes(label)), ...result.add])].sort();
}
const opencodeFiles = [
  '.claude/skills/add-opencode/SKILL.md',
  '.claude/skills/add-opencode/REMOVE.md',
  '.claude/skills/add-opencode/files/container/agent-runner/src/providers/opencode.ts',
  'container/agent-runner/src/providers/types.ts',
  'container/agent-runner/src/provider-contracts/active-provider.test.ts',
  'container/Dockerfile',
  'scripts/ci-provider-combined.ts',
];

describe('managed label reconciliation', () => {
  it('collapses the OpenCode skill collision to one kind, skill delivery, and one primary area', () => {
    const current = [
      ...retired,
      'kind/feature',
      'delivery/skill',
      'area/providers',
      'area/agent-runner',
      'area/containers',
      'area/skills',
    ];
    const result = computeLabels({
      body: body(['kind/feature'], 'skill'),
      currentLabels: current,
      files: opencodeFiles,
      areaRules,
    });
    expect(apply(current, result)).toEqual(['area/providers', 'delivery/skill', 'kind/feature']);
    expect(result.add.some((label) => retired.includes(label))).toBe(false);
  });

  it('reclassifies a PR without deleting unrelated manual or unfamiliar namespaced labels', () => {
    const manual = ['priority/high', 'triage/ready', 'release/blocker', 'kind/security', 'area/custom', 'PR: Special'];
    const current = [...manual, 'kind/bug', 'PR: Fix', 'area/skills'];
    const result = computeLabels({
      body: body(['kind/cleanup']),
      currentLabels: current,
      files: ['src/providers/claude.ts'],
      areaRules,
    });
    expect(apply(current, result)).toEqual([...manual, 'area/providers', 'kind/cleanup'].sort());
    expect(result.remove.every((label) => current.includes(label))).toBe(true);
  });

  it.each(kinds)('an explicit %s selection overrides existing kinds and a conflicting title', (kind) => {
    const current = [...kinds, ...retired];
    const result = computeLabels({ body: body([kind]), title: 'feat: conflicting title', currentLabels: current });
    expect(apply(current, result)).toEqual([kind]);
  });

  it('keeps a single maintainer classification ahead of the title on an ambiguous body', () => {
    const current = ['kind/hardening', 'PR: Fix'];
    for (const selected of [[], ['kind/bug', 'kind/feature']]) {
      expect(
        apply(current, computeLabels({ body: body(selected), title: 'fix: example', currentLabels: current })),
      ).toEqual(['kind/hardening']);
    }
  });

  it('resolves multiple existing kinds with the title, or removes ambiguity if no verdict exists', () => {
    const current = ['kind/bug', 'kind/feature'];
    expect(apply(current, computeLabels({ body: body(), title: 'docs: example', currentLabels: current }))).toEqual([
      'kind/documentation',
    ]);
    expect(apply(current, computeLabels({ body: body(), title: 'Update stuff', currentLabels: current }))).toEqual([]);
  });

  it.each([
    ['fix(scope)!: x', 'kind/bug'],
    ['feat!: x', 'kind/feature'],
    ['docs: x', 'kind/documentation'],
    ...['refactor', 'chore', 'ci', 'test', 'build', 'style', 'perf'].map((prefix) => [`${prefix}: x`, 'kind/cleanup']),
  ])('classifies %s without a completed template', (title, kind) => {
    for (const prBody of [body(), 'Hand-written description', null]) {
      expect(computeLabels({ body: prBody, title }).add).toEqual([kind]);
    }
  });

  it.each(['constructor: example', '__proto__: example', 'toString: example'])(
    'does not interpret object properties as conventional kinds: %s',
    (title) => {
      expect(computeLabels({ body: body(), title }).add).toEqual([]);
    },
  );

  it('handles missing content and still retires obsolete labels', () => {
    expect(computeLabels({ body: null, title: null })).toEqual({ add: [], remove: [] });
    expect(apply(retired, computeLabels({ currentLabels: retired }))).toEqual([]);
  });

  it('switches skill delivery explicitly, preserving it when both or neither box is checked', () => {
    const current = ['delivery/skill', 'PR: Skill'];
    expect(apply([], computeLabels({ body: body([], 'skill') }))).toEqual(['delivery/skill']);
    expect(apply(current, computeLabels({ body: body([], 'none'), currentLabels: current }))).toEqual([]);
    for (const delivery of ['both', 'blank'] as const) {
      expect(apply(current, computeLabels({ body: body([], delivery), currentLabels: current }))).toEqual([
        'delivery/skill',
      ]);
      expect(computeLabels({ body: body([], delivery) }).add).toEqual([]);
    }
  });

  it('converges after one reconciliation, including cleanup of stale areas and legacy twins', () => {
    const input = { body: body(['kind/feature'], 'skill'), files: opencodeFiles, areaRules };
    const current = ['kind/bug', ...retired, 'area/containers', 'priority/high'];
    const once = apply(current, computeLabels({ ...input, currentLabels: current }));
    const again = computeLabels({ ...input, currentLabels: once });
    expect(again.remove).toEqual([]);
    expect(apply(once, again)).toEqual(once);
  });
});

describe('template parsing compatibility', () => {
  it('requires the exact marker and flush-left stable checkbox tokens', () => {
    expect(computeLabels({ body: 'nanoclaw-pr-template:v2\n- [x] `kind/bug`', title: 'feat: x' }).add).toEqual([
      'kind/feature',
    ]);
    expect(computeLabels({ body: V2 + 'See - [x] `kind/bug`\n  - [x] `kind/feature`' }).add).toEqual([]);
    expect(computeLabels({ body: V2 + '- [X] `kind/hardening`' }).add).toEqual(['kind/hardening']);
  });

  it.each([
    '```release-note\n- [x] `kind/bug`\n```\n',
    '~~~\n- [x] `kind/bug`\n~~~\n',
    '```\n- [x] `kind/bug`\n',
    '~~~\n```\n- [x] `kind/bug`\n~~~\n',
  ])('ignores checkbox-looking code including unclosed and mixed fences', (fence) => {
    expect(computeLabels({ body: body(['kind/cleanup']) + fence }).add).toEqual(['kind/cleanup']);
  });

  it('does not classify validation or AI assistance checkboxes', () => {
    const extra =
      '- [x] Tests cover the changed behavior\n- [x] AI tools or agents helped produce this change\n- [x] A human has reviewed this PR and stands behind every change\n';
    expect(computeLabels({ body: body() + extra }).add).toEqual([]);
  });

  it.each([
    ['Feature skill', ['delivery/skill', 'kind/feature']],
    ['Utility skill', ['delivery/skill', 'kind/feature']],
    ['Operational/container skill', ['delivery/skill', 'kind/feature']],
    ['Fix', ['kind/bug']],
    ['Simplification', ['kind/cleanup']],
    ['Documentation', ['kind/documentation']],
  ])('maps the old %s checkbox only to modern labels', (label, expected) => {
    const result = computeLabels({
      body: `<!-- contributing-guide: v1 -->\n- [x] **${label}**`,
      currentLabels: retired,
    });
    expect(apply(retired, result)).toEqual(expected);
  });

  it('retains legacy first-match and case-sensitive parsing and preserves unaddressed skill delivery', () => {
    expect(computeLabels({ body: '- [x] **Documentation**\n- [x] **Fix**' }).add).toEqual(['kind/bug']);
    expect(computeLabels({ body: '- [X] **Fix**' }).add).toEqual([]);
    expect(
      apply(['delivery/skill'], computeLabels({ body: '- [x] **Fix**', currentLabels: ['delivery/skill'] })),
    ).toEqual(['delivery/skill', 'kind/bug']);
  });
});

describe('primary area ownership', () => {
  it.each([
    'container/agent-runner/src/providers/opencode.ts',
    '.claude/skills/add-opencode/SKILL.md',
    'src/provider-surfaces.test.ts',
    'src/provider-contracts/conformance.test.ts',
    'container/agent-runner/src/provider-contracts/active-provider.test.ts',
  ])('assigns provider-specific paths to providers: %s', (filename) => {
    expect(selectPrimaryArea([filename], areaRules)).toBe('area/providers');
  });

  it('gives each file only its most specific matching owner before counting the majority', () => {
    const rules = { 'area/broad': ['src/**'], 'area/provider': ['src/providers/**'], 'area/docs': ['docs/**'] };
    expect(selectPrimaryArea(['src/providers/a.ts', 'src/providers/b.ts', 'src/host.ts'], rules)).toBe('area/provider');
    expect(selectPrimaryArea(['src/providers/a.ts', 'src/a.ts', 'src/b.ts'], rules)).toBe('area/broad');
    expect(selectPrimaryArea(['src/providers/a.ts', 'docs/a.md', 'docs/b.md'], rules)).toBe('area/docs');
  });

  it('breaks tied file counts by specificity and then lexical area, independent of input order', () => {
    const rules = { 'area/zeta': ['src/providers/**'], 'area/alpha': ['src/providers/**'], 'area/docs': ['docs/**'] };
    const files = ['docs/a.md', 'src/providers/a.ts'];
    expect(selectPrimaryArea(files, rules)).toBe('area/alpha');
    expect(selectPrimaryArea([...files].reverse(), Object.fromEntries(Object.entries(rules).reverse()))).toBe(
      'area/alpha',
    );
  });

  it('supports exact, segment prefix, and descendant patterns without sibling-prefix leakage', () => {
    const rules = {
      'area/exact': ['docs/provider.md'],
      'area/prefix': ['src/config*'],
      'area/tree': ['src/providers/**'],
    };
    expect(selectPrimaryArea(['docs/provider.md'], rules)).toBe('area/exact');
    expect(selectPrimaryArea(['src/config.test.ts'], rules)).toBe('area/prefix');
    expect(selectPrimaryArea(['src/providers/nested/a.ts'], rules)).toBe('area/tree');
    for (const filename of ['docs/provider.md.bak', 'src/config/nested.ts', 'src/providers-extra/a.ts', 'unknown']) {
      expect(selectPrimaryArea([filename], rules)).toBeFalsy();
    }
  });

  it('counts renamed files only at their destination, and includes removed files', () => {
    const rules = { 'area/docs': ['docs/**'], 'area/providers': ['src/providers/**'] };
    expect(
      selectPrimaryArea(
        [
          { filename: 'docs/a.md', previous_filename: 'src/providers/a.ts', status: 'renamed' },
          { filename: 'docs/b.md', status: 'removed' },
          { filename: 'src/providers/c.ts', status: 'modified' },
        ],
        rules,
      ),
    ).toBe('area/docs');
  });

  it('removes a stale managed area when no changed file has a known owner', () => {
    const current = ['area/providers', 'area/manual'];
    expect(apply(current, computeLabels({ files: ['unmapped.file'], currentLabels: current, areaRules }))).toEqual([
      'area/manual',
    ]);
  });
});

function complianceFor(prBody: string, title = '', currentLabels: string[] = []) {
  const { add } = computeLabels({ body: prBody, title, currentLabels });
  return decideCompliance({ body: prBody, add, currentLabels }).state;
}
describe('report-only template compliance', () => {
  it('accepts all template kinds, title fallback, and existing triage, but reports unclassified v2 bodies', () => {
    for (const kind of kinds) {
      expect(complianceFor(body([kind]))).toBe('success');
      expect(complianceFor(body(), '', [kind])).toBe('success');
    }
    expect(complianceFor(body(), 'fix: x')).toBe('success');
    expect(complianceFor(body(), 'Update stuff')).toBe('failure');
    expect(complianceFor('<!-- contributing-guide: v1 -->')).toBeNull();
    expect(complianceFor('Hand-written', 'fix: x')).toBeNull();
  });

  it('posts fix instructions once across pushes and ignores unrelated comments', () => {
    expect(shouldPostComplianceComment('failure', ['LGTM', null])).toBe(true);
    expect(shouldPostComplianceComment('failure', ['<!-- nanoclaw-template-compliance -->\nInstructions'])).toBe(false);
    expect(shouldPostComplianceComment('success', [])).toBe(false);
    expect(shouldPostComplianceComment(null, [])).toBe(false);
  });

  it('supports every conventional prefix promised by the fix comment', () => {
    const line = script.split('\n').find((line) => line.includes('give the PR a conventional-commit title'));
    expect(line).toBeDefined();
    const prefixes = [...line!.matchAll(/`([a-z]+):`/g)].map((match) => match[1]);
    expect(prefixes).toEqual(['fix', 'feat', 'docs', 'refactor', 'chore', 'ci', 'test', 'build', 'style', 'perf']);
    for (const prefix of prefixes) expect(complianceFor(body(), `${prefix}: x`)).toBe('success');
  });
});

/** API harness runs the entire shipped script; all external writes stay mocked. */
function driverFixture(
  options: {
    current?: string[];
    prBody?: string;
    files?: ChangedFile[];
    comments?: Array<{ body: string | null }>;
  } = {},
) {
  const liveLabels = new Set(options.current ?? []);
  const pr = {
    number: 17,
    changed_files: (options.files ?? opencodeFiles).length,
    title: 'Update stuff',
    body: options.prBody ?? body(['kind/feature'], 'skill'),
    head: { sha: 'fresh-head' },
    user: { login: 'contributor' },
    labels: [...liveLabels].map((name) => ({ name })),
  };
  const files = options.files ?? opencodeFiles;
  const github = {
    rest: {
      pulls: { get: vi.fn(async () => ({ data: pr })), listFiles: vi.fn() },
      repos: {
        getContent: vi.fn(async () => ({
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(JSON.stringify(areaRules)).toString('base64'),
          },
        })),
        createCommitStatus: vi.fn(async () => ({})),
      },
      issues: {
        addLabels: vi.fn(async ({ labels }: { labels: string[] }) => {
          labels.forEach((label) => liveLabels.add(label));
        }),
        removeLabel: vi.fn(async ({ name }: { name: string }) => {
          liveLabels.delete(name);
        }),
        setLabels: vi.fn(async () => {
          throw new Error('Wholesale label replacement is forbidden');
        }),
        listComments: vi.fn(),
        createComment: vi.fn(async () => ({})),
      },
    },
    paginate: vi.fn(async (method: unknown) => {
      if (method === github.rest.pulls.listFiles)
        return [files.slice(0, 2), files.slice(2)]
          .flat()
          .map((file) => (typeof file === 'string' ? { filename: file } : file));
      if (method === github.rest.issues.listComments) return options.comments ?? [];
      throw new Error('Unexpected pagination endpoint');
    }),
  };
  const context = {
    repo: { owner: 'example', repo: 'repo' },
    sha: 'trusted-base-sha',
    payload: {
      action: 'synchronize',
      pull_request: { ...pr, body: body(['kind/bug']), head: { sha: 'stale-head' }, labels: [{ name: 'kind/bug' }] },
    },
  };
  const core = { info: vi.fn(), warning: vi.fn(), setFailed: vi.fn(), debug: vi.fn() };
  const run = () =>
    new Function('github', 'context', 'core', `return (async () => {\n${script}\n})();`)(
      github,
      context,
      core,
    ) as Promise<void>;
  return { github, context, core, liveLabels, run };
}

describe('workflow driver', () => {
  it('reconciles synchronize events using fresh PR state, all file pages, and trusted base configuration', async () => {
    const fixture = driverFixture({
      current: ['priority/high', 'kind/feature', 'delivery/skill', 'area/skills', 'PR: Feature'],
    });
    await fixture.run();
    const { github, liveLabels } = fixture;
    expect([...liveLabels].sort()).toEqual(['area/providers', 'delivery/skill', 'kind/feature', 'priority/high']);
    expect(github.rest.pulls.get).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 17 }));
    expect(github.paginate).toHaveBeenCalledWith(
      github.rest.pulls.listFiles,
      expect.objectContaining({ pull_number: 17, per_page: 100 }),
    );
    expect(github.rest.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: '.github/pr-label-areas.json', ref: 'trusted-base-sha' }),
    );
    expect(github.rest.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['area/providers'] }));
    expect(github.rest.issues.setLabels).not.toHaveBeenCalled();
    expect(github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'fresh-head', state: 'success', context: 'template-compliance' }),
    );
  });

  it('makes no label writes when the existing labels are already correct', async () => {
    const fixture = driverFixture({ current: ['kind/feature', 'delivery/skill', 'area/providers', 'priority/high'] });
    await fixture.run();
    expect(fixture.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(fixture.github.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(fixture.github.rest.issues.setLabels).not.toHaveBeenCalled();
  });

  it('preserves a manual label added concurrently after the fresh read', async () => {
    const fixture = driverFixture({ current: ['kind/bug'] });
    fixture.github.rest.pulls.get.mockImplementationOnce(async () => {
      fixture.liveLabels.add('triage/ready');
      return { data: { ...fixture.context.payload.pull_request, body: body(['kind/feature'], 'skill') } };
    });
    await fixture.run();
    expect(fixture.liveLabels.has('triage/ready')).toBe(true);
    expect(fixture.github.rest.issues.setLabels).not.toHaveBeenCalled();
  });

  it('fails closed before label writes when trusted configuration is unavailable', async () => {
    const fixture = driverFixture({ current: ['kind/bug', 'area/skills'] });
    fixture.github.rest.repos.getContent.mockRejectedValueOnce(new Error('Configuration unavailable'));
    await expect(fixture.run()).rejects.toThrow('Configuration unavailable');
    expect(fixture.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(fixture.github.rest.issues.removeLabel).not.toHaveBeenCalled();
  });

  it('refuses an incomplete file list before any label mutation', async () => {
    const fixture = driverFixture({ current: ['kind/bug', 'area/skills'] });
    fixture.github.rest.pulls.get.mockResolvedValueOnce({
      data: {
        ...fixture.context.payload.pull_request,
        changed_files: 3001,
      },
    });
    await expect(fixture.run()).rejects.toThrow('Incomplete PR file list');
    expect(fixture.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(fixture.github.rest.issues.removeLabel).not.toHaveBeenCalled();
  });

  it('rejects invalid trusted rules without partially reclassifying a PR', async () => {
    const fixture = driverFixture({ current: ['kind/bug'] });
    fixture.github.rest.repos.getContent.mockResolvedValueOnce({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify({ 'area/providers': ['../untrusted/**'] })).toString('base64'),
      },
    });
    await expect(fixture.run()).rejects.toThrow('Unsupported primary-area path pattern');
    expect(fixture.github.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(fixture.github.rest.issues.removeLabel).not.toHaveBeenCalled();
  });

  it('judges compliance after removing multiple unresolved kinds', async () => {
    const fixture = driverFixture({ current: ['kind/bug', 'kind/feature'], prBody: body(), files: [] });
    await fixture.run();
    expect(fixture.github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failure' }),
    );
    expect(fixture.github.rest.issues.createComment).toHaveBeenCalledOnce();
    expect([...fixture.liveLabels]).toEqual([]);
  });

  it('retains report-only failure and paginates existing comments before posting instructions', async () => {
    const fixture = driverFixture({
      prBody: body(),
      files: [],
      comments: [
        ...Array.from({ length: 100 }, () => ({ body: 'Earlier discussion' })),
        { body: '<!-- nanoclaw-template-compliance -->\nAlready posted' },
      ],
    });
    await fixture.run();
    expect(fixture.github.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failure' }),
    );
    expect(fixture.github.paginate).toHaveBeenCalledWith(
      fixture.github.rest.issues.listComments,
      expect.objectContaining({ per_page: 100 }),
    );
    expect(fixture.github.rest.issues.createComment).not.toHaveBeenCalled();
    expect(fixture.core.setFailed).not.toHaveBeenCalled();
  });

  it('keeps the privileged workflow metadata-only and has a single serialized label writer', () => {
    expect(workflow.on.pull_request_target.types).toContain('synchronize');
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.concurrency.group).toContain('github.event.pull_request.number');
    expect(
      workflow.jobs.label.steps.every(
        (step: { uses?: string; run?: string }) =>
          !step.run && /^actions\/github-script@[a-f0-9]{40}$/.test(step.uses ?? ''),
      ),
    ).toBe(true);
    expect(script).not.toContain('${{');
    expect(script).not.toMatch(/(?:child_process|@actions\/exec)/);
    expect(script).not.toMatch(/\b(?:eval|execSync|spawn|spawnSync|setLabels)\s*\(/);
    expect(fs.existsSync(path.join(root, '.github/workflows/label-area.yml'))).toBe(false);
  });
});
