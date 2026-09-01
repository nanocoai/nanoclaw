import { describe, expect, it } from 'vitest';

import {
  collectReleaseNotes,
  extractReleaseNote,
  isBreakingChange,
  pullRequestKind,
  pullRequestNumbersFromLog,
  pullRequestQuery,
  renderDraftChangelog,
} from './release-notes.mjs';

const TEMPLATE_BLOCK = [
  '## User and release impact',
  '',
  '- [ ] No user-visible behavior change',
  '- [x] User-visible change — release note below',
  '',
  '```release-note',
  'Optional: one user-facing line for the changelog. Skip it and a maintainer will write one.',
  '```',
  '',
].join('\n');

function body(note: string, fence = '```release-note'): string {
  return ['## Summary', '', 'Some description.', '', fence, note, fence.replace(/[^`~]+$/, ''), ''].join('\n');
}

describe('release-note extraction', () => {
  it('extracts a single-line note from a backtick fence', () => {
    expect(extractReleaseNote(body('Scheduled tasks now survive a host restart.'))).toBe(
      'Scheduled tasks now survive a host restart.',
    );
  });

  it('accepts tilde fences and longer backtick runs', () => {
    expect(extractReleaseNote(body('Tilde note.', '~~~release-note'))).toBe('Tilde note.');
    expect(extractReleaseNote(body('Four-backtick note.', '````release-note'))).toBe('Four-backtick note.');
  });

  it('accepts the release-notes plural and mixed-case info strings', () => {
    expect(extractReleaseNote(body('Plural note.', '```release-notes'))).toBe('Plural note.');
    expect(extractReleaseNote(body('Cased note.', '```Release-Note'))).toBe('Cased note.');
  });

  it('treats the untouched template placeholder as no note', () => {
    expect(extractReleaseNote(TEMPLATE_BLOCK)).toBeNull();
  });

  it('drops the placeholder line when the contributor wrote underneath it', () => {
    const mixed = body(
      [
        'Optional: one user-facing line for the changelog. Skip it and a maintainer will write one.',
        'The real line.',
      ].join('\n'),
    );
    expect(extractReleaseNote(mixed)).toBe('The real line.');
  });

  it('returns null for an empty block and for a body with no release-note fence', () => {
    expect(extractReleaseNote(body('   '))).toBeNull();
    expect(extractReleaseNote('## Summary\n\nNo fence at all.\n')).toBeNull();
  });

  it('skips unrelated fenced blocks that precede the release note', () => {
    const withCode = ['```bash', 'pnpm test', '```', '', '```release-note', 'After the code block.', '```'].join('\n');
    expect(extractReleaseNote(withCode)).toBe('After the code block.');
  });

  it('does not let a backtick line close a tilde fence', () => {
    const crossed = ['~~~release-note', 'Line one.', '```', 'Line two.', '~~~'].join('\n');
    expect(extractReleaseNote(crossed)).toBe('Line one.\n```\nLine two.');
  });

  it('keeps multiple paragraphs verbatim', () => {
    const note = 'First paragraph.\n\nSecond paragraph with **detail**.';
    expect(extractReleaseNote(body(note))).toBe(note);
  });

  it('runs an unterminated fence to the end of the body', () => {
    expect(extractReleaseNote('```release-note\nTrailing note.\n')).toBe('Trailing note.');
  });

  it('ignores an indented fence, matching the label workflow flush-left rule', () => {
    expect(extractReleaseNote('  ```release-note\n  Indented.\n  ```\n')).toBeNull();
  });

  it('strips HTML comments out of the harvested note', () => {
    expect(extractReleaseNote(body('Visible line. <!-- reviewer note -->'))).toBe('Visible line.');
  });
});

describe('kind grouping', () => {
  it('picks the first managed kind in canonical order', () => {
    expect(pullRequestKind([{ name: 'kind/cleanup' }, { name: 'kind/bug' }])).toBe('kind/bug');
    expect(pullRequestKind(['kind/hardening'])).toBe('kind/hardening');
  });

  it('returns null when no managed kind label is present', () => {
    expect(pullRequestKind([{ name: 'PR: Fix' }, { name: 'core-team' }])).toBeNull();
    expect(pullRequestKind([])).toBeNull();
  });
});

