import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayCredentialConnection, GatewayCredentialTarget } from '../gateways/credential-store.js';

const mockSpawn = vi.fn();
const mockExecFileSync = vi.fn();
const mockGetCredentialStore = vi.fn();
const tempDirs: string[] = [];
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));
vi.mock('../gateways/credential-store.js', () => ({
  getCredentialStore: (...args: unknown[]) => mockGetCredentialStore(...args),
}));

vi.mock('../logs.js', () => ({ step: vi.fn(), userInput: vi.fn() }));

import {
  CURSOR_BARRELS,
  CURSOR_CREDENTIAL_PLACEHOLDER,
  CURSOR_CREDENTIAL_TARGETS,
  cursorCredentialConnections,
  cursorCredentialsConnected,
  loginHelperCommand,
  looksLikeCursorApiKey,
  runInherit,
  runCursorAuthStep,
  runCursorInstallCheck,
  runCursorLoginAuth,
  saveCursorKey,
  verifyCursorInstall,
} from './cursor.js';

/** In-memory gateway: one entry per target name, `save` records what it stored. */
function fakeGateway(stored: Record<string, { reusable: boolean }> = {}) {
  const targets: GatewayCredentialTarget[] = [];
  const saves: Array<{ name: string; value: unknown }> = [];
  const kept: string[] = [];
  const failSave = new Set<string>();
  const connection = (target: GatewayCredentialTarget): GatewayCredentialConnection => {
    targets.push(target);
    return {
      find: async () => stored[target.name] ?? null,
      keep: async () => {
        kept.push(target.name);
      },
      save: async (value) => {
        if (failSave.has(target.name)) throw new Error(`${target.name} save failed`);
        saves.push({ name: target.name, value });
        stored[target.name] = { reusable: true };
      },
    };
  };
  const store = { has: vi.fn(), save: vi.fn(), connection };
  mockGetCredentialStore.mockResolvedValue(store);
  return { store, targets, saves, kept, failSave };
}

function exitThrows(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  }) as typeof process.exit);
}

// The container's pinned Bun, read the way the login helper reads it.
const pinnedBun = (() => {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf-8').match(/^ARG BUN_VERSION=(\S+)$/m)?.[1];
  } catch {
    return undefined;
  }
})();

