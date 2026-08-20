import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// Guards the cli-tools.json seam: the CLIs the agent invokes at runtime are
// installed from the manifest (a skill adds one with a json-merge), not
// hand-edited into the Dockerfile. These go red on a bad merge that drops a
// baseline tool, or on dewiring the Dockerfile / switching the installer off
// the pnpm supply-chain path.
//
// Two entry kinds. An entry without `binary` is an npm package installed with
// `pnpm install -g`. An entry WITH `binary` is a prebuilt release archive for a
// CLI that is not on npm: fetched per-arch, checksum-verified, and installed
// into /usr/local/bin. The second kind exists because a tool that lands
// anywhere else is not on the container PATH, which is a silent failure — the
// agent's command simply is not found — so the installer's placement is
// exercised here for real, not asserted as a source line.
const here = dirname(fileURLToPath(import.meta.url));

type BinaryTarget = { url: string; sha256: string };
type Tool = {
  name: string;
  version: string;
  onlyBuilt?: boolean;
  binary?: Record<string, BinaryTarget>;
};

const manifest = JSON.parse(readFileSync(join(here, 'cli-tools.json'), 'utf8')) as Tool[];
const dockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8');
const installerPath = join(here, 'install-cli-tools.sh');
const installer = readFileSync(installerPath, 'utf8');

const npmTools = manifest.filter((tool) => !tool.binary);
const binaryTools = manifest.filter((tool) => tool.binary);

describe('cli-tools manifest', () => {
  it('is a non-empty array of { name, version }', () => {
    expect(Array.isArray(manifest)).toBe(true);
    expect(manifest.length).toBeGreaterThan(0);
    for (const tool of manifest) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.version).toBe('string');
      expect(tool.version.length).toBeGreaterThan(0);
    }
  });

  it('has unique tool names (json-merge is keyed on name)', () => {
    const names = manifest.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('pins every version to an exact semver (no latest, no ranges — supply-chain policy)', () => {
    for (const tool of manifest) {
      expect(tool.version, `${tool.name} must be an exact semver, not "${tool.version}"`).toMatch(
        /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
      );
    }
  });

  it('keeps the baseline CLIs the agent depends on', () => {
    const names = manifest.map((t) => t.name);
    // Only what the agent cannot function without: a browser it drives, and the
    // provider CLI it runs. Everything else is opt-in — a tool nobody asked for
    // is bytes in every image, on every machine, for everyone.
    for (const required of ['agent-browser', '@anthropic-ai/claude-code']) {
      expect(names).toContain(required);
    }
  });

  it('carries only the keys the installer reads, correctly typed', () => {
    // The installer consumes exactly `name`, `version`, `onlyBuilt` and
    // `binary`. A key it does not read is either a typo (`onlyBuild`, `pin`)
    // that silently does nothing, or an expectation the seam does not honour.
    // Deliberately NOT a name blacklist: this manifest is the opt-in surface
    // every `/add-<cli>` skill appends to, so a test that named specific tools
    // as forbidden could never be green after a legitimate install.
    const allowed = new Set(['name', 'version', 'onlyBuilt', 'binary']);
    for (const tool of manifest) {
      for (const key of Object.keys(tool)) {
        expect(allowed.has(key), `${(tool as { name?: string }).name}: unknown manifest key "${key}"`).toBe(true);
      }
      if ('onlyBuilt' in tool) {
        expect(typeof tool.onlyBuilt, `${tool.name}: onlyBuilt must be a boolean`).toBe('boolean');
      }
    }
  });

  it('every npm name is an installable npm package name (the spec is name@version)', () => {
    // `pnpm install -g <name>@<version>` word-splits on spaces and reads `@`
    // as the version delimiter, so a scope typo or an embedded range in the
    // name installs the wrong thing (or nothing) with no build error.
    const npmName = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
    for (const tool of npmTools) {
      expect(tool.name, `"${tool.name}" is not a valid npm package name`).toMatch(npmName);
    }
  });

  it('is wired into the Dockerfile build (COPY manifest + run installer)', () => {
    expect(dockerfile).toMatch(/COPY cli-tools\.json install-cli-tools\.sh/);
    expect(dockerfile).toMatch(/install-cli-tools\.sh \/tmp\/cli-tools\.json/);
  });

  it('installs via pnpm and writes only-built opt-ins (preserves the supply-chain path)', () => {
    expect(installer).toMatch(/pnpm install -g/);
    expect(installer).toMatch(/only-built-dependencies\[\]=/);
  });

  it('defaults binary installs to a directory on the container PATH', () => {
    // /usr/local/bin is on PATH in the agent image; /workspace/extra and
    // /opt are not. A binary installed off PATH is a tool the agent cannot
    // invoke, and the only symptom is "command not found" inside a --rm
    // container with no logs.
    expect(installer).toContain('CLI_TOOLS_BIN_DIR:-/usr/local/bin');
  });

  it('verifies a checksum for every binary entry (the pin npm versions provide)', () => {
    expect(installer).toMatch(/sha256sum|shasum/);
    expect(installer).toContain('checksum mismatch');
  });
});