describe('breaking-change detection', () => {
  it('detects the checked breaking box', () => {
    expect(isBreakingChange('- [x] Breaking change — release note below covers detect\n')).toBe(true);
    expect(isBreakingChange('- [ ] Breaking change — release note below\n')).toBe(false);
  });

  it('ignores a checkbox that only appears inside a fenced block', () => {
    expect(isBreakingChange('```release-note\n- [x] Breaking change\n```\n')).toBe(false);
  });
});

describe('draft assembly', () => {
  const pullRequests = [
    {
      number: 10,
      title: 'feat: cards',
      url: 'https://example.test/10',
      author: 'ada',
      labels: [{ name: 'kind/feature' }],
      body: body('Cards render inline.'),
    },
    {
      number: 11,
      title: 'fix: crash',
      url: 'https://example.test/11',
      author: 'grace',
      labels: [{ name: 'kind/bug' }],
      body: body('The host no longer crashes on restart.'),
    },
    {
      number: 12,
      title: 'chore: tidy',
      url: 'https://example.test/12',
      author: 'linus',
      labels: [{ name: 'kind/cleanup' }],
      body: TEMPLATE_BLOCK,
    },
    {
      number: 13,
      title: 'feat: untagged',
      url: 'https://example.test/13',
      author: 'ken',
      labels: [],
      body: body('No kind label on this one.'),
    },
  ];

  it('groups notes by kind and lists note-less PRs separately', () => {
    const collected = collectReleaseNotes(pullRequests);
    expect(collected.groups.map((group) => group.heading)).toEqual(['Fixes', 'Features', 'Unlabelled']);
    expect(collected.missing.map((entry) => entry.number)).toEqual([12]);
  });

  it('renders each note with its PR link and author', () => {
    const markdown = renderDraftChangelog(collectReleaseNotes(pullRequests), { since: 'v2.3.0', until: 'HEAD' });
    expect(markdown).toContain('- The host no longer crashes on restart. ([#11](https://example.test/11), @grace)');
    expect(markdown).toContain('## Needs a line (1)');
    expect(markdown).toContain('- ([#12](https://example.test/12), @linus) `kind/cleanup` — chore: tidy');
  });

  it('keeps a multi-paragraph note inside one bullet and flags breaking changes', () => {
    const breaking = [
      '- [x] Breaking change — release note below covers detect',
      '',
      '```release-note',
      'The seam moved.',
      '',
      'Migration: run the detector.',
      '```',
    ].join('\n');
    const markdown = renderDraftChangelog(
      collectReleaseNotes([
        { number: 20, title: 't', url: 'u', author: 'ada', labels: ['kind/hardening'], body: breaking },
      ]),
    );
    expect(markdown).toContain('- [BREAKING] The seam moved.\n\n  Migration: run the detector. ([#20](u), @ada)');
  });

  it('says so when nothing in the range needs a line', () => {
    const markdown = renderDraftChangelog(collectReleaseNotes([pullRequests[0]]));
    expect(markdown).toContain('Every merged pull request in this range carried a release note.');
  });

  it('tells the maintainer the draft is theirs to move', () => {
    const markdown = renderDraftChangelog(collectReleaseNotes([]), { since: 'v2.3.0', until: 'HEAD' });
    expect(markdown).toContain('this tool never writes `CHANGELOG.md`');
    expect(markdown).toContain('No release notes were found in this range.');
  });
});

describe('range collection', () => {
  it('collects PR numbers from squash subjects and merge commits, deduped and ordered', () => {
    const log = [
      'fix(agent-runner): tell the agent send_card drops callback actions (#3426)',
      'Merge pull request #3582 from GetDial-AI/fix/add-dial-copy-status-test',
      'fix(add-dial): add dial-status.test.ts to the nc:copy list (#3582)',
      'chore: no pull request reference here',
    ].join('\n');
    expect(pullRequestNumbersFromLog(log)).toEqual([3426, 3582]);
  });

  it('builds one aliased GraphQL query per chunk', () => {
    const query = pullRequestQuery('nanocoai/nanoclaw', [1, 2]);
    expect(query).toContain('repository(owner: "nanocoai", name: "nanoclaw")');
    expect(query).toContain('pr1: pullRequest(number: 1)');
    expect(query).toContain('pr2: pullRequest(number: 2)');
    expect(query).toContain('mergedAt');
  });

  it('rejects a repository argument that is not owner/name', () => {
    expect(() => pullRequestQuery('nanoclaw', [1])).toThrow('owner/name');
  });
});
