import { afterAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseDirectives } from './skill-directives.js';
import {
  MANIFEST,
  NOT_COVERED,
  check,
  collect,
  generate,
  installSpecs,
  runGenerate,
  scanCliTools,
  scanSkill,
  scanSkillFiles,
  sync,
  verifySync,
  writeGenerated,
} from './skill-pins.js';

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-pins-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8');
const edit = (root: string, file: string, from: string, to: string) => {
  const text = read(root, file);
  expect(text).toContain(from);
  writeFileSync(join(root, file), text.replace(from, to));
};
const regenerate = (root: string) => writeGenerated(root, generate(collect(root)));

// Line numbers below are load-bearing: the shadow file and sync point at them.
const CHAT_SKILL = [
  '# Add chat', //  1
  '', //  2
  '```nc:prompt backend', //  3
  'Local or hosted?', //  4
  '```', //  5
  '', //  6
  '```nc:dep when:backend=local', //  7
  'local-adapter@1.0.0', //  8
  '```', //  9
  '', // 10
  '```nc:dep when:backend=hosted', // 11
  'hosted-sdk@2.0.0', // 12
  'qrcode@1.5.4', // 13
  '```', // 14
  '', // 15
  '```nc:dep manager:bun cwd:container/agent-runner', // 16
  '@scope/sdk@3.1.0-rc.1', // 17
  '```', // 18
  '', // 19
  '```nc:run effect:external', // 20
  'command -v tool >/dev/null || npm install -g @scope/tool@0.9.0 --loglevel=error', // 21
  '```', // 22
  '', // 23
  'Add it to `container/cli-tools.json`:', // 24
  '', // 25
  '```nc:json-merge into:container/cli-tools.json key:name', // 26
  '{ "name": "@scope/tool", "version": "0.9.0" }', // 27
  '```', // 28
  '', // 29
  '```json', // 30
  '{', // 31
  '  "name": "prose-cli",', // 32
  '  "version": "4.5.6"', // 33
  '}', // 34
  '```', // 35
  '', // 36
  '```json', // 37
  '{ "env": { "A": "1" }, "version": "9.9.9", "name": "not-an-entry" }', // 38
  '```', // 39
  '', // 40
  '```bash', // 41
  'pnpm dlx some-runner@1.2.3 init', // 42
  'pip install requests==2.32.3', // 43
  '```', // 44
  '', // 45
  '```dockerfile', // 46
  'ARG TOOL_VERSION=0.1.1', // 47
  'ARG OTHER_VERSION=${X}', // 48
  '```', // 49
  '',
].join('\n');

const OTHER_SKILL = ['# Other', '', '```nc:dep', 'qrcode@1.5.4', '```', ''].join('\n');

const CLI_TOOLS = [
  '[', // 1
  '  {', // 2
  '    "name": "agent-browser",', // 3
  '    "version": "0.27.1",', // 4
  '    "onlyBuilt": true', // 5
  '  },', // 6
  '  { "name": "tiny", "version": "1.0.0" }', // 7
  ']', // 8
  '',
].join('\n');

const VERSIONS = JSON.stringify(
  {
    src: 'https://example.com/repo',
    commit: '0123456789abcdef0123456789abcdef01234567',
    image: `docker.io/x/y:1@sha256:${'a'.repeat(64)}`,
    gateway: '1.41.0',
    platform: 'linux/amd64',
    sdk: '3.1.0-rc.1',
  },
  null,
  2,
);

const fixture = () =>
  makeRepo({
    '.claude/skills/add-chat/SKILL.md': CHAT_SKILL,
    '.claude/skills/add-chat/docs.md': 'If it fails: `pnpm install local-adapter@1.0.0`\n',
    '.claude/skills/add-chat/patches/@scope__sdk@3.1.0-rc.1.patch': 'diff --git a/x b/x\n',
    '.claude/skills/add-chat/prose-cli.test.ts': "expect(entry).toEqual({ name: 'prose-cli', version: '4.5.6' });\n",
    '.claude/skills/add-chat/versions.json': VERSIONS,
    '.claude/skills/add-chat/proxy/go.mod': 'module example.com/proxy\n',
    '.claude/skills/add-other/SKILL.md': OTHER_SKILL,
    'container/cli-tools.json': CLI_TOOLS,
  });

