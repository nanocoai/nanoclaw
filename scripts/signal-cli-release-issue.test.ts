import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs the weekly job against a stub `gh` that serves a fixture release and
// search result and records what `gh issue create` would have filed.
const SCRIPT = path.resolve(__dirname, 'signal-cli-release-issue.sh');
const DIGEST = 'a8fab78b5e8053abf3db5725272957ad11d1745b9a16848ddb2ace4743dfa5d5';
const DAY = 24 * 3600 * 1000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'signal-cli-release-'));
  const gh = path.join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
d=$(dirname "$0")
case "$1 $2" in
  "api repos/AsamK/signal-cli/releases/latest") cat "$d/release.json" ;;
  "api -X") cat "$d/search.json" ;;
  "issue create") printf '%s\\n' "$@" > "$d/create.args"; cat > "$d/create.body" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Fixture {
  pinned?: string;
  tag?: string;
  ageDays?: number;
  assetAgeDays?: number;
  digest?: string | null;
  existing?: string[];
  incomplete?: boolean;
}

function run({
  pinned = '0.14.9',
  tag = 'v0.15.0',
  ageDays = 4,
  assetAgeDays = ageDays,
  digest = DIGEST,
  existing = [],
  incomplete = false,
}: Fixture = {}) {
  for (const f of ['create.args', 'create.body']) rmSync(path.join(dir, f), { force: true });
  const installer = path.join(dir, 'install-signal-cli.sh');
  writeFileSync(installer, `VERSION="${pinned}"\nSHA256="${'0'.repeat(64)}"\n`);
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // The Java tarball comes first so the Linux-native one must be picked by name.
  const java = {
    name: `signal-cli-${tag.slice(1)}.tar.gz`,
    digest: `sha256:${'1'.repeat(64)}`,
    updated_at: daysAgo(30),
  };
  const asset = {
    name: `signal-cli-${tag.slice(1)}-Linux-native.tar.gz`,
    digest: digest && `sha256:${digest}`,
    updated_at: daysAgo(assetAgeDays),
  };
  writeFileSync(
    path.join(dir, 'release.json'),
    JSON.stringify({ tag_name: tag, published_at: daysAgo(ageDays), assets: [java, asset] }),
  );
  writeFileSync(
    path.join(dir, 'search.json'),
    JSON.stringify({
      total_count: existing.length,
      incomplete_results: incomplete,
      items: existing.map((title) => ({ title })),
    }),
  );
  const res = spawnSync('bash', [SCRIPT, installer], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'nanocoai/nanoclaw' },
  });
  const read = (f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : null);
  return { ...res, args: read('create.args'), body: read('create.body') };
}

describe('signal-cli-release-issue', () => {
  it('opens an issue with the lines to paste for a newer release at least 3 days old', () => {
    // Numeric compare (0.14.10 > 0.14.9) and four-part upstream tags.
    for (const [pinned, tag] of [
      ['0.14.9', 'v0.15.0'],
      ['0.14.9', 'v0.14.10'],
      ['0.14.4', 'v0.14.4.1'],
    ]) {
      const res = run({ pinned, tag });
      expect(res.status).toBe(0);
      expect(res.args).toContain(`--title\nsignal-cli ${tag.slice(1)}: update the Linux pin\n`);
      expect(res.body).toContain(`VERSION="${tag.slice(1)}"\nSHA256="${DIGEST}"\n`);
    }
  });

  it('does nothing when the pin is the latest release or newer', () => {
    for (const tag of ['v0.14.9', 'v0.14.8']) {
      const res = run({ tag });
      expect(res.status).toBe(0);
      expect(res.args).toBeNull();
    }
  });

  it('waits while the release or its Linux asset is under 3 days old', () => {
    for (const fixture of [{ ageDays: 2 }, { ageDays: 10, assetAgeDays: 1 }]) {
      const res = run(fixture);
      expect(res.status).toBe(0);
      expect(res.args).toBeNull();
    }
  });

  it('never opens a second issue for the same version', () => {
    const existing = run({ existing: ['signal-cli 0.15.0: update the Linux pin'] });
    expect(existing.status).toBe(0);
    expect(existing.args).toBeNull();
    const incomplete = run({ incomplete: true });
    expect(incomplete.status).toBe(1);
    expect(incomplete.args).toBeNull();
  });

  it('fails without opening an issue when the Linux-native digest is missing', () => {
    const res = run({ digest: null });
    expect(res.status).toBe(1);
    expect(res.args).toBeNull();
  });
});