beforeEach(() => {
  mockSpawn.mockReset();
  mockExecFileSync.mockReset();
  mockExecFileSync.mockReturnValue(`${pinnedBun}\n`);
  mockGetCredentialStore.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// The wired-tree check needs the contract core's barrels; the standalone
// providers branch has no setup/provider-contract barrels to be wired into.
const installedIt = fs.existsSync(path.join(process.cwd(), 'src', 'provider-contracts', 'index.ts')) ? it : it.skip;

describe('verifyCursorInstall', () => {
  installedIt('passes on a tree with the cursor payload wired', () => {
    const { ok, problems } = verifyCursorInstall();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });

  function fakeCursorTree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-install-check-'));
    tempDirs.push(root);
    const requiredFiles = [
      'src/providers/cursor.ts',
      'src/provider-contracts/cursor.ts',
      'container/agent-runner/src/providers/cursor.ts',
      'container/agent-runner/src/providers/cursor-auth.ts',
      'container/agent-runner/src/providers/cursor-hook.ts',
      'container/agent-runner/src/providers/cursor.conformance.test.ts',
      'container/agent-runner/src/provider-contracts/cursor.ts',
      'setup/providers/cursor.ts',
    ];
    for (const file of requiredFiles) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), '// present\n');
    }
    for (const barrel of CURSOR_BARRELS) {
      fs.mkdirSync(path.dirname(path.join(root, barrel)), { recursive: true });
      fs.writeFileSync(path.join(root, barrel), "import './cursor.js';\n");
    }
    fs.writeFileSync(
      path.join(root, 'container/agent-runner/package.json'),
      JSON.stringify({ dependencies: { '@cursor/sdk': '1.0.28' } }),
    );
    fs.writeFileSync(
      path.join(root, 'container/agent-runner/bun.lock'),
      JSON.stringify({ workspaces: { '': { dependencies: { '@cursor/sdk': '1.0.28' } } } }),
    );
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
    fs.writeFileSync(path.join(root, 'container/cli-tools.json'), '[]\n');
    return root;
  }

  it('reports missing payload files and barrel wiring', () => {
    const root = fakeCursorTree();
    fs.rmSync(path.join(root, 'container/agent-runner/src/providers/cursor-hook.ts'));
    fs.writeFileSync(path.join(root, 'setup/providers/index.ts'), '// missing cursor registration\n');
    const result = verifyCursorInstall(root);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('missing file: container/agent-runner/src/providers/cursor-hook.ts');
    expect(result.problems).toContain('missing barrel import in setup/providers/index.ts');
  });

  it('fails setup instead of continuing with an incomplete provider', async () => {
    const root = fakeCursorTree();
    fs.rmSync(path.join(root, 'container/agent-runner/src/providers/cursor-hook.ts'));
    await expect(runCursorInstallCheck(root)).rejects.toThrow('Cursor provider install is incomplete');
  });

  it('rejects loose, stale, or mismatched SDK package and lockfile versions', () => {
    const root = fakeCursorTree();
    fs.writeFileSync(
      path.join(root, 'container/agent-runner/package.json'),
      JSON.stringify({ dependencies: { '@cursor/sdk': '^1.0.28' } }),
    );
    fs.writeFileSync(
      path.join(root, 'container/agent-runner/bun.lock'),
      JSON.stringify({ workspaces: { '': { dependencies: { '@cursor/sdk': '1.0.27' } } } }),
    );
    const result = verifyCursorInstall(root);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('container/agent-runner/package.json must pin @cursor/sdk exactly to 1.0.28');
    expect(result.problems).toContain('container/agent-runner/bun.lock must resolve @cursor/sdk 1.0.28');
  });

  it('rejects installing the Cursor SDK in the host pnpm tree', () => {
    const root = fakeCursorTree();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@cursor/sdk': '1.0.28' } }));
    expect(verifyCursorInstall(root).problems).toContain('@cursor/sdk must not be installed in the host pnpm package');
  });

  it('rejects a Cursor CLI entry in the container CLI manifest', () => {
    const root = fakeCursorTree();
    fs.writeFileSync(
      path.join(root, 'container/cli-tools.json'),
      JSON.stringify([{ name: 'cursor-agent', version: '1.0.0' }]),
    );
    expect(verifyCursorInstall(root).problems).toContain(
      'container/cli-tools.json should not list a Cursor CLI — the container uses the SDK',
    );
  });

  it('fails closed on malformed package metadata', () => {
    const root = fakeCursorTree();
    fs.writeFileSync(path.join(root, 'container/agent-runner/package.json'), '{');
    fs.writeFileSync(path.join(root, 'container/agent-runner/bun.lock'), '{');
    fs.writeFileSync(path.join(root, 'package.json'), '{');
    const result = verifyCursorInstall(root);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('container/agent-runner/package.json must pin @cursor/sdk exactly to 1.0.28');
    expect(result.problems).toContain('container/agent-runner/bun.lock must resolve @cursor/sdk 1.0.28');
    expect(result.problems).toContain('host package.json is unreadable');
  });
});

