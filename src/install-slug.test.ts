/**
 * Lockstep guard for the two halves of the install-slug derivation.
 *
 * src/install-slug.ts names the service and the agent image for the host and
 * the CLI; setup/lib/install-slug.sh names the same things for the setup
 * wizard and container/build.sh. They are independent implementations of
 * sha1(projectRoot)[:8], and a divergence is invisible until the host tries to
 * spawn from an image tag nobody built. So assert they agree, on more than one
 * root, rather than trusting the comment at the top of the .sh.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getContainerImageBase, getInstallSlug, getLaunchdLabel, getSystemdUnit } from './install-slug.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shPath = path.join(repoRoot, 'setup', 'lib', 'install-slug.sh');

function shellNames(projectRoot: string): { label: string; unit: string; image: string } {
  const script = `. "${shPath}"; printf '%s\\n%s\\n%s\\n' "$(launchd_label)" "$(systemd_unit)" "$(container_image_base)"`;
  const out = execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PROJECT_ROOT: projectRoot, NANOCLAW_PROJECT_ROOT: projectRoot },
  });
  const [label, unit, image] = out.trim().split('\n');
  return { label, unit, image };
}

describe('install-slug shell/TS lockstep', () => {
  // The real checkout, plus a synthetic root, so a fluke collision on one path
  // cannot make a divergent implementation look correct.
  for (const root of [repoRoot, '/tmp/some/other/root']) {
    it(`agrees on every install name for ${root === repoRoot ? 'this checkout' : 'a synthetic root'}`, () => {
      const sh = shellNames(root);
      expect(sh.label).toBe(getLaunchdLabel(root));
      expect(sh.unit).toBe(getSystemdUnit(root));
      expect(sh.image).toBe(getContainerImageBase(root));
      expect(sh.image.endsWith(getInstallSlug(root))).toBe(true);
    });
  }
});