describe('installSpecs', () => {
  it('takes exact name@version tokens after an install verb, per shell segment', () => {
    expect(installSpecs('npm install -g @microsoft/teams.cli@3.0.2 --loglevel=error')).toEqual([
      '@microsoft/teams.cli@3.0.2',
    ]);
    expect(installSpecs('command -v x || npm i -g a@1.0.0 && pnpm add "b@2.0.0" c@^3.0.0')).toEqual([
      'a@1.0.0',
      'b@2.0.0',
    ]);
    expect(installSpecs('npx -y create-thing@4.0.0-beta.2 my-app; echo d@5.0.0')).toEqual([
      'create-thing@4.0.0-beta.2',
    ]);
  });

  it('ignores ranges, tags, placeholders and non-install commands', () => {
    expect(installSpecs('npm install -g foo@latest bar@^1.2.3 {{pkg}}@1.0.0')).toEqual([]);
    expect(installSpecs('pnpm install --frozen-lockfile')).toEqual([]);
    expect(installSpecs('pnpm exec tsx scripts/x.ts foo@1.0.0')).toEqual([]);
    expect(installSpecs('npm init foo@1.0.0')).toEqual([]);
  });

  it('ignores shell comments', () => {
    expect(installSpecs('npm install tool@1.0.0 # replaced old-tool@0.1.0')).toEqual(['tool@1.0.0']);
    expect(installSpecs('# npm install -g old@1.0.0')).toEqual([]);
    expect(installSpecs('npm install --prefix "./a # b" foo@1.0.0')).toEqual(['foo@1.0.0']);
    expect(installSpecs('npm install --prefix "foo@1.0.0 cache" bar@2.0.0')).toEqual(['bar@2.0.0']);
  });

  it('reads the other one-off and global forms', () => {
    expect(installSpecs('yarn dlx a@1.0.0 && bun x b@2.0.0 && yarn global add c@3.0.0')).toEqual([
      'a@1.0.0',
      'b@2.0.0',
      'c@3.0.0',
    ]);
    expect(installSpecs('npm exec --package=d@4.0.0 -- d --help')).toEqual(['d@4.0.0']);
  });
});

describe('scanSkill', () => {
  const scan = scanSkill('.claude/skills/add-chat/SKILL.md', CHAT_SKILL);
  const pin = (name: string) => scan.npm.filter((p) => p.name === name);

  it('reads nc:dep specs at their own lines, with manager, cwd and when', () => {
    expect(pin('local-adapter')).toMatchObject([
      { version: '1.0.0', line: 8, via: 'nc:dep', detail: 'when:backend=local' },
    ]);
    expect(pin('@scope/sdk')).toMatchObject([
      { version: '3.1.0-rc.1', line: 17, detail: 'manager:bun cwd:container/agent-runner', edit: 'spec' },
    ]);
  });

  it('includes every when: branch', () => {
    expect(pin('hosted-sdk')).toMatchObject([{ line: 12, detail: 'when:backend=hosted' }]);
    expect(pin('qrcode')).toMatchObject([{ line: 13, detail: 'when:backend=hosted' }]);
  });

  it('reads cli-tools entries from nc:json-merge and prose json blocks, at the "version" line', () => {
    expect(pin('@scope/tool')).toMatchObject([
      { line: 21, via: 'nc:run', edit: 'spec' },
      { line: 27, via: 'nc:json-merge', edit: 'json' },
    ]);
    expect(pin('prose-cli')).toMatchObject([{ version: '4.5.6', line: 33, via: 'json block', edit: 'json' }]);
    expect(pin('not-an-entry')).toEqual([]);
  });

  it('reads installs in plain code blocks', () => {
    expect(pin('some-runner')).toMatchObject([{ version: '1.2.3', line: 42, via: 'code block' }]);
  });

  it('lists pip pins and Dockerfile version ARGs as not covered', () => {
    expect(scan.other.map((o) => [o.pin, o.kind, o.source])).toEqual([
      ['requests==2.32.3', 'pip', '.claude/skills/add-chat/SKILL.md'],
      ['TOOL_VERSION=0.1.1', 'binary (Dockerfile ARG)', '.claude/skills/add-chat/SKILL.md'],
    ]);
    expect(scan.problems).toEqual([]);
  });

  it('ignores a json block when the skill never names cli-tools.json', () => {
    const md = '```json\n{ "name": "x", "version": "1.0.0" }\n```\n';
    expect(scanSkill('s/SKILL.md', md).npm).toEqual([]);
  });

  it('reports an nc:dep line that is not name@exact-version', () => {
    const md = '```nc:dep\nleft-pad\nright-pad@^1.0.0\n```\n';
    expect(scanSkill('s/SKILL.md', md).problems).toEqual([
      's/SKILL.md:2: "left-pad@" is not an npm name pinned to an exact version',
      's/SKILL.md:3: "right-pad@^1.0.0" is not an npm name pinned to an exact version',
    ]);
  });
});