describe('cli-tools manifest — binary (non-npm) entries', () => {
  it('names a plain executable, not a package path', () => {
    // The name becomes both the file looked for inside the archive and the
    // filename in the bin dir, so a scoped or slashed name cannot work.
    for (const tool of binaryTools) {
      expect(tool.name, `"${tool.name}" is not usable as a bin filename`).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
  });

  it('covers both architectures the agent image is built for', () => {
    for (const tool of binaryTools) {
      expect(Object.keys(tool.binary ?? {}).sort(), `${tool.name} binary targets`).toEqual(['amd64', 'arm64']);
    }
  });

  it('pins each target to an https archive plus a sha256', () => {
    for (const tool of binaryTools) {
      for (const [arch, target] of Object.entries(tool.binary ?? {})) {
        expect(target.url, `${tool.name}/${arch} url`).toMatch(/^https:\/\//);
        expect(target.url, `${tool.name}/${arch} must be a .tar.gz archive`).toMatch(/\.tar\.gz$/);
        expect(target.sha256, `${tool.name}/${arch} sha256`).toMatch(/^[0-9a-f]{64}$/);
        // A URL that can move (a `latest` redirect, a branch tarball, an
        // installer script) makes the checksum meaningless: the bytes behind
        // it change and the build starts failing, or worse, is pointed
        // somewhere else entirely.
        expect(target.url, `${tool.name}/${arch} url must not float`).not.toMatch(/\/(?:latest|master|main|HEAD)\//);
        // The URL and the pinned version must agree, or the manifest says one
        // version and the image gets another.
        expect(target.url, `${tool.name}/${arch} url must name version ${tool.version}`).toContain(tool.version);
      }
    }
  });

  it('does not ask pnpm to build a binary entry', () => {
    for (const tool of binaryTools) {
      expect(tool.onlyBuilt, `${tool.name}: onlyBuilt applies to npm entries only`).toBeUndefined();
    }
  });
});

/**
 * The installer, driven for real against fixture archives over file:// URLs.
 *
 * This is the leg that a structural test cannot cover: that a binary entry
 * ends up as an executable file in the bin dir that is on the container PATH.
 * `CLI_TOOLS_BIN_DIR` / `CLI_TOOLS_NPMRC` exist so this can run unprivileged
 * and without a docker build; every other code path is the one the image uses.
 */
describe('install-cli-tools.sh installs binary entries', () => {
  function workspace(): string {
    return mkdtempSync(join(tmpdir(), 'cli-tools-test-'));
  }

  /** A .tar.gz holding one executable named `name` that echoes `marker`. */
  function fixtureArchive(dir: string, name: string, marker: string): { path: string; sha256: string } {
    const stage = join(dir, 'stage');
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, name), `#!/bin/sh\necho ${marker}\n`);
    chmodSync(join(stage, name), 0o755);
    const archive = join(dir, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', stage, name]);
    return { path: archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') };
  }

  function run(dir: string, tools: unknown[], binDir: string): void {
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(tools));
    execFileSync('sh', [installerPath, manifestPath], {
      env: {
        ...process.env,
        CLI_TOOLS_BIN_DIR: binDir,
        CLI_TOOLS_NPMRC: join(dir, 'npmrc'),
      },
      stdio: 'pipe',
    });
  }

  function hostArch(): string {
    return process.arch === 'arm64' ? 'arm64' : 'amd64';
  }

  it('lands the archived binary in the bin dir, executable and runnable', () => {
    const dir = workspace();
    const binDir = join(dir, 'bin');
    const fixture = fixtureArchive(dir, 'faketool', 'faketool-ran');
    run(
      dir,
      [
        {
          name: 'faketool',
          version: '1.2.3',
          binary: { [hostArch()]: { url: pathToFileURL(fixture.path).href, sha256: fixture.sha256 } },
        },
      ],
      binDir,
    );

    const installed = join(binDir, 'faketool');
    expect(existsSync(installed)).toBe(true);
    expect(statSync(installed).mode & 0o111).toBeTruthy();
    expect(execFileSync(installed, { encoding: 'utf8' }).trim()).toBe('faketool-ran');
  });

  it('refuses an archive whose checksum does not match, installing nothing', () => {
    const dir = workspace();
    const binDir = join(dir, 'bin');
    const fixture = fixtureArchive(dir, 'faketool', 'faketool-ran');
    expect(() =>
      run(
        dir,
        [
          {
            name: 'faketool',
            version: '1.2.3',
            binary: {
              [hostArch()]: { url: pathToFileURL(fixture.path).href, sha256: 'f'.repeat(64) },
            },
          },
        ],
        binDir,
      ),
    ).toThrow();
    expect(existsSync(join(binDir, 'faketool'))).toBe(false);
  });

  it('fails loudly when an entry has no target for the arch being built', () => {
    const dir = workspace();
    const binDir = join(dir, 'bin');
    const fixture = fixtureArchive(dir, 'faketool', 'faketool-ran');
    expect(() =>
      run(
        dir,
        [
          {
            name: 'faketool',
            version: '1.2.3',
            binary: { s390x: { url: pathToFileURL(fixture.path).href, sha256: fixture.sha256 } },
          },
        ],
        binDir,
      ),
    ).toThrow(/no "(?:amd64|arm64)" binary target/);
  });

  it('leaves an npm-only manifest untouched by the binary path', () => {
    // No binary entries, no bin-dir writes, and pnpm is never invoked because
    // the npm spec list is assembled and found empty. Proves the new path is
    // inert on a stock manifest.
    const dir = workspace();
    const binDir = join(dir, 'bin');
    run(dir, [], binDir);
    expect(readdirSync(binDir)).toEqual([]);
    expect(readFileSync(join(dir, 'npmrc'), 'utf8')).toBe('');
  });
});
