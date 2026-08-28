import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guards the cli-tools.json seam: the global CLIs the agent invokes at runtime
// are installed from the manifest (a skill adds one with a json-merge), not
// hand-edited into the Dockerfile. These go red on a bad merge that drops a
// baseline tool, or on dewiring the Dockerfile / switching the installer off
// the pnpm supply-chain path.
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'cli-tools.json'), 'utf8')) as Array<{
  name: string;
  version: string;
  onlyBuilt?: boolean;
}>;
const dockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8');
const installer = readFileSync(join(here, 'install-cli-tools.sh'), 'utf8');

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
    // The installer consumes exactly `name`, `version` and `onlyBuilt`. A key
    // it does not read is either a typo (`onlyBuild`, `pin`) that silently
    // does nothing, or an expectation the seam does not honour. Deliberately
    // NOT a name blacklist: this manifest is the opt-in surface every
    // `/add-<cli>` skill appends to, so a test that named specific tools as
    // forbidden could never be green after a legitimate install.
    const allowed = new Set(['name', 'version', 'onlyBuilt']);
    for (const tool of manifest) {
      for (const key of Object.keys(tool)) {
        expect(allowed.has(key), `${(tool as { name?: string }).name}: unknown manifest key "${key}"`).toBe(true);
      }
      if ('onlyBuilt' in tool) {
        expect(typeof tool.onlyBuilt, `${tool.name}: onlyBuilt must be a boolean`).toBe('boolean');
      }
    }
  });

  it('every name is an installable npm package name (the spec is name@version)', () => {
    // `pnpm install -g <name>@<version>` word-splits on spaces and reads `@`
    // as the version delimiter, so a scope typo or an embedded range in the
    // name installs the wrong thing (or nothing) with no build error.
    const npmName = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
    for (const tool of manifest) {
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
});