describe('not covered', () => {
  it('lists unpinned installs and base images in dockerfile fences', () => {
    const md = [
      '```bash',
      'pnpm add left-pad && npm i -g right-pad@latest && npx tsx x.ts',
      '```',
      '```dockerfile',
      'FROM node:22-slim AS build',
      'FROM build',
      'FROM ${BASE}',
      '```',
      '',
    ].join('\n');
    expect(scanSkill('s/SKILL.md', md).other.map((o) => `${o.kind}: ${o.pin}`)).toEqual([
      'unpinned npm install: left-pad',
      'unpinned npm install: right-pad@latest',
      'container image (Dockerfile FROM): node:22-slim',
    ]);
  });

  it("lists a skill's Dockerfile base images and an npm manifest with dependencies", () => {
    const root = makeRepo({
      '.claude/skills/x/assets/proxy.Dockerfile':
        'FROM rust:1.93.0-alpine AS a\nFROM alpine:3.22\nCOPY --from=a /x /x\n',
      '.claude/skills/x/tool/package.json': JSON.stringify({ name: 'tool', dependencies: { ws: '8.0.0' } }),
      '.claude/skills/x/empty/package.json': JSON.stringify({ name: 'empty' }),
      '.claude/skills/x/broken/versions.json': '{',
    });
    const scan = scanSkillFiles(root, '.claude/skills/x');
    expect(scan.other.map((o) => `${o.kind}: ${o.pin} @ ${o.source}`)).toEqual([
      'container image (Dockerfile FROM): rust:1.93.0-alpine @ .claude/skills/x/assets/proxy.Dockerfile',
      'container image (Dockerfile FROM): alpine:3.22 @ .claude/skills/x/assets/proxy.Dockerfile',
      'npm manifest: package.json @ .claude/skills/x/tool/package.json',
    ]);
    expect(scan.problems).toEqual(['.claude/skills/x/broken/versions.json: not valid JSON']);
  });
});

describe('scanCliTools', () => {
  it('locates each entry at its "version" line', () => {
    const scan = scanCliTools('container/cli-tools.json', CLI_TOOLS);
    expect(scan.npm.map((p) => [p.name, p.version, p.line])).toEqual([
      ['agent-browser', '0.27.1', 4],
      ['tiny', '1.0.0', 7],
    ]);
  });

  it('reports a file that is not an array of entries', () => {
    expect(scanCliTools('c.json', '{').problems).toEqual(['c.json: not valid JSON']);
    expect(scanCliTools('c.json', '{}').problems).toEqual(['c.json: expected an array of {"name","version"} entries']);
  });

  it('rejects entries that share a line, which sync could not edit safely', () => {
    const json = '[{"name":"a","version":"1.0.0"},{"name":"b","ver\\u0073ion":"1.0.0"}]\n';
    expect(scanCliTools('c.json', json)).toEqual({
      npm: [],
      other: [],
      problems: ['c.json: put each entry on its own lines; sync edits a pin by line'],
    });
  });
});

