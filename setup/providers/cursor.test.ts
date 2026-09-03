import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();
const mockExecFileSync = vi.fn();
const tempDirs: string[] = [];
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../logs.js', () => ({ step: vi.fn(), userInput: vi.fn() }));

import {
  CURSOR_BARRELS,
  cursorSecretExists,
  findCursorModelsSecret,
  findCursorSecret,
  listCursorSecrets,
  looksLikeCursorApiKey,
  runInherit,
  runCursorAuthStep,
  runCursorInstallCheck,
  runCursorLoginAuth,
  vaultCursorKey,
  vaultCursorKeyFile,
  verifyCursorInstall,
} from './cursor.js';

beforeEach(() => {
  mockSpawn.mockReset();
  mockExecFileSync.mockReset();
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

describe('findCursorSecret', () => {
  it('matches only the SDK key-exchange route instead of stale broad rules', () => {
    const stale = { id: 'old', name: 'Cursor', type: 'generic', hostPattern: 'api.cursor.com' };
    const broad = { id: 'broad', name: 'Cursor', type: 'generic', hostPattern: 'api2.cursor.sh' };
    const runtime = {
      id: 'current',
      name: 'Cursor SDK',
      type: 'generic',
      hostPattern: 'api2.cursor.sh',
      pathPattern: '/auth/exchange_user_api_key',
    };
    expect(findCursorSecret([stale, broad, runtime])?.id).toBe('current');
    expect(findCursorSecret([stale, broad])).toBeUndefined();
  });

  it('matches hosts case-insensitively but keeps the path exact', () => {
    const exact = {
      id: 'exact',
      name: 'Cursor',
      type: 'generic',
      hostPattern: 'API2.CURSOR.SH',
      pathPattern: '/auth/exchange_user_api_key',
    };
    const broadPath = { ...exact, id: 'broad-path', pathPattern: '/*' };
    expect(findCursorSecret([broadPath, exact])?.id).toBe('exact');
  });

  it('matches the separate original-key model-discovery route', () => {
    const exchange = {
      id: 'exchange',
      name: 'Cursor',
      type: 'generic',
      hostPattern: 'api2.cursor.sh',
      pathPattern: '/auth/exchange_user_api_key',
    };
    const models = {
      id: 'models',
      name: 'Cursor models',
      type: 'generic',
      hostPattern: 'api.cursor.com',
      pathPattern: '/v1/models',
    };
    expect(findCursorModelsSecret([exchange, models])?.id).toBe('models');
    expect(findCursorModelsSecret([exchange])).toBeUndefined();
  });
});

describe('Cursor secret discovery', () => {
  it('requires a parseable OneCLI list with an array payload', () => {
    mockExecFileSync.mockReturnValueOnce(JSON.stringify({ data: [] }));
    expect(listCursorSecrets()).toEqual([]);

    mockExecFileSync.mockReturnValueOnce(JSON.stringify({ data: null }));
    expect(() => listCursorSecrets()).toThrow('invalid secret list');

    mockExecFileSync.mockReturnValueOnce('not json');
    expect(() => listCursorSecrets()).toThrow();
  });

  it('reports connected only when both narrow routes exist', () => {
    const exchange = {
      id: 'exchange',
      name: 'Cursor',
      type: 'generic',
      hostPattern: 'api2.cursor.sh',
      pathPattern: '/auth/exchange_user_api_key',
    };
    const models = {
      id: 'models',
      name: 'Cursor models',
      type: 'generic',
      hostPattern: 'api.cursor.com',
      pathPattern: '/v1/models',
    };
    mockExecFileSync.mockReturnValueOnce(JSON.stringify({ data: [exchange, models] }));
    expect(cursorSecretExists()).toBe(true);
    mockExecFileSync.mockReturnValueOnce(JSON.stringify({ data: [exchange] }));
    expect(cursorSecretExists()).toBe(false);
  });

  it('treats an unavailable or malformed vault as not connected', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('ECONNREFUSED');
    });
    expect(cursorSecretExists()).toBe(false);
    mockExecFileSync.mockReturnValueOnce('{');
    expect(cursorSecretExists()).toBe(false);
  });

  it('finds OneCLI in ~/.local/bin for standalone provider-auth runs', () => {
    mockExecFileSync.mockReturnValueOnce(JSON.stringify({ data: [] }));
    listCursorSecrets();
    const options = mockExecFileSync.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(options.env.PATH?.split(path.delimiter)[0]).toBe(path.join(os.homedir(), '.local', 'bin'));
  });

  it('fails before interactive login when the vault cannot be read', async () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('vault unavailable');
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    await expect(runCursorAuthStep()).rejects.toThrow('exit:1');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('vaultCursorKeyFile', () => {
  it('creates both missing routes from the same file without putting the key in argv', () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[1] === 'list') return JSON.stringify({ data: [] });
      if (args[1] === 'create') {
        return JSON.stringify({ id: args.includes('api2.cursor.sh') ? 'exchange-new' : 'models-new' });
      }
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    });

    expect(vaultCursorKeyFile('/secure/api-key')).toEqual(['exchange-new', 'models-new']);
    const creates = mockExecFileSync.mock.calls.filter((call) => call[1][1] === 'create');
    expect(creates).toHaveLength(2);
    for (const [, args] of creates) {
      expect(args).toContain('/secure/api-key');
      expect(args).not.toContain('--value');
      expect(args).not.toContain('cursor_secret_material');
    }
  });

  it('is idempotent when both exact routes already exist', () => {
    mockExecFileSync.mockReturnValueOnce(
      JSON.stringify({
        data: [
          {
            id: 'exchange',
            name: 'Cursor',
            type: 'generic',
            hostPattern: 'api2.cursor.sh',
            pathPattern: '/auth/exchange_user_api_key',
          },
          {
            id: 'models',
            name: 'Cursor models',
            type: 'generic',
            hostPattern: 'api.cursor.com',
            pathPattern: '/v1/models',
          },
        ],
      }),
    );
    expect(vaultCursorKeyFile('/secure/api-key')).toEqual([]);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('rotates both routes by staging replacements before deleting old entries', () => {
    const deleted: string[] = [];
    const sequence: string[] = [];
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') {
        return JSON.stringify({
          data: [
            {
              id: 'exchange-old',
              name: 'Cursor',
              type: 'generic',
              hostPattern: 'api2.cursor.sh',
              pathPattern: '/auth/exchange_user_api_key',
            },
            {
              id: 'models-old',
              name: 'Cursor models',
              type: 'generic',
              hostPattern: 'api.cursor.com',
              pathPattern: '/v1/models',
            },
          ],
        });
      }
      if (args[1] === 'create') {
        sequence.push(`create:${args.includes('api2.cursor.sh') ? 'exchange' : 'models'}`);
        return JSON.stringify({ id: args.includes('api2.cursor.sh') ? 'exchange-new' : 'models-new' });
      }
      if (args[1] === 'delete') {
        const id = args[args.indexOf('--id') + 1]!;
        deleted.push(id);
        sequence.push(`delete:${id}`);
        return '';
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    expect(vaultCursorKeyFile('/secure/api-key', { replaceExisting: true })).toEqual(['exchange-new', 'models-new']);
    expect(deleted).toEqual(['exchange-old', 'models-old']);
    expect(sequence).toEqual(['create:exchange', 'create:models', 'delete:exchange-old', 'delete:models-old']);
  });

  it('preserves old routes when staging a replacement pair fails', () => {
    const deleted: string[] = [];
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') {
        return JSON.stringify({
          data: [
            {
              id: 'exchange-old',
              name: 'Cursor',
              type: 'generic',
              hostPattern: 'api2.cursor.sh',
              pathPattern: '/auth/exchange_user_api_key',
            },
            {
              id: 'models-old',
              name: 'Cursor models',
              type: 'generic',
              hostPattern: 'api.cursor.com',
              pathPattern: '/v1/models',
            },
          ],
        });
      }
      if (args[1] === 'create' && args.includes('api2.cursor.sh')) return JSON.stringify({ id: 'exchange-new' });
      if (args[1] === 'create') throw new Error('replacement models failed');
      if (args[1] === 'delete') {
        deleted.push(args[args.indexOf('--id') + 1]!);
        return '';
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    expect(() => vaultCursorKeyFile('/secure/api-key', { replaceExisting: true })).toThrow('replacement models failed');
    expect(deleted).toEqual(['exchange-new']);
  });

  it('keeps staged replacements and reports stale cleanup failures', () => {
    const deleted: string[] = [];
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') {
        return JSON.stringify({
          data: [
            {
              id: 'exchange-old',
              name: 'Cursor',
              type: 'generic',
              hostPattern: 'api2.cursor.sh',
              pathPattern: '/auth/exchange_user_api_key',
            },
            {
              id: 'models-old',
              name: 'Cursor models',
              type: 'generic',
              hostPattern: 'api.cursor.com',
              pathPattern: '/v1/models',
            },
          ],
        });
      }
      if (args[1] === 'create') {
        return JSON.stringify({ id: args.includes('api2.cursor.sh') ? 'exchange-new' : 'models-new' });
      }
      if (args[1] === 'delete') {
        const id = args[args.indexOf('--id') + 1]!;
        deleted.push(id);
        if (id === 'exchange-old') throw new Error('delete denied');
        return '';
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    expect(() => vaultCursorKeyFile('/secure/api-key', { replaceExisting: true })).toThrow('stale OneCLI secret');
    expect(deleted).toEqual(['exchange-old', 'models-old']);
    expect(deleted).not.toContain('exchange-new');
    expect(deleted).not.toContain('models-new');
  });

  it('repairs a partial prior install by creating only the missing route', () => {
    mockExecFileSync
      .mockReturnValueOnce(
        JSON.stringify({
          data: [
            {
              id: 'exchange',
              name: 'Cursor',
              type: 'generic',
              hostPattern: 'api2.cursor.sh',
              pathPattern: '/auth/exchange_user_api_key',
            },
          ],
        }),
      )
      .mockReturnValueOnce(JSON.stringify({ id: 'models-new' }));
    expect(vaultCursorKeyFile('/secure/api-key')).toEqual(['models-new']);
    const creates = mockExecFileSync.mock.calls.filter((call) => call[1][1] === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0]![1]).toContain('api.cursor.com');
  });

  it('rolls back a route created by this call when the second create fails', () => {
    const deleted: string[] = [];
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') return JSON.stringify({ data: [] });
      if (args[1] === 'create' && args.includes('api2.cursor.sh')) return JSON.stringify({ id: 'exchange-new' });
      if (args[1] === 'create') throw new Error('models create failed');
      if (args[1] === 'delete') {
        deleted.push(args[args.indexOf('--id') + 1]!);
        return '';
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    expect(() => vaultCursorKeyFile('/secure/api-key')).toThrow('models create failed');
    expect(deleted).toEqual(['exchange-new']);
  });

  it('preserves the create error even if rollback also fails', () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') return JSON.stringify({ data: [] });
      if (args[1] === 'create' && args.includes('api2.cursor.sh')) return JSON.stringify({ id: 'exchange-new' });
      if (args[1] === 'create') throw new Error('models create failed');
      if (args[1] === 'delete') throw new Error('rollback unavailable');
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    expect(() => vaultCursorKeyFile('/secure/api-key')).toThrow('models create failed');
  });

  it('reconciles and removes a created route when OneCLI returns malformed create output', () => {
    let listCalls = 0;
    const deleted: string[] = [];
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') {
        listCalls++;
        return listCalls === 1
          ? JSON.stringify({ data: [] })
          : JSON.stringify({
              data: [
                {
                  id: 'created-despite-bad-output',
                  name: 'Cursor',
                  type: 'generic',
                  hostPattern: 'api2.cursor.sh',
                  pathPattern: '/auth/exchange_user_api_key',
                },
              ],
            });
      }
      if (args[1] === 'create') return 'not json';
      if (args[1] === 'delete') {
        deleted.push(args[args.indexOf('--id') + 1]!);
        return '';
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    expect(() => vaultCursorKeyFile('/secure/api-key')).toThrow();
    expect(deleted).toEqual(['created-despite-bad-output']);
  });
});

