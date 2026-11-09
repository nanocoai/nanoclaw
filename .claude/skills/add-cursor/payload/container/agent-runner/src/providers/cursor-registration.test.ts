/**
 * Integration test for the cursor provider's CONTAINER-side reach-in: the
 * self-registration import in container/agent-runner/src/providers/index.ts.
 * Importing the barrel runs cursor.ts's top-level registerProvider('cursor', …);
 * without that import line createProvider('cursor') throws 'Unknown provider'.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel
 * (./index.js), never ./cursor.js directly. Importing the provider module
 * directly (as cursor.factory.test.ts does) self-registers it and would stay
 * GREEN even if the barrel line were deleted. This test also pulls in
 * `@cursor/sdk` unmocked — a missing package goes red.
 */
import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { listProviderNames } from './provider-registry.js';
import './index.js';

describe('cursor provider registration', () => {
  it('registers cursor via the provider barrel', () => {
    expect(listProviderNames()).toContain('cursor');
  });

  it('loads the pinned Cursor SDK under Bun', async () => {
    const sdk = await import('@cursor/sdk');
    expect(typeof sdk.Agent.create).toBe('function');
  });

  it('pins @cursor/sdk in container/agent-runner/package.json (no CLI manifest)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../../package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@cursor/sdk']).toBe('1.0.28');

    const manifestPath = path.join(import.meta.dir, '../../../cli-tools.json');
    if (fs.existsSync(manifestPath)) {
      const tools = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Array<{ name?: string }>;
      expect(tools.some((t) => t.name === '@cursor/sdk' || t.name === 'cursor-agent')).toBe(false);
    }
  });
});