describe('generate', () => {
  it('writes one entry per package with every source, and the not-covered sidecar', () => {
    const gen = generate(collect(fixture()));
    expect(gen.problems).toEqual([]);
    const manifest = JSON.parse(gen.manifest);
    expect(manifest.packageManager).toBe('npm@10.9.9'); // keeps Dependabot off the root pnpm lockfile
    expect(manifest.dependencies).toEqual({
      '@scope/sdk': '3.1.0-rc.1',
      '@scope/tool': '0.9.0',
      'agent-browser': '0.27.1',
      'hosted-sdk': '2.0.0',
      'local-adapter': '1.0.0',
      'prose-cli': '4.5.6',
      qrcode: '1.5.4',
      'some-runner': '1.2.3',
      tiny: '1.0.0',
    });
    expect(manifest.skillPins.qrcode).toEqual({
      version: '1.5.4',
      sources: [
        '.claude/skills/add-chat/SKILL.md nc:dep when:backend=hosted',
        '.claude/skills/add-other/SKILL.md nc:dep',
      ],
    });
    expect(manifest.skillPins['agent-browser'].sources).toEqual(['container/cli-tools.json']);

    const other = JSON.parse(gen.notCovered).pins.map((o: { pin: string; source: string }) => `${o.pin} @ ${o.source}`);
    expect(other).toEqual([
      'requests==2.32.3 @ .claude/skills/add-chat/SKILL.md',
      'TOOL_VERSION=0.1.1 @ .claude/skills/add-chat/SKILL.md',
      'go.mod @ .claude/skills/add-chat/proxy/go.mod',
      'commit=0123456789abcdef0123456789abcdef01234567 @ .claude/skills/add-chat/versions.json',
      `image=docker.io/x/y:1@sha256:${'a'.repeat(64)} @ .claude/skills/add-chat/versions.json`,
      'gateway=1.41.0 @ .claude/skills/add-chat/versions.json',
      'sdk=3.1.0-rc.1 @ .claude/skills/add-chat/versions.json',
    ]);
  });

  it('fails when one package is pinned at two versions', () => {
    const root = makeRepo({
      '.claude/skills/a/SKILL.md': '```nc:dep\nws@8.0.0\n```\n',
      '.claude/skills/b/SKILL.md': '# b\n\n```nc:dep\nws@8.1.0\n```\n',
    });
    expect(generate(collect(root)).problems).toEqual([
      'ws is pinned at 2 versions (8.0.0 at .claude/skills/a/SKILL.md:2, 8.1.0 at .claude/skills/b/SKILL.md:4); pin one version everywhere',
    ]);
    expect(check(root).ok).toBe(false);
  });
});

describe('runGenerate', () => {
  it('will not drop a pending Dependabot bump unless forced', () => {
    const root = fixture();
    regenerate(root);
    edit(root, MANIFEST, '"qrcode": "1.5.4"', '"qrcode": "1.5.5"');
    const refused = runGenerate(root);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('qrcode 1.5.4 -> 1.5.5');
    expect(JSON.parse(read(root, MANIFEST)).dependencies.qrcode).toBe('1.5.5');
    expect(runGenerate(root, true).ok).toBe(true);
    expect(JSON.parse(read(root, MANIFEST)).dependencies.qrcode).toBe('1.5.4');
  });
});

