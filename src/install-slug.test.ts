import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { getInstallSlug, getLaunchdLabel, getSystemdUnit, getContainerImageBase } from './install-slug.js';

afterEach(() => {
  delete process.env.NANOCLAW_INSTALL_ID;
});

describe('getInstallSlug', () => {
  it('derives from the project root when NANOCLAW_INSTALL_ID is unset', () => {
    const slug = getInstallSlug('/some/checkout');
    expect(slug).toMatch(/^[0-9a-f]{8}$/);
    expect(getInstallSlug('/some/checkout')).toBe(slug);
    expect(getInstallSlug('/other/checkout')).not.toBe(slug);
  });

  it('honors a valid NANOCLAW_INSTALL_ID override', () => {
    process.env.NANOCLAW_INSTALL_ID = 'prod-eks_1';
    expect(getInstallSlug('/some/checkout')).toBe('prod-eks_1');
  });

  it('rejects label-unsafe overrides', () => {
    for (const bad of ['UPPER', '-leading', 'has space', 'a'.repeat(33), 'dot.dot']) {
      process.env.NANOCLAW_INSTALL_ID = bad;
      expect(() => getInstallSlug('/some/checkout'), bad).toThrow(/NANOCLAW_INSTALL_ID/);
    }
  });
});

const shellHelper = fileURLToPath(new URL('../setup/lib/install-slug.sh', import.meta.url));
const shellFunctions = ['_nanoclaw_install_slug', 'launchd_label', 'systemd_unit', 'container_image_base'];
const tsFunctions = [getInstallSlug, getLaunchdLabel, getSystemdUnit, getContainerImageBase];

function runShell(fn: string, override: string) {
  return spawnSync('bash', ['-c', '. "$1"; "$2"', 'test', shellHelper, fn], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_ROOT: '/some/checkout',
      NANOCLAW_PROJECT_ROOT: '/some/checkout',
      NANOCLAW_INSTALL_ID: override,
    },
  });
}

describe('shell install identity parity', () => {
  it.each(['', 'prod-eks_1', 'a', 'a'.repeat(32)])('matches every TypeScript name with override %j', (override) => {
    process.env.NANOCLAW_INSTALL_ID = override;
    shellFunctions.forEach((fn, i) => {
      const result = runShell(fn, override);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trimEnd()).toBe(tsFunctions[i]('/some/checkout'));
    });
  });

  it.each(['UPPER', '-leading', '_leading', 'has space', 'a'.repeat(33), 'dot.dot', 'a\nb', 'é'])(
    'fails closed for invalid override %j',
    (override) => {
      process.env.NANOCLAW_INSTALL_ID = override;
      expect(() => getInstallSlug('/some/checkout')).toThrow(/NANOCLAW_INSTALL_ID/);
      for (const fn of shellFunctions) {
        const result = runShell(fn, override);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('NANOCLAW_INSTALL_ID');
      }
    },
  );
});

describe('nanoclaw.sh --uninstall without dependencies', () => {
  // A copy with no node_modules takes the manual cleanup-guidance branch.
  function runUninstall(override: string) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-uninstall-'));
    try {
      mkdirSync(path.join(root, 'setup', 'lib'), { recursive: true });
      copyFileSync(fileURLToPath(new URL('../nanoclaw.sh', import.meta.url)), path.join(root, 'nanoclaw.sh'));
      copyFileSync(shellHelper, path.join(root, 'setup', 'lib', 'install-slug.sh'));
      return spawnSync('bash', [path.join(root, 'nanoclaw.sh'), '--uninstall'], {
        encoding: 'utf8',
        env: { ...process.env, NANOCLAW_INSTALL_ID: override },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('prints cleanup commands for the override', () => {
    const result = runUninstall('prod-eks_1');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('nanoclaw-agent-v2-prod-eks_1:latest');
    expect(result.stdout).toContain('/.nanoclaw-updates/prod-eks_1"');
  });

  it('prints no cleanup commands for an invalid override', () => {
    const result = runUninstall('UPPER');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NANOCLAW_INSTALL_ID');
    expect(result.stdout).not.toContain('rm -rf');
  });
});
