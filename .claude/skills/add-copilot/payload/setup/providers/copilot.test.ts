import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('../../scripts/copilot-login.js', () => ({ runCopilotLogin: calls.auth }));
vi.mock('../logs.js', () => ({ step: vi.fn() }));

import './index.js';
import { getSetupProvider } from './registry.js';
import { runCopilotInstallCheck, verifyCopilotInstall } from './copilot.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  calls.auth.mockReset();
});

function completeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-install-check-'));
  roots.push(root);
  for (const file of [
    'src/providers/copilot.ts',
    'src/provider-contracts/copilot.ts',
    'container/agent-runner/src/providers/copilot.ts',
    'container/agent-runner/src/providers/copilot-mcp.ts',
    'container/agent-runner/src/provider-contracts/copilot.ts',
    'setup/providers/copilot.ts',
    'scripts/copilot-login.ts',
    'src/providers/index.ts',
    'src/provider-contracts/index.ts',
    'container/agent-runner/src/providers/index.ts',
    'container/agent-runner/src/provider-contracts/index.ts',
    'setup/providers/index.ts',
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "import './copilot.js';\n");
  }
  fs.mkdirSync(path.join(root, 'container', 'agent-runner'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'container', 'cli-tools.json'),
    JSON.stringify([{ name: '@github/copilot', version: '1.0.85' }]),
  );
  fs.writeFileSync(
    path.join(root, 'container', 'agent-runner', 'package.json'),
    JSON.stringify({ dependencies: { '@github/copilot-sdk': '1.0.14' } }),
  );
  return root;
}

describe('installed Copilot setup registration', () => {
  it('loads the real barrel and keeps authentication separate from installation verification', async () => {
    const entry = getSetupProvider('copilot');
    expect(entry).toMatchObject({
      value: 'copilot',
      label: 'GitHub Copilot',
      hint: 'GitHub Copilot subscription through the credential gateway',
    });
    await entry!.runAuth!();
    expect(calls.auth).toHaveBeenCalledTimes(1);
  });
});

describe('verifyCopilotInstall', () => {
  it('passes on a tree with the copilot payload wired', () => {
    expect(verifyCopilotInstall(completeRoot())).toEqual({ ok: true, problems: [] });
  });

  it('blocks setup when the payload is incomplete', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-install-missing-'));
    roots.push(root);
    await expect(runCopilotInstallCheck(root)).rejects.toThrow(/GitHub Copilot provider is not fully installed/);
  });
});
