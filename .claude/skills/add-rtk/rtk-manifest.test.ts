/**
 * Guard for the rtk integration points (host tree, vitest).
 *
 * add-rtk has two functional reach-ins and one runtime lookup, and each of the
 * three has already failed silently in this skill's history:
 *
 *  1. The image install. rtk is a prebuilt release binary, not an npm package,
 *     and it only works from a directory on the container PATH. An earlier
 *     shape mounted the host binary instead; additional mounts are rewritten
 *     to /workspace/extra/<basename>, which is not on PATH, so `rtk` was never
 *     found and the hook failed 127 on every Bash call. This asserts the exact
 *     pinned manifest entry, and that the installer's destination is the one
 *     on PATH.
 *
 *  2. The `PreToolUse` hook write. The `jq` programs in SKILL.md and REMOVE.md
 *     are extracted from those documents and run against a fixture
 *     settings.json — the documented command IS the code here, so it is what
 *     gets executed rather than a paraphrase of it.
 *
 *  3. The Verify step's container lookup. Session containers are named from the
 *     install slug and session id, so a `--filter name=<group-id>` can never
 *     match. This joins the documents to the real driver: the label constants
 *     in src/drivers/types.ts and `agentContainerName()` in
 *     src/drivers/docker-driver.ts.
 *
 * Hermetic: no network, no docker, no image build. The manifest seam's own
 * behavior (that a binary entry lands executable on PATH) is exercised for real
 * in container/cli-tools.test.ts, which this skill's apply step also runs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Repo root — the dir holding container/, wherever this file is copied to. */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'container', 'cli-tools.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('container/cli-tools.json not found walking up from ' + __dirname);
}

const root = repoRoot();
const skillDir = join(root, '.claude', 'skills', 'add-rtk');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
const removal = readFileSync(join(skillDir, 'REMOVE.md'), 'utf8');
const installer = readFileSync(join(root, 'container', 'install-cli-tools.sh'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'container', 'cli-tools.json'), 'utf8')) as Array<
  Record<string, unknown>
>;

/**
 * The pinned release, as verified against upstream's checksums.txt for v0.45.0.
 * Written out in full so a drifted URL, a bumped version, or an edited checksum
 * goes red here — the checksum is this entry's entire supply-chain guarantee.
 */
const PINNED = {
  name: 'rtk',
  version: '0.45.0',
  binary: {
    amd64: {
      url: 'https://github.com/rtk-ai/rtk/releases/download/v0.45.0/rtk-x86_64-unknown-linux-musl.tar.gz',
      sha256: 'c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4',
    },
    arm64: {
      url: 'https://github.com/rtk-ai/rtk/releases/download/v0.45.0/rtk-aarch64-unknown-linux-gnu.tar.gz',
      sha256: '80a746dd305ef944ff50ef011ae4ce3878dd5ba88dfe35d859d05498191637c3',
    },
  },
};

describe('rtk is installed into the agent image', () => {
  const entries = manifest.filter((tool) => tool.name === 'rtk');

  it('has exactly one rtk entry (json-merge is keyed on name)', () => {
    expect(entries).toHaveLength(1);
  });

  it('is the pinned release archive, checksums and all', () => {
    expect(entries[0]).toEqual(PINNED);
  });

  it('is installed as a release binary, never from npm', () => {
    // `rtk` on the npm registry is cliffano/rtk, an unrelated release-versioning
    // tool that ALSO installs a bin called `rtk`. An entry without `binary`
    // would be resolved from npm, handing the agent the wrong program under
    // the right name.
    expect(entries[0].binary, 'rtk must be a binary entry').toBeTruthy();
    expect(entries[0].onlyBuilt, 'onlyBuilt applies to npm entries only').toBeUndefined();
    expect(skill).toMatch(/rtk is not an npm package/i);
  });

  it('lands in a directory that is on the container PATH', () => {
    // The hook rewrites a command to `rtk <subcommand>`, which resolves through
    // PATH. /usr/local/bin is on it; /workspace/extra (where additional mounts
    // are rewritten to) is not.
    expect(installer).toContain('CLI_TOOLS_BIN_DIR:-/usr/local/bin');
    expect(skill).toContain('/usr/local/bin/rtk');
  });
});