describe('check', () => {
  it('passes on a fresh generate', () => {
    const root = fixture();
    regenerate(root);
    expect(check(root)).toEqual({ ok: true, message: '.github/skill-pins matches the skills.' });
  });

  it('asks for generate when a skill pin changed', () => {
    const root = fixture();
    regenerate(root);
    edit(root, '.claude/skills/add-chat/SKILL.md', 'local-adapter@1.0.0', 'local-adapter@1.1.0');
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('local-adapter: the skills pin 1.1.0 (.claude/skills/add-chat/SKILL.md:8)');
    expect(result.message).toContain('Run `pnpm run skill-pins:generate`');
  });

  it('passes when prose only moves a pin to another line', () => {
    const root = fixture();
    regenerate(root);
    edit(root, '.claude/skills/add-other/SKILL.md', '# Other\n', '# Other\n\nMore prose.\n');
    expect(check(root).ok).toBe(true);
  });

  it('asks for generate when a skill adds a source for a pinned version', () => {
    const root = fixture();
    regenerate(root);
    mkdirSync(join(root, '.claude/skills/add-third'));
    writeFileSync(join(root, '.claude/skills/add-third/SKILL.md'), OTHER_SKILL);
    const result = check(root);
    expect(result.message).toContain('pin sources changed, or the file was edited');
    expect(result.message).toContain('Run `pnpm run skill-pins:generate`');
  });

  it('asks for sync when the shadow file was bumped on its own (Dependabot)', () => {
    const root = fixture();
    regenerate(root);
    edit(root, MANIFEST, '"qrcode": "1.5.4"', '"qrcode": "1.5.5"');
    const result = check(root);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      'qrcode 1.5.4 -> 1.5.5, pinned at .claude/skills/add-chat/SKILL.md:13, .claude/skills/add-other/SKILL.md:4',
    );
    expect(result.message).toContain('Run `pnpm run skill-pins:sync`');
  });

  it('lists other stale rows next to a bump', () => {
    const root = fixture();
    regenerate(root);
    edit(root, MANIFEST, '"qrcode": "1.5.4"', '"qrcode": "1.5.5"');
    edit(root, '.claude/skills/add-chat/SKILL.md', 'local-adapter@1.0.0', 'local-adapter@1.1.0');
    const message = check(root).message;
    expect(message).toContain('qrcode 1.5.4 -> 1.5.5');
    expect(message).toContain('Also out of date (sync regenerates these too):');
    expect(message).toContain('local-adapter: the skills pin 1.1.0');
  });

  it('says a bump to a range must be pinned, instead of asking for sync', () => {
    const root = fixture();
    regenerate(root);
    edit(root, MANIFEST, '"qrcode": "1.5.4"', '"qrcode": "^1.5.5"');
    expect(check(root).message).toBe(
      [
        `${MANIFEST} asks for versions that are not exact; skill pins must be:`,
        '  qrcode: "^1.5.5"',
        'Pin an exact version there, or close the update.',
      ].join('\n'),
    );
  });

  it('stops on a version changed on both sides, even next to a plain bump', () => {
    const root = fixture();
    regenerate(root);
    edit(root, MANIFEST, '"qrcode": "1.5.4"', '"qrcode": "1.5.5"');
    edit(root, MANIFEST, '"tiny": "1.0.0"', '"tiny": "1.0.2"');
    edit(root, 'container/cli-tools.json', '"version": "1.0.0"', '"version": "1.0.1"');
    expect(check(root)).toEqual({
      ok: false,
      message: [
        'Skill pins and the shadow file both changed:',
        '  tiny: a skill now pins 1.0.1 but the shadow file was bumped to 1.0.2',
        'Make the skill and .github/skill-pins/package.json agree on the version you want, then run `pnpm run skill-pins:sync`.',
      ].join('\n'),
    });
  });

  it('asks for generate when not-covered.json is stale', () => {
    const root = fixture();
    regenerate(root);
    edit(root, '.claude/skills/add-chat/SKILL.md', 'ARG TOOL_VERSION=0.1.1', 'ARG TOOL_VERSION=0.2.0');
    expect(check(root).message).toContain(`${NOT_COVERED} is out of date`);
  });
});

