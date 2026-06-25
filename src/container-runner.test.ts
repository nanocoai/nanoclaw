import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { buildResourceLimitArgs, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

describe('buildResourceLimitArgs', () => {
  it('emits all three flags when all values are set', () => {
    expect(buildResourceLimitArgs('512m', '1', '512')).toEqual([
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--pids-limit',
      '512',
    ]);
  });

  it('omits a flag when its value is "0" (Docker unlimited convention)', () => {
    expect(buildResourceLimitArgs('0', '1', '512')).toEqual(['--cpus', '1', '--pids-limit', '512']);
    expect(buildResourceLimitArgs('512m', '0', '512')).toEqual(['--memory', '512m', '--pids-limit', '512']);
    expect(buildResourceLimitArgs('512m', '1', '0')).toEqual(['--memory', '512m', '--cpus', '1']);
  });

  it('omits a flag when its value is empty', () => {
    expect(buildResourceLimitArgs('', '', '')).toEqual([]);
  });

  it('passes values through verbatim — runtime is the unit-validation authority', () => {
    expect(buildResourceLimitArgs('1g', '0.5', '1024')).toEqual([
      '--memory',
      '1g',
      '--cpus',
      '0.5',
      '--pids-limit',
      '1024',
    ]);
  });
});
