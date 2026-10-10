import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-provider-file-transformers-test';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-provider-file-transformers-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-provider-file-transformers-test/groups',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import '../providers/index.js';
import './index.js';
import {
  getProviderFileTransformer,
  listProviderFileTransformerNames,
  registerProviderFileTransformer,
  type ProviderFileTransformer,
} from './file-transformers.js';
import { initializeProviderGroupSurfaces } from './realize.js';
import {
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  assertProviderHostConformance,
  getProviderHostContract,
  registerProviderHostContract,
  type ProviderHostContract,
} from './registry.js';

/** A payload-owned transformer that has nothing to do with Claude. */
const payloadTransformer: ProviderFileTransformer = {
  transform(current) {
    return current.includes('"reconciled"')
      ? { kind: 'unchanged' }
      : { kind: 'replace', content: '{"reconciled":true}\n' };
  },
  mapIoFailure(error) {
    return { level: 'error', message: 'payload transformer failed', fields: { error: String(error) } };
  },
};

/** Claude's registered document. */
function baseProjectDocument(): ProviderHostContract['projectDocument'] {
  return getProviderHostContract('claude')!.projectDocument;
}

function contractWithTransformer(transformer: string, directory: string): ProviderHostContract {
  return {
    seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
    // Derived from the registered Claude document rather than written out as a
    // literal: the project-document shape is owned by other layers of this
    // stack, and this suite is about transformers, not that shape.
    projectDocument: {
      ...baseProjectDocument(),
      containerPath: '/workspace/agent/AGENTS.md',
      mountClass: 'group-state',
    },
    stateVolumes: [
      {
        id: 'state',
        directory,
        containerPath: '/state',
        scope: 'group',
        mode: 'rw',
        mountClass: 'group-state',
      },
    ],
    skillBackings: [],
    skillViews: [],
    files: [
      {
        id: 'settings',
        volumeId: 'state',
        relativePath: 'settings.json',
        prepare: {
          operation: 'create-if-missing',
          when: 'group-init',
          content: '{"initial":true}\n',
        },
        reconcile: { transformer },
      },
    ],
  };
}

beforeAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('provider file transformer registry', () => {
  it('carries the transformer Claude registers for itself', () => {
    expect(listProviderFileTransformerNames()).toContain('claude-settings');
    expect(getProviderFileTransformer('claude-settings')).toBeDefined();
    expect(getProviderFileTransformer('never-registered')).toBeUndefined();
  });

  it('rejects duplicate registration', () => {
    registerProviderFileTransformer('duplicate-transformer', payloadTransformer);

    expect(() => registerProviderFileTransformer('duplicate-transformer', payloadTransformer)).toThrow(
      'Provider file transformer already registered: duplicate-transformer',
    );
  });

  it('rejects a transformer name that is not lowercase kebab-case', () => {
    expect(() => registerProviderFileTransformer('Not Kebab', payloadTransformer)).toThrow(
      "Provider file transformer name must be lowercase kebab-case: 'Not Kebab'",
    );
  });

  it('resolves and invokes a payload-registered transformer during realization', () => {
    registerProviderFileTransformer('payload-settings', payloadTransformer);
    const contract = contractWithTransformer('payload-settings', '.payload-state');
    const settingsFile = path.join(
      TEST_ROOT,
      'data',
      'v2-sessions',
      'payload-group',
      '.payload-state',
      'settings.json',
    );

    expect(initializeProviderGroupSurfaces('payload', contract, 'payload-group', TEST_ROOT)).toContain('settings.json');
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe('{"initial":true}\n');

    expect(initializeProviderGroupSurfaces('payload', contract, 'payload-group', TEST_ROOT)).toContain(
      'settings.json (reconciled Payload settings)',
    );
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe('{"reconciled":true}\n');
  });

  it('keeps Claude out of core: realization names no provider transformer', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'provider-contracts', 'realize.ts'), 'utf8');

    expect(source).not.toContain('claudeSettingsTransformer');
    expect(source).not.toContain('claude-settings');
  });

  // Registered last: it leaves an unresolvable contract in the module-global
  // registry, so every later conformance call would fail on it.
  it('rejects a contract naming an unregistered transformer at conformance', () => {
    expect(() => assertProviderHostConformance()).not.toThrow();
    registerProviderHostContract(
      'unresolved-transformer-provider',
      contractWithTransformer('never-registered', '.unresolved-state'),
    );

    const registered = listProviderFileTransformerNames();
    expect(registered).toContain('claude-settings');
    expect(() => assertProviderHostConformance()).toThrow(
      `Provider 'unresolved-transformer-provider' file 'settings' names unregistered file transformer 'never-registered'; registered transformers: ${registered.join(', ')}`,
    );
  });
});