describe('sync', () => {
  it('writes Dependabot bumps into every source, then check passes', () => {
    const root = fixture();
    regenerate(root);
    for (const [from, to] of [
      ['"local-adapter": "1.0.0"', '"local-adapter": "1.0.1"'],
      ['"@scope/tool": "0.9.0"', '"@scope/tool": "0.10.0"'],
      ['"prose-cli": "4.5.6"', '"prose-cli": "4.6.0"'],
      ['"agent-browser": "0.27.1"', '"agent-browser": "0.28.0"'],
      ['"@scope/sdk": "3.1.0-rc.1"', '"@scope/sdk": "3.1.0-rc12"'],
    ]) {
      edit(root, MANIFEST, from, to);
    }
    const before = read(root, '.claude/skills/add-chat/SKILL.md').split('\n');

    const result = sync(root);
    expect(result.ok).toBe(true);
    const after = read(root, '.claude/skills/add-chat/SKILL.md').split('\n');
    const changed = after.flatMap((l, i) => (l === before[i] ? [] : [`${i + 1}: ${l}`]));
    expect(changed).toEqual([
      '8: local-adapter@1.0.1',
      '17: @scope/sdk@3.1.0-rc12',
      '21: command -v tool >/dev/null || npm install -g @scope/tool@0.10.0 --loglevel=error',
      '27: { "name": "@scope/tool", "version": "0.10.0" }',
      '33:   "version": "4.6.0"',
    ]);
    expect(read(root, 'container/cli-tools.json')).toBe(CLI_TOOLS.replace('"0.27.1"', '"0.28.0"'));
    expect(result.message.split('Update these by hand; sync only rewrites the pins:\n')[1].split('\n')).toEqual([
      '  .claude/skills/add-chat/patches/@scope__sdk@3.1.0-rc.1.patch (3.1.0-rc.1)',
      '  .claude/skills/add-chat/versions.json:7 (3.1.0-rc.1)',
      '  .claude/skills/add-chat/docs.md:1 (1.0.0)',
      '  .claude/skills/add-chat/prose-cli.test.ts:1 (4.5.6)',
      'Review the diff and run the tests, then commit.',
    ]);
    expect(check(root).ok).toBe(true);
  });

  it('never reverts a pin changed in the skill', () => {
    const root = fixture();
    regenerate(root);
    edit(root, '.claude/skills/add-chat/SKILL.md', 'hosted-sdk@2.0.0', 'hosted-sdk@2.1.0');
    expect(sync(root)).toEqual({ ok: true, message: 'Nothing to sync; regenerated .github/skill-pins.' });
    expect(read(root, '.claude/skills/add-chat/SKILL.md')).toContain('hosted-sdk@2.1.0');
    expect(JSON.parse(read(root, MANIFEST)).dependencies['hosted-sdk']).toBe('2.1.0');
  });

  it('refuses while a version changed on both sides, and changes nothing', () => {
    const root = fixture();
    regenerate(root);
    edit(root, MANIFEST, '"qrcode": "1.5.4"', '"qrcode": "1.5.5"');
    edit(root, MANIFEST, '"tiny": "1.0.0"', '"tiny": "1.0.2"');
    edit(root, 'container/cli-tools.json', '"version": "1.0.0"', '"version": "1.0.1"');
    const manifest = read(root, MANIFEST);
    expect(sync(root).message).toContain('tiny: a skill now pins 1.0.1 but the shadow file was bumped to 1.0.2');
    expect(read(root, '.claude/skills/add-other/SKILL.md')).toBe(OTHER_SKILL);
    expect(read(root, MANIFEST)).toBe(manifest);
  });

  it('refuses when the shadow file is missing', () => {
    const root = fixture();
    expect(sync(root)).toEqual({
      ok: false,
      message: `${MANIFEST} is missing or not JSON; run \`pnpm run skill-pins:generate\`.`,
    });
  });

  it('refuses a pin it cannot find exactly once, and changes nothing', () => {
    const root = makeRepo({
      '.claude/skills/a/SKILL.md': '```nc:run effect:external\nnpm i -g t@1.0.0 && npx t@1.0.0 --version\n```\n',
    });
    regenerate(root);
    edit(root, MANIFEST, '"t": "1.0.0"', '"t": "1.0.1"');
    const skill = read(root, '.claude/skills/a/SKILL.md');
    expect(sync(root)).toEqual({
      ok: false,
      message: '.claude/skills/a/SKILL.md:2: expected "t@1.0.0" once; edit it by hand.',
    });
    expect(read(root, '.claude/skills/a/SKILL.md')).toBe(skill);
  });

  it('rewrites an npm exec --package= pin', () => {
    const root = makeRepo({ '.claude/skills/a/SKILL.md': '```bash\nnpm exec --package=d@4.0.0 -- d\n```\n' });
    regenerate(root);
    edit(root, MANIFEST, '"d": "4.0.0"', '"d": "4.1.0"');
    expect(sync(root).ok).toBe(true);
    expect(read(root, '.claude/skills/a/SKILL.md')).toContain('npm exec --package=d@4.1.0 -- d');
  });

  it('syncs the other bumps once the conflicting pin agrees (the advice in the conflict message)', () => {
    const root = fixture();
    regenerate(root);
    edit(root, MANIFEST, '"qrcode": "1.5.4"', '"qrcode": "1.5.5"');
    edit(root, MANIFEST, '"tiny": "1.0.0"', '"tiny": "1.0.2"');
    edit(root, 'container/cli-tools.json', '"version": "1.0.0"', '"version": "1.0.1"');
    expect(sync(root).ok).toBe(false);
    edit(root, MANIFEST, '"tiny": "1.0.2"', '"tiny": "1.0.1"'); // agree on the skill's version
    expect(sync(root).ok).toBe(true);
    expect(read(root, '.claude/skills/add-other/SKILL.md')).toContain('qrcode@1.5.5');
    expect(check(root).ok).toBe(true);
  });

  it('refuses a shadow version that is not exact, and changes nothing', () => {
    const root = fixture();
    regenerate(root);
    edit(root, MANIFEST, '"tiny": "1.0.0"', '"tiny": "^1.1.0"');
    const skill = read(root, '.claude/skills/add-chat/SKILL.md');
    expect(sync(root)).toEqual({
      ok: false,
      message: 'Skill pins must be exact versions; not syncing:\n  tiny: "^1.1.0"',
    });
    expect(read(root, 'container/cli-tools.json')).toBe(CLI_TOOLS);
    expect(read(root, '.claude/skills/add-chat/SKILL.md')).toBe(skill);
  });
});

