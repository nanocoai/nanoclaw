import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// The wizard process imports the host contract barrel at startup, long before
// a provider install appends `import './<name>.js';` to it. Loaded first here
// for the same reason.
import { getProviderModelEndpoint } from '../../src/provider-contracts/index.js';
import { appendedHostContractModules, loadHostContractModules } from './install.js';

/**
 * The wizard's module cache, as it is: no `vi.resetModules()` anywhere in
 * this file, because resetting the cache is exactly what the wizard cannot do,
 * and doing it here would let a stale barrel pass. The temp barrel
 * re-exports the real registry, so the probe contract lands where the gateway
 * credential store looks (`getProviderModelEndpoint` on the startup barrel).
 */
const PROBE = 'stale-barrel-probe';
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const registryUrl = pathToFileURL(path.join(repoRoot, 'src/provider-contracts/registry.ts')).href;
const roots: string[] = [];

function installRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-barrel-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src/provider-contracts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/provider-contracts/index.ts'), `export * from '${registryUrl}';\n`);
  return root;
}

/** What `applyProviderSkill` does to the tree: copy the contract, append the barrel line. */
function installProbeContract(root: string): { journal: { op: 'appended'; path: string; line: string }[] } {
  fs.writeFileSync(
    path.join(root, `src/provider-contracts/${PROBE}.ts`),
    `import { registerProviderHostContract } from '${registryUrl}';
registerProviderHostContract('${PROBE}', {
  modelDomains: ['example.test'],
  modelEndpoints: { subscription: 'https://chatgpt.example.test' },
  seamVersion: 1,
  projectDocument: { fileName: 'AGENTS.md', containerPath: '/workspace/agent/AGENTS.md', mountClass: 'group-state' },
  stateVolumes: [],
  skillBackings: [],
  skillViews: [],
  files: [],
});
`,
  );
  const line = `import './${PROBE}.js';`;
  fs.appendFileSync(path.join(root, 'src/provider-contracts/index.ts'), `${line}\n`);
  return { journal: [{ op: 'appended', path: 'src/provider-contracts/index.ts', line }] };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('host contract registration after an in-process provider install', () => {
  it('registers the appended contract module in the process that imported the barrel first', async () => {
    const root = installRoot();
    const barrel = pathToFileURL(path.join(root, 'src/provider-contracts/index.ts')).href;
    const startup = await import(barrel);
    expect(() => startup.getProviderModelEndpoint(PROBE, 'subscription')).toThrow(
      `Provider ${PROBE} does not declare its subscription endpoint`,
    );

    const apply = installProbeContract(root);

    // The barrel's URL is already cached, so re-importing it after the append
    // evaluates nothing and the registry still lacks the provider.
    const again = await import(barrel);
    expect(again).toBe(startup);
    expect(() => getProviderModelEndpoint(PROBE, 'subscription')).toThrow(
      `Provider ${PROBE} does not declare its subscription endpoint`,
    );

    // Import what the install appended, by file, so it self-registers.
    const modules = appendedHostContractModules(apply as never, root);
    expect(modules).toEqual([path.join(root, `src/provider-contracts/${PROBE}.ts`)]);
    await loadHostContractModules(modules);
    expect(getProviderModelEndpoint(PROBE, 'subscription')).toBe('https://chatgpt.example.test');
    expect(startup.getProviderModelEndpoint(PROBE, 'subscription')).toBe('https://chatgpt.example.test');
  });

  it('ignores container barrel entries and lines that are not imports', () => {
    const root = installRoot();
    const modules = appendedHostContractModules(
      {
        journal: [
          { op: 'appended', path: 'container/agent-runner/src/provider-contracts/index.ts', line: "import './x.js';" },
          { op: 'appended', path: 'src/provider-contracts/index.ts', line: '// not an import' },
          { op: 'appended', path: 'src/providers/index.ts', line: "import './x.js';" },
          { op: 'wrote', path: 'src/provider-contracts/x.ts' },
        ],
      } as never,
      root,
    );
    expect(modules).toEqual([]);
  });
});