describe('looksLikeCursorApiKey', () => {
  it('accepts known Cursor key prefixes', () => {
    expect(looksLikeCursorApiKey('cursor_abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksLikeCursorApiKey('crsr_abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksLikeCursorApiKey('key_abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksLikeCursorApiKey('sk-ant-api03-nope')).toBe(false);
  });

  it('trims outer whitespace but rejects short, malformed, and embedded-space values', () => {
    expect(looksLikeCursorApiKey('  cursor_abcdefghijklmnopqrstuvwxyz  ')).toBe(true);
    expect(looksLikeCursorApiKey('cursor_short')).toBe(false);
    expect(looksLikeCursorApiKey('cursor_abc defghijkl')).toBe(false);
    expect(looksLikeCursorApiKey('CURSOR_ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe(false);
    expect(looksLikeCursorApiKey('')).toBe(false);
  });
});

describe('Cursor gateway credentials', () => {
  it('describes one path-scoped bearer api-key entry per Cursor route, carrying the container placeholder', async () => {
    const { targets } = fakeGateway();
    await cursorCredentialConnections();
    expect(targets).toEqual(CURSOR_CREDENTIAL_TARGETS);
    expect(targets.map((target) => [target.name, target.host, target.path])).toEqual([
      ['Cursor', 'api2.cursor.sh', '/auth/exchange_user_api_key'],
      ['Cursor models', 'api.cursor.com', '/v1/models'],
    ]);
    for (const target of targets) {
      expect(target).toMatchObject({
        kind: 'api-key',
        proxyValue: CURSOR_CREDENTIAL_PLACEHOLDER,
        injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
      });
    }
  });

  it('names the cursor provider on both entries, so a gateway that grants per agent attaches them to Cursor groups', async () => {
    const { targets } = fakeGateway();
    await cursorCredentialConnections();
    expect(targets.map((target) => target.provider)).toEqual(['cursor', 'cursor']);
  });

  installedIt('uses the same placeholder the host adapter hands the container', () => {
    const host = fs.readFileSync(path.join(process.cwd(), 'src', 'providers', 'cursor.ts'), 'utf-8');
    expect(host).toContain(`CURSOR_API_KEY_PLACEHOLDER = '${CURSOR_CREDENTIAL_PLACEHOLDER}'`);
  });

  it('refuses a gateway that only stores provider-named credentials', async () => {
    mockGetCredentialStore.mockResolvedValue({ has: vi.fn(), save: vi.fn() });
    await expect(cursorCredentialConnections()).rejects.toThrow('does not support provider credential connections');
  });

  it('reports connected only when both entries exist and are reusable', async () => {
    const stored: Record<string, { reusable: boolean }> = { Cursor: { reusable: true } };
    fakeGateway(stored);
    expect(await cursorCredentialsConnected(await cursorCredentialConnections())).toBe(false);
    stored['Cursor models'] = { reusable: false };
    expect(await cursorCredentialsConnected(await cursorCredentialConnections())).toBe(false);
    stored['Cursor models'] = { reusable: true };
    expect(await cursorCredentialsConnected(await cursorCredentialConnections())).toBe(true);
  });

  it('saves the trimmed key to both entries and refuses an empty one', async () => {
    const { saves } = fakeGateway();
    const connections = await cursorCredentialConnections();
    await saveCursorKey('  cursor_secret_material  ', connections);
    expect(saves).toEqual([
      { name: 'Cursor', value: 'cursor_secret_material' },
      { name: 'Cursor models', value: 'cursor_secret_material' },
    ]);
    await expect(saveCursorKey('   ', connections)).rejects.toThrow('empty');
  });

  it('skips sign-in when the gateway already holds both entries, letting it reconcile them', async () => {
    const { kept } = fakeGateway({ Cursor: { reusable: true }, 'Cursor models': { reusable: true } });
    await runCursorAuthStep();
    expect(kept).toEqual(['Cursor', 'Cursor models']);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('names the entry that already holds the new key when a later save fails', async () => {
    const { failSave, saves } = fakeGateway();
    failSave.add('Cursor models');
    await expect(saveCursorKey('cursor_secret_material', await cursorCredentialConnections())).rejects.toThrow(
      /Saved the new key for Cursor, but saving it for Cursor models failed \(Cursor models save failed\)\. Re-run provider-auth/,
    );
    expect(saves.map((entry) => entry.name)).toEqual(['Cursor']);
  });

  it('fails before interactive login when the gateway cannot be read', async () => {
    mockGetCredentialStore.mockRejectedValue(new Error('Unknown gateway: nope'));
    exitThrows();
    await expect(runCursorAuthStep()).rejects.toThrow('exit:1');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('loginHelperCommand', () => {
  installedIt('uses the host Bun only when it matches the container pin', () => {
    expect(loginHelperCommand()).toEqual({ command: 'bun', prefix: [] });
    mockExecFileSync.mockReturnValue('0.0.1\n');
    expect(loginHelperCommand()).toEqual({ command: 'pnpm', prefix: [`--package=bun@${pinnedBun}`, 'dlx', 'bun'] });
    mockExecFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(loginHelperCommand().command).toBe('pnpm');
  });
});

describe('runCursorLoginAuth', () => {
  function helperWrites(content: string | null, mode = 0o600, exitCode = 0): { keyPath: () => string } {
    let keyPath = '';
    mockSpawn.mockImplementation((...args: unknown[]) => {
      expect(args[0]).toBe('bun');
      const helperArgs = args[1] as string[];
      expect(helperArgs[0]).toMatch(/cursor-auth\.ts$/);
      keyPath = helperArgs[helperArgs.indexOf('--output') + 1]!;
      if (content !== null) {
        fs.writeFileSync(keyPath, content, { mode });
        fs.chmodSync(keyPath, mode);
      }
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', exitCode));
      return child;
    });
    return { keyPath: () => keyPath };
  }

  it('saves the helper-minted key to both entries and deletes the handoff', async () => {
    const { saves } = fakeGateway();
    const helper = helperWrites('cursor_oauth_minted_key_value\n');
    await runCursorLoginAuth('browser', await cursorCredentialConnections());
    expect(saves.map((entry) => entry.value)).toEqual([
      'cursor_oauth_minted_key_value',
      'cursor_oauth_minted_key_value',
    ]);
    expect(fs.existsSync(path.dirname(helper.keyPath()))).toBe(false);
  });

  it('passes --no-browser for URL login', async () => {
    fakeGateway();
    helperWrites('cursor_url_minted_key');
    await runCursorLoginAuth('url', await cursorCredentialConnections());
    expect(mockSpawn.mock.calls[0]![1]).toContain('--no-browser');
  });

  it('cleans the handoff before exiting when the helper fails', async () => {
    const { saves } = fakeGateway();
    const helper = helperWrites('partial-secret', 0o600, 17);
    exitThrows();
    await expect(runCursorLoginAuth('browser', await cursorCredentialConnections())).rejects.toThrow('exit:1');
    expect(fs.existsSync(path.dirname(helper.keyPath()))).toBe(false);
    expect(saves).toEqual([]);
  });

  it('cleans the handoff before exiting when the helper writes no key', async () => {
    const { saves } = fakeGateway();
    const helper = helperWrites(null);
    exitThrows();
    await expect(runCursorLoginAuth('browser', await cursorCredentialConnections())).rejects.toThrow('exit:1');
    expect(fs.existsSync(path.dirname(helper.keyPath()))).toBe(false);
    expect(saves).toEqual([]);
  });

  it('rejects and deletes a non-private handoff without saving it', async () => {
    const { saves } = fakeGateway();
    const helper = helperWrites('cursor_insecure_handoff', 0o644);
    exitThrows();
    await expect(runCursorLoginAuth('browser', await cursorCredentialConnections())).rejects.toThrow('exit:1');
    expect(fs.existsSync(path.dirname(helper.keyPath()))).toBe(false);
    expect(saves).toEqual([]);
  });

  it('cleans the handoff and exits when the gateway rejects the second entry', async () => {
    const { failSave } = fakeGateway();
    failSave.add('Cursor models');
    const helper = helperWrites('cursor_oauth_minted_key_value');
    exitThrows();
    await expect(runCursorLoginAuth('browser', await cursorCredentialConnections())).rejects.toThrow('exit:1');
    expect(fs.existsSync(path.dirname(helper.keyPath()))).toBe(false);
  });
});

describe('runInherit', () => {
  it('resolves spawn errors as failure without hanging', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    });
    await expect(runInherit('missing', [])).resolves.toBe(1);
  });

  it('kills and returns 124 when the login helper hangs', async () => {
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    mockSpawn.mockReturnValue(child);
    await expect(runInherit('bun', ['helper'], undefined, 5)).resolves.toBe(124);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('kills the helper and resolves %s as %i so the caller can clean up', async (signal, code) => {
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    const signals = new EventEmitter();
    mockSpawn.mockReturnValue(child);
    const result = runInherit(
      'bun',
      ['helper'],
      undefined,
      1_000,
      signals as unknown as Pick<NodeJS.Process, 'once' | 'off'>,
    );
    signals.emit(signal);
    await expect(result).resolves.toBe(code);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('trunk reach-ins', () => {
  // The skill ships in trunk; an applied tree may not carry it, so the check
  // is skipped rather than failed there.
  const skillPath = path.join(process.cwd(), '.claude', 'skills', 'add-cursor', 'SKILL.md');
  const skillIt = fs.existsSync(skillPath) ? it : it.skip;

  skillIt('ships the install skill used by fresh setup and standalone provider-auth', () => {
    const skill = fs.readFileSync(skillPath, 'utf-8');
    expect(skill).toContain('nanoclaw-provider: cursor');
    expect(skill).toContain('nanoclaw-provider-label: Cursor');
    expect(skill).toContain('nanoclaw-provider-hint: Cursor — account sign-in or API key');
    expect(skill).toContain('payload/setup/providers/cursor.ts -> setup/providers/cursor.ts');
    expect(skill).not.toContain('from-branch');
    expect(skill).toContain('nc:dep manager:bun cwd:container/agent-runner');
    expect(skill).toContain('@cursor/sdk@1.0.28');
    expect(skill).toContain('--step provider-auth cursor');
    for (const barrel of CURSOR_BARRELS) expect(skill).toContain(`nc:append to:${barrel}`);
  });

  it('registers the setup entry with the same label and hint the skill frontmatter carries', async () => {
    const { getSetupProvider } = await import('./registry.js');
    await import('./cursor.js');
    expect(getSetupProvider('cursor')).toMatchObject({
      value: 'cursor',
      label: 'Cursor',
      hint: 'Cursor — account sign-in or API key',
    });
  });
});