describe('the PreToolUse hook write documented in SKILL.md', () => {
  /** The first `jq '<program>'` in a document. The programs use no `'`. */
  function firstJqProgram(document: string, label: string): string {
    const match = /jq '([^']+)'/.exec(document);
    if (!match) throw new Error(`no jq program found in ${label}`);
    return match[1];
  }

  const applyProgram = firstJqProgram(skill, 'SKILL.md');
  const removeProgram = firstJqProgram(removal, 'REMOVE.md');

  /**
   * A group settings.json shaped like the one NanoClaw scaffolds (a PreCompact
   * hook the runner owns, memory env) plus a foreign PreToolUse entry, so
   * clobbering either shows up.
   */
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rtk-settings-'));
    const file = join(dir, 'settings.json');
    writeFileSync(
      file,
      JSON.stringify(
        {
          autoMemoryEnabled: false,
          env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
          hooks: {
            PreCompact: [{ hooks: [{ type: 'command', command: 'bun /app/src/compact-instructions.ts' }] }],
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-guard' }] }],
          },
        },
        null,
        2,
      ),
    );
    return file;
  }

  type Hook = { type?: string; command?: string };
  type Entry = { matcher?: string; hooks?: Hook[] };
  type Settings = { hooks?: { PreToolUse?: Entry[]; PreCompact?: unknown }; env?: Record<string, string> };

  function apply(program: string, file: string): Settings {
    const next = execFileSync('jq', [program, file], { encoding: 'utf8' });
    writeFileSync(file, next);
    return JSON.parse(next) as Settings;
  }

  const rtkEntries = (settings: Settings): Entry[] =>
    (settings.hooks?.PreToolUse ?? []).filter((entry) =>
      (entry.hooks ?? []).some((h) => h.command === 'rtk hook claude'),
    );

  it('adds one Bash hook running `rtk hook claude`', () => {
    const settings = apply(applyProgram, fixture());
    expect(rtkEntries(settings)).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] },
    ]);
  });

  it('is idempotent — re-applying does not duplicate the hook', () => {
    const file = fixture();
    apply(applyProgram, file);
    const settings = apply(applyProgram, file);
    expect(rtkEntries(settings)).toHaveLength(1);
    expect(settings.hooks?.PreToolUse).toHaveLength(2);
  });

  it('leaves other hooks and settings alone', () => {
    const settings = apply(applyProgram, fixture());
    expect(settings.hooks?.PreToolUse?.some((e) => (e.hooks ?? []).some((h) => h.command === 'other-guard'))).toBe(
      true,
    );
    // The runner's own PreCompact hook and the memory env must survive: the
    // group's settings.json is not this skill's file.
    expect(settings.hooks?.PreCompact).toBeTruthy();
    expect(settings.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it('is fully reversed by REMOVE.md, leaving other hooks in place', () => {
    const file = fixture();
    apply(applyProgram, file);
    const settings = apply(removeProgram, file);
    expect(rtkEntries(settings)).toEqual([]);
    expect(settings.hooks?.PreToolUse?.some((e) => (e.hooks ?? []).some((h) => h.command === 'other-guard'))).toBe(
      true,
    );
    expect(settings.hooks?.PreCompact).toBeTruthy();
  });

  it('targets the settings file the host mounts into the container', () => {
    expect(skill).toContain('data/v2-sessions/<group-id>/.claude-shared/settings.json');
    expect(removal).toContain('data/v2-sessions/<group-id>/.claude-shared/settings.json');
  });

  it('survives the host reconcile pass over that file', async () => {
    // The host rewrites every group's settings.json (memory reconciliation) on
    // startup and group init. The hook is written by an operator, not by that
    // code, so this is the seam where it would silently disappear.
    const { migrateClaudeMemorySettings } = (await import(
      pathToFileURL(join(root, 'src', 'migrate-claude-memory-settings.ts')).href
    )) as { migrateClaudeMemorySettings: (file: string) => boolean };

    const file = fixture();
    apply(applyProgram, file);
    migrateClaudeMemorySettings(file);
    const settings = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    expect(rtkEntries(settings)).toHaveLength(1);
  });
});

describe('the Verify step finds the container the way the driver names it', () => {
  it('filters on the labels the driver stamps, not on a name', async () => {
    const { LABELS } = (await import(pathToFileURL(join(root, 'src', 'drivers', 'types.ts')).href)) as {
      LABELS: Record<string, string>;
    };
    expect(skill).toContain(`label=${LABELS.group}=<group-id>`);
    expect(skill).toContain(`label=${LABELS.role}=agent`);
    expect(skill).not.toMatch(/--filter\s+"?name=<group-id>/);
  });

  it('could not have found it by group id — the name does not contain one', async () => {
    const { agentContainerName } = (await import(
      pathToFileURL(join(root, 'src', 'drivers', 'docker-driver.ts')).href
    )) as {
      agentContainerName: (spec: unknown) => string;
    };
    const { fixtureSpec } = (await import(pathToFileURL(join(root, 'src', 'drivers', 'spec-fixture.ts')).href)) as {
      fixtureSpec: (overrides?: Record<string, unknown>) => { key: Record<string, string> };
    };
    const spec = fixtureSpec({
      key: { installSlug: 'slug', agentGroupId: 'ag-1776342942165-ptgddd', sessionId: 'sess-1' },
    });
    expect(agentContainerName(spec)).not.toContain('ag-1776342942165-ptgddd');
  });

  it('guards the lookup before exec, so an empty result is a message not a crash', () => {
    // `docker exec "" rtk --version` dies with "invalid container name or ID".
    expect(skill).toMatch(/if \[ -z "\$name" \]/);
  });
});