describe('vaultCursorKey handoff lifecycle', () => {
  it('uses a mode-0600 temp file and removes it after success', () => {
    let keyPath = '';
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') return JSON.stringify({ data: [] });
      if (args[1] === 'create') {
        keyPath = args[args.indexOf('--file') + 1]!;
        expect(fs.readFileSync(keyPath, 'utf-8')).toBe('cursor_secret_material');
        expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
        return JSON.stringify({ id: args.includes('api2.cursor.sh') ? 'exchange' : 'models' });
      }
      return '';
    });
    vaultCursorKey('cursor_secret_material');
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('removes the temp file when vaulting fails', () => {
    let keyPath = '';
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') return JSON.stringify({ data: [] });
      if (args[1] === 'create') {
        keyPath = args[args.indexOf('--file') + 1]!;
        throw new Error('vault down');
      }
      return '';
    });
    expect(() => vaultCursorKey('cursor_secret_material')).toThrow('vault down');
    expect(fs.existsSync(keyPath)).toBe(false);
  });
});

describe('runCursorLoginAuth', () => {
  it('uses the SDK helper, vaults via a mode-0600 file, and deletes the handoff', async () => {
    const vaultedPaths: string[] = [];
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'onecli' && args[1] === 'list') return JSON.stringify({ data: [] });
      if (cmd === 'onecli' && args[1] === 'create') {
        const vaultedPath = args[args.indexOf('--file') + 1];
        vaultedPaths.push(vaultedPath!);
        expect(vaultedPath).toBeDefined();
        expect(fs.readFileSync(vaultedPath!, 'utf-8')).toBe('cursor_oauth_minted_key_value');
        expect(fs.statSync(vaultedPath!).mode & 0o777).toBe(0o600);
        return JSON.stringify({ id: args.includes('api2.cursor.sh') ? 'exchange' : 'models' });
      }
      return '';
    });

    mockSpawn.mockImplementation((...args: unknown[]) => {
      expect(args[0]).toBe('bun');
      const helperArgs = args[1] as string[];
      expect(helperArgs[0]).toMatch(/cursor-auth\.ts$/);
      const keyPath = helperArgs[helperArgs.indexOf('--output') + 1]!;
      fs.writeFileSync(keyPath, 'cursor_oauth_minted_key_value', { mode: 0o600 });
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });

    await runCursorLoginAuth('browser');

    const vaultCalls = mockExecFileSync.mock.calls.filter((c) => c[0] === 'onecli' && c[1][1] === 'create');
    expect(vaultCalls).toHaveLength(2);
    const vaultArgs = vaultCalls.map((call) => call[1] as string[]);
    expect(
      vaultArgs.some((args) => args.includes('api2.cursor.sh') && args.includes('/auth/exchange_user_api_key')),
    ).toBe(true);
    expect(vaultArgs.some((args) => args.includes('api.cursor.com') && args.includes('/v1/models'))).toBe(true);
    for (const args of vaultArgs) {
      expect(args).toContain('Bearer {value}');
      expect(args).not.toContain('--value');
    }
    expect(new Set(vaultedPaths).size).toBe(1);
    expect(fs.existsSync(vaultedPaths[0]!)).toBe(false);
  });

  it('passes --no-browser for URL login', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') return JSON.stringify({ data: [] });
      if (args[1] === 'create') return JSON.stringify({ id: args.includes('api2.cursor.sh') ? 'exchange' : 'models' });
      return '';
    });
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      expect(args).toContain('--no-browser');
      const keyPath = args[args.indexOf('--output') + 1]!;
      fs.writeFileSync(keyPath, 'cursor_url_minted_key', { mode: 0o600 });
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    await runCursorLoginAuth('url');
  });

  it('cleans the handoff before exiting when the helper fails', async () => {
    let keyPath = '';
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      keyPath = args[args.indexOf('--output') + 1]!;
      fs.writeFileSync(keyPath, 'partial-secret', { mode: 0o600 });
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 17));
      return child;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    await expect(runCursorLoginAuth('browser')).rejects.toThrow('exit:1');
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('cleans the handoff before exiting when the helper writes no key', async () => {
    let keyPath = '';
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      keyPath = args[args.indexOf('--output') + 1]!;
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    await expect(runCursorLoginAuth('browser')).rejects.toThrow('exit:1');
    expect(fs.existsSync(path.dirname(keyPath))).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('rejects and deletes a non-private OAuth handoff before vaulting', async () => {
    let keyPath = '';
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      keyPath = args[args.indexOf('--output') + 1]!;
      fs.writeFileSync(keyPath, 'cursor_insecure_handoff', { mode: 0o644 });
      fs.chmodSync(keyPath, 0o644);
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    await expect(runCursorLoginAuth('browser')).rejects.toThrow('exit:1');
    expect(fs.existsSync(path.dirname(keyPath))).toBe(false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('cleans the handoff and rolls back if the second vault route fails', async () => {
    let keyPath = '';
    const deleted: string[] = [];
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      keyPath = args[args.indexOf('--output') + 1]!;
      fs.writeFileSync(keyPath, 'cursor_oauth_minted_key_value', { mode: 0o600 });
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[1] === 'list') return JSON.stringify({ data: [] });
      if (args[1] === 'create' && args.includes('api2.cursor.sh')) return JSON.stringify({ id: 'exchange-new' });
      if (args[1] === 'create') throw new Error('models route failed');
      if (args[1] === 'delete') {
        deleted.push(args[args.indexOf('--id') + 1]!);
        return '';
      }
      return '';
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    await expect(runCursorLoginAuth('browser')).rejects.toThrow('exit:1');
    expect(deleted).toEqual(['exchange-new']);
    expect(fs.existsSync(path.dirname(keyPath))).toBe(false);
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
  // On an install the skill ships in trunk; on the standalone providers branch
  // it does not, so the check is skipped rather than failed there.
  const skillPath = path.join(process.cwd(), '.claude', 'skills', 'add-cursor', 'SKILL.md');
  const skillIt = fs.existsSync(skillPath) ? it : it.skip;

  skillIt('ships the install skill used by fresh setup and standalone provider-auth', () => {
    const skill = fs.readFileSync(skillPath, 'utf-8');
    expect(skill).toContain('nanoclaw-provider: cursor');
    expect(skill).toContain('nanoclaw-provider-label: Cursor');
    expect(skill).toContain('nanoclaw-provider-hint: Cursor — account sign-in or API key');
    expect(skill).toContain('nc:copy from-branch:providers');
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