describe('shell pins', () => {
  const SHELL_SKILL = [
    '# Shell', //  1
    '', //  2
    '```nc:run effect:external', //  3
    'echo "Do not run npm install foo@0.9.0"', //  4
    'npm install foo@1.0.0 @scope/foo@1.0.0 # foo@1.0.0 is vetted', //  5
    'npm install -g \\', //  6
    '  --loglevel=error \\', //  7
    '  bar@2.0.0', //  8
    '```', //  9
    '',
  ].join('\n');
  const shellRepo = () => makeRepo({ '.claude/skills/add-shell/SKILL.md': SHELL_SKILL });

  it('skips quoted text and comments, and follows continued lines', () => {
    const scan = scanSkill('.claude/skills/add-shell/SKILL.md', SHELL_SKILL);
    expect(scan.npm.map((p) => `${p.name}@${p.version}:${p.line}`)).toEqual([
      'foo@1.0.0:5',
      '@scope/foo@1.0.0:5',
      'bar@2.0.0:8',
    ]);
    expect(scan.problems).toEqual([]);
  });

  it('sync rewrites the whole word on its own line only', () => {
    const root = shellRepo();
    regenerate(root);
    edit(root, MANIFEST, '"foo": "1.0.0"', '"foo": "1.0.1"');
    edit(root, MANIFEST, '"bar": "2.0.0"', '"bar": "2.1.0"');
    expect(sync(root).ok).toBe(true);
    const lines = read(root, '.claude/skills/add-shell/SKILL.md').split('\n');
    expect(lines[4]).toBe('npm install foo@1.0.1 @scope/foo@1.0.0 # foo@1.0.0 is vetted');
    expect(lines[7]).toBe('  bar@2.1.0');
    expect(check(root).ok).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)('puts back the files it wrote when a later write fails', () => {
    const root = fixture();
    regenerate(root);
    edit(root, MANIFEST, '"qrcode": "1.5.4"', '"qrcode": "1.5.5"');
    const first = read(root, '.claude/skills/add-chat/SKILL.md');
    const locked = join(root, '.claude/skills/add-other');
    chmodSync(locked, 0o555); // the temp file cannot be created there
    try {
      const result = sync(root);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/^Could not write the skills \(EACCES.*\)\. Nothing changed\.$/);
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(read(root, '.claude/skills/add-chat/SKILL.md')).toBe(first);
    expect(read(root, '.claude/skills/add-other/SKILL.md')).toBe(OTHER_SKILL);
  });

  it('refuses a bump that breaks the skill lint, and changes nothing', () => {
    const root = makeRepo({
      'pnpm-lock.yaml':
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      chat:\n        specifier: 4.29.0\n        version: 4.29.0\n",
      '.claude/skills/add-slack/SKILL.md': '```nc:dep\n@chat-adapter/slack@4.29.0\n```\n',
    });
    regenerate(root);
    edit(root, MANIFEST, '"@chat-adapter/slack": "4.29.0"', '"@chat-adapter/slack": "4.30.0"');
    expect(sync(root)).toEqual({
      ok: false,
      message: [
        'Not syncing: the new versions break the skill lint.',
        '  .claude/skills/add-slack/SKILL.md:1: @chat-adapter/slack pinned 4.30.0 but our chat core is 4.29.0 — a @chat-adapter/* adapter must match the chat package',
        'For @chat-adapter/*, move the root `chat` package to the same version first, or close the update.',
      ].join('\n'),
    });
    expect(read(root, '.claude/skills/add-slack/SKILL.md')).toContain('@chat-adapter/slack@4.29.0');
  });
});

describe('verifySync', () => {
  it('flags any version that changed other than the bumped ones', () => {
    const root = fixture();
    const before = collect(root);
    const pins = new Map<string, typeof before.npm>();
    for (const p of before.npm) pins.set(p.name, [...(pins.get(p.name) ?? []), p]);
    expect(verifySync(pins, before, new Map())).toEqual([]);

    edit(root, 'container/cli-tools.json', '"version": "1.0.0"', '"version": "1.0.9"');
    expect(verifySync(pins, collect(root), new Map([['agent-browser', '0.28.0']]))).toEqual([
      'container/cli-tools.json:4: agent-browser is 0.27.1, expected 0.28.0',
      'container/cli-tools.json:7: tiny is 1.0.9, expected 1.0.0',
    ]);
  });
});

describe('on this repo', () => {
  const scan = collect(process.cwd());

  it('mirrors every nc:dep spec in the skills, with no conflicts', () => {
    expect(generate(scan).problems).toEqual([]);
    const mirrored = new Set(scan.npm.filter((p) => p.via === 'nc:dep').map((p) => `${p.file}#${p.name}@${p.version}`));
    const specs = readdirSync('.claude/skills')
      .map((name) => `.claude/skills/${name}/SKILL.md`)
      .filter((file) => existsSync(file))
      .flatMap((file) =>
        parseDirectives(readFileSync(file, 'utf8'))
          .filter((d) => d.kind === 'dep')
          .flatMap((d) => d.body.map((spec) => `${file}#${spec}`)),
      );
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(mirrored).toContain(spec);
  });
});
