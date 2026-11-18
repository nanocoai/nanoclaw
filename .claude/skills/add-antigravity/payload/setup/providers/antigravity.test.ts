import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayCredentialConnection, GatewayCredentialTarget } from '../gateways/credential-store.js';

const CANCEL = Symbol('cancel');
const mock = vi.hoisted(() => ({
  getCredentialStore: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), step: vi.fn(), message: vi.fn() },
  step: vi.fn(),
  userInput: vi.fn(),
}));

vi.mock('../gateways/credential-store.js', () => ({ getCredentialStore: mock.getCredentialStore }));
vi.mock('../logs.js', () => ({ step: mock.step, userInput: mock.userInput }));
vi.mock('../lib/bright-select.js', () => ({ brightSelect: mock.select }));
vi.mock('@clack/prompts', () => ({
  password: mock.password,
  confirm: mock.confirm,
  note: mock.note,
  log: mock.log,
  isCancel: (value: unknown) => value === CANCEL,
  cancel: vi.fn(),
}));

import {
  ANTIGRAVITY_BARRELS,
  ANTIGRAVITY_CREDENTIAL_PLACEHOLDER,
  ANTIGRAVITY_CREDENTIAL_TARGET,
  ANTIGRAVITY_DOCKERFILE_MARKER,
  ANTIGRAVITY_PAYLOAD_FILES,
  PROVIDER_BINARIES_CLOSE,
  antigravityCredentialConnection,
  gatewayFailure,
  geminiKeyProblem,
  runAntigravityAuthStep,
  runAntigravityInstallCheck,
  verifyAntigravityInstall,
} from './antigravity.js';

// Shaped like an AI Studio key, but not one.
const FAKE_KEY = `AIza${'Fx7'.repeat(11)}Q0`;

/** In-memory gateway holding at most the one Antigravity entry. */
function fakeGateway(stored: { reusable: boolean } | null = null) {
  const targets: GatewayCredentialTarget[] = [];
  const calls: string[] = [];
  const saves: unknown[] = [];
  let failSave: Error | undefined;
  let failKeep: Error | undefined;
  let hostChange: [string, string] | undefined;
  const connection = (target: GatewayCredentialTarget): GatewayCredentialConnection => {
    targets.push(target);
    return {
      find: async (options) => {
        calls.push('find');
        if (hostChange && !(await options?.confirmHostChange(...hostChange))) throw new Error('host change declined');
        return stored;
      },
      keep: async () => {
        calls.push('keep');
        if (failKeep) throw failKeep;
      },
      save: async (value) => {
        calls.push('save');
        if (failSave) throw failSave;
        saves.push(value);
        stored = { reusable: true };
      },
    };
  };
  mock.getCredentialStore.mockResolvedValue({ has: vi.fn(), save: vi.fn(), connection });
  return {
    targets,
    calls,
    saves,
    failSaveWith: (err: Error) => (failSave = err),
    failKeepWith: (err: Error) => (failKeep = err),
    moveFrom: (previous: string) => (hostChange = [previous, 'generativelanguage.googleapis.com']),
  };
}

function exitThrows(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  }) as typeof process.exit);
}

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

const tempDirs: string[] = [];
const ttyDescriptors = {
  stdin: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
  stdout: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
};

beforeEach(() => {
  for (const fn of [mock.getCredentialStore, mock.password, mock.confirm, mock.select, mock.step, mock.userInput]) {
    fn.mockReset();
  }
  for (const fn of Object.values(mock.log)) fn.mockReset();
  mock.note.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [stream, descriptor] of [
    [process.stdin, ttyDescriptors.stdin],
    [process.stdout, ttyDescriptors.stdout],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Antigravity gateway credential', () => {
  it('describes one host-wide x-goog-api-key entry for the Gemini API, carrying the container placeholder', async () => {
    const { targets } = fakeGateway();
    await antigravityCredentialConnection('/fixture');
    expect(mock.getCredentialStore).toHaveBeenCalledWith('/fixture');
    expect(targets).toEqual([
      {
        name: 'Antigravity Gemini API',
        kind: 'api-key',
        host: 'generativelanguage.googleapis.com',
        injection: { headerName: 'x-goog-api-key', valueFormat: '{value}' },
        proxyValue: 'nc-antigravity-placeholder',
        provider: 'antigravity',
      },
    ]);
    // No path: works on gateways without connectionPaths.
    expect('path' in ANTIGRAVITY_CREDENTIAL_TARGET).toBe(false);
  });

  it('uses the same placeholder the host adapter hands the container', () => {
    const hostFile = path.join(process.cwd(), 'src', 'providers', 'antigravity.ts');
    if (!fs.existsSync(hostFile)) return;
    expect(fs.readFileSync(hostFile, 'utf-8')).toContain(
      `ANTIGRAVITY_API_KEY_PLACEHOLDER = '${ANTIGRAVITY_CREDENTIAL_PLACEHOLDER}'`,
    );
  });

  it('refuses a gateway that only stores provider-named credentials', async () => {
    mock.getCredentialStore.mockResolvedValue({ has: vi.fn(), save: vi.fn() });
    await expect(antigravityCredentialConnection()).rejects.toThrow('does not support provider credential connections');
  });
});

describe('Gemini API key checks', () => {
  it('blocks only empty input and embedded whitespace', () => {
    expect(geminiKeyProblem(undefined)).toBe('Enter a Gemini API key.');
    expect(geminiKeyProblem('   ')).toBe('Enter a Gemini API key.');
    expect(geminiKeyProblem('AIza abc')).toMatch(/no spaces/);
    expect(geminiKeyProblem('AIza\nabc')).toMatch(/no spaces/);
    expect(geminiKeyProblem(`  ${FAKE_KEY}  `)).toBeUndefined();
    expect(geminiKeyProblem('some-other-key-format')).toBeUndefined();
  });

  it('masks the key and token-like runs in gateway errors and keeps one line', () => {
    expect(gatewayFailure(new Error(`rejected value ${FAKE_KEY}\nstack line`), FAKE_KEY)).toBe(
      'rejected value [redacted]',
    );
    expect(gatewayFailure(new Error('bad abcdefghijklmnopqrstuvwxyz0123'))).toBe('bad [redacted]');
    expect(gatewayFailure(new Error('short-key leaked'), 'short-key')).toBe('[redacted] leaked');
    expect(gatewayFailure(new SyntaxError(`Unexpected token in ${FAKE_KEY}`))).not.toContain('AIza');
  });
});

describe('runAntigravityAuthStep', () => {
  // The key prompt needs a terminal; tests that need none set it themselves.
  beforeEach(() => setTty(true));

  it('refuses to prompt for a new key without a terminal instead of exiting 0', async () => {
    setTty(false);
    const gateway = fakeGateway();
    exitThrows();
    await expect(runAntigravityAuthStep()).rejects.toThrow('exit:1');
    expect(mock.password).not.toHaveBeenCalled();
    expect(gateway.calls).toEqual(['find']);
    expect(mock.step).toHaveBeenCalledWith('auth', 'failed', 0, { PROVIDER: 'antigravity', ERROR: 'no_terminal' });
  });

  it('saves a pasted key to the gateway after one read, without echoing it', async () => {
    const gateway = fakeGateway();
    mock.password.mockResolvedValue(`  ${FAKE_KEY}  `);
    await runAntigravityAuthStep({ root: '/fixture' });
    expect(gateway.calls).toEqual(['find', 'save']);
    expect(gateway.saves).toEqual([FAKE_KEY]);
    expect(mock.password).toHaveBeenCalledOnce();
    expect(mock.password.mock.calls[0]![0]).toMatchObject({ validate: geminiKeyProblem });
    expect(mock.step).toHaveBeenCalledWith('auth', 'success', 0, { PROVIDER: 'antigravity', METHOD: 'api-key' });
    const everythingShown = JSON.stringify([
      mock.note.mock.calls,
      mock.step.mock.calls,
      mock.userInput.mock.calls,
      ...Object.values(mock.log).map((fn) => fn.mock.calls),
    ]);
    expect(everythingShown).not.toContain(FAKE_KEY);
  });

  it('explains API-key billing and why there is no Google account sign-in', async () => {
    fakeGateway();
    mock.password.mockResolvedValue(FAKE_KEY);
    await runAntigravityAuthStep();
    const [body] = mock.note.mock.calls[0]!;
    expect(body).toContain('https://aistudio.google.com/apikey');
    expect(body).toMatch(/billed/);
    expect(body).toMatch(/third-party harness/);
  });

  it('saves a key in any format Google issues, without a warning', async () => {
    const newFormat = `AQ.${'Ab3_x-'.repeat(8)}`;
    const gateway = fakeGateway();
    mock.password.mockResolvedValue(newFormat);
    await runAntigravityAuthStep();
    expect(gateway.saves).toEqual([newFormat]);
    expect(mock.log.warn).not.toHaveBeenCalled();
  });

  it('keeps a reusable stored key when the operator chooses to', async () => {
    setTty(true);
    const gateway = fakeGateway({ reusable: true });
    mock.select.mockResolvedValue('keep');
    await runAntigravityAuthStep();
    expect(mock.select.mock.calls[0]![0].options.map((o: { value: string }) => o.value)).toEqual(['keep', 'replace']);
    expect(gateway.calls).toEqual(['find', 'keep']);
    expect(mock.password).not.toHaveBeenCalled();
    expect(mock.step).toHaveBeenCalledWith('auth', 'skipped', 0, {
      REASON: 'antigravity-key-already-present',
      PROVIDER: 'antigravity',
    });
  });

  it('replaces a reusable stored key when the operator chooses to', async () => {
    setTty(true);
    const gateway = fakeGateway({ reusable: true });
    mock.select.mockResolvedValue('replace');
    mock.password.mockResolvedValue(FAKE_KEY);
    await runAntigravityAuthStep();
    expect(gateway.calls).toEqual(['find', 'save']);
    expect(mock.log.success.mock.calls.at(-1)![0]).toMatch(/replaced/);
  });

  it('keeps a reusable key without asking when there is no terminal, so provider-auth stays idempotent', async () => {
    setTty(false);
    const gateway = fakeGateway({ reusable: true });
    await runAntigravityAuthStep();
    expect(mock.select).not.toHaveBeenCalled();
    expect(gateway.calls).toEqual(['find', 'keep']);
  });

  it('asks for the key straight away when forced, even if one is stored', async () => {
    setTty(true);
    const gateway = fakeGateway({ reusable: true });
    mock.password.mockResolvedValue(FAKE_KEY);
    await runAntigravityAuthStep({ force: true });
    expect(mock.select).not.toHaveBeenCalled();
    expect(gateway.calls).toEqual(['find', 'save']);
  });

  it('asks for the key again when the stored entry cannot be kept', async () => {
    const gateway = fakeGateway({ reusable: false });
    mock.password.mockResolvedValue(FAKE_KEY);
    await runAntigravityAuthStep();
    expect(mock.select).not.toHaveBeenCalled();
    expect(gateway.calls).toEqual(['find', 'save']);
  });

  it('asks before moving a stored entry from another host, and stops if declined', async () => {
    const gateway = fakeGateway();
    gateway.moveFrom('old.example.com');
    mock.confirm.mockResolvedValue(false);
    exitThrows();
    await expect(runAntigravityAuthStep()).rejects.toThrow('exit:1');
    expect(mock.confirm.mock.calls[0]![0]).toMatchObject({ initialValue: false });
    expect(mock.confirm.mock.calls[0]![0].message).toContain('old.example.com');
    expect(gateway.saves).toEqual([]);
  });

  it('fails before prompting when the gateway cannot be read', async () => {
    mock.getCredentialStore.mockRejectedValue(new Error('Unknown gateway: nope'));
    exitThrows();
    await expect(runAntigravityAuthStep()).rejects.toThrow('exit:1');
    expect(mock.password).not.toHaveBeenCalled();
    expect(mock.step).toHaveBeenCalledWith('auth', 'failed', 0, {
      PROVIDER: 'antigravity',
      ERROR: 'gateway_lookup_failed: Unknown gateway: nope',
    });
  });

  it('exits on a failed save and never logs the key the gateway echoed', async () => {
    const gateway = fakeGateway();
    gateway.failSaveWith(new Error(`gateway refused ${FAKE_KEY}`));
    mock.password.mockResolvedValue(FAKE_KEY);
    exitThrows();
    await expect(runAntigravityAuthStep()).rejects.toThrow('exit:1');
    const logged = JSON.stringify([mock.step.mock.calls, mock.log.error.mock.calls]);
    expect(logged).toContain('gateway refused [redacted]');
    expect(logged).not.toContain(FAKE_KEY);
  });

  it('exits when the gateway cannot keep the stored key', async () => {
    setTty(false);
    const gateway = fakeGateway({ reusable: true });
    gateway.failKeepWith(new Error('entry changed since find'));
    exitThrows();
    await expect(runAntigravityAuthStep()).rejects.toThrow('exit:1');
    expect(mock.step).toHaveBeenCalledWith('auth', 'failed', 0, {
      PROVIDER: 'antigravity',
      ERROR: 'gateway_keep_failed: entry changed since find',
    });
  });

  it('treats a cancelled prompt as cancelled setup', async () => {
    const gateway = fakeGateway();
    mock.password.mockResolvedValue(CANCEL);
    exitThrows();
    await expect(runAntigravityAuthStep()).rejects.toThrow('exit:1');
    expect(gateway.saves).toEqual([]);
  });
});

const DOCKERFILE_BLOCK = [
  ANTIGRAVITY_DOCKERFILE_MARKER,
  'ARG AGY_VERSION=1.5.8',
  'COPY install-antigravity.sh /tmp/install-antigravity.sh',
  'RUN AGY_REQUESTED_VERSION="${AGY_VERSION}" sh /tmp/install-antigravity.sh && rm /tmp/install-antigravity.sh',
  'ENV AGY_CLI_DISABLE_AUTO_UPDATE=true',
].join('\n');

/** A core Dockerfile shaped like trunk's, with `inside` in the provider-binaries region. */
function coreDockerfile(inside: string, after = ''): string {
  return [
    'FROM node:22-slim',
    '# >>> nanoclaw:provider-binaries',
    ...(inside ? [inside] : []),
    `# ${PROVIDER_BINARIES_CLOSE}`,
    '# ---- Workspace + permissions ----',
    'USER node',
    'LABEL org.example=1',
    ...(after ? [after] : []),
    '',
  ].join('\n');
}

function fakeAntigravityTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-install-check-'));
  tempDirs.push(root);
  for (const file of ANTIGRAVITY_PAYLOAD_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '// present\n');
  }
  for (const barrel of ANTIGRAVITY_BARRELS) {
    fs.mkdirSync(path.dirname(path.join(root, barrel)), { recursive: true });
    fs.writeFileSync(path.join(root, barrel), "import './claude.js';\nimport './antigravity.js';\n");
  }
  fs.writeFileSync(path.join(root, 'container/Dockerfile'), coreDockerfile(DOCKERFILE_BLOCK));
  return root;
}

describe('verifyAntigravityInstall', () => {
  // Runs where /add-antigravity has been applied (the install verifier runs
  // setup/providers tests in that tree); skipped on a bare checkout.
  const installedIt = fs.existsSync(path.join(process.cwd(), 'container/agent-runner/src/providers/antigravity.ts'))
    ? it
    : it.skip;

  installedIt('passes on a tree with the antigravity payload wired', () => {
    expect(verifyAntigravityInstall()).toEqual({ ok: true, problems: [] });
  });

  it('passes on a complete fake tree', () => {
    expect(verifyAntigravityInstall(fakeAntigravityTree())).toEqual({ ok: true, problems: [] });
  });

  it('checks all five barrels, including the setup and runtime ones', () => {
    expect(ANTIGRAVITY_BARRELS).toEqual([
      'src/providers/index.ts',
      'src/provider-contracts/index.ts',
      'container/agent-runner/src/providers/index.ts',
      'container/agent-runner/src/provider-contracts/index.ts',
      'setup/providers/index.ts',
    ]);
  });

  it.each(ANTIGRAVITY_PAYLOAD_FILES)('reports a missing payload file: %s', (file) => {
    const root = fakeAntigravityTree();
    fs.rmSync(path.join(root, file));
    expect(verifyAntigravityInstall(root)).toEqual({ ok: false, problems: [`missing file: ${file}`] });
  });

  it.each(ANTIGRAVITY_BARRELS)('reports a missing barrel line: %s', (barrel) => {
    const root = fakeAntigravityTree();
    fs.writeFileSync(path.join(root, barrel), "import './claude.js';\n");
    expect(verifyAntigravityInstall(root)).toEqual({ ok: false, problems: [`missing barrel import in ${barrel}`] });
  });

  it('reports a Dockerfile without the Antigravity block', () => {
    const root = fakeAntigravityTree();
    fs.writeFileSync(path.join(root, 'container/Dockerfile'), coreDockerfile(''));
    expect(verifyAntigravityInstall(root).problems).toEqual([
      `container/Dockerfile is missing the Antigravity CLI block (${ANTIGRAVITY_DOCKERFILE_MARKER})`,
    ]);
  });

  it('reports a block that never runs the installer', () => {
    const root = fakeAntigravityTree();
    fs.writeFileSync(
      path.join(root, 'container/Dockerfile'),
      coreDockerfile(`${ANTIGRAVITY_DOCKERFILE_MARKER}\nENV AGY_CLI_DISABLE_AUTO_UPDATE=true`),
    );
    expect(verifyAntigravityInstall(root).problems).toEqual([
      'container/Dockerfile Antigravity block does not run install-antigravity.sh',
    ]);
  });

  it("accepts the block when another skill's block shares the region", () => {
    const root = fakeAntigravityTree();
    const other = '# ---- another skill ----\nRUN true';
    for (const inside of [`${other}\n${DOCKERFILE_BLOCK}`, `${DOCKERFILE_BLOCK}\n${other}`]) {
      fs.writeFileSync(path.join(root, 'container/Dockerfile'), coreDockerfile(inside));
      expect(verifyAntigravityInstall(root)).toEqual({ ok: true, problems: [] });
    }
  });

  it('reports a block outside the provider-binaries region, where it would run as node', () => {
    const root = fakeAntigravityTree();
    fs.writeFileSync(path.join(root, 'container/Dockerfile'), coreDockerfile('', DOCKERFILE_BLOCK));
    expect(verifyAntigravityInstall(root).problems).toEqual([
      'container/Dockerfile Antigravity block must sit inside the nanoclaw:provider-binaries region',
    ]);
  });

  it('fails setup instead of continuing with an incomplete provider', async () => {
    const root = fakeAntigravityTree();
    fs.rmSync(path.join(root, 'container/install-antigravity.sh'));
    await expect(runAntigravityInstallCheck(root)).rejects.toThrow(
      'Antigravity provider install is incomplete: missing file: container/install-antigravity.sh',
    );
    expect(mock.step).toHaveBeenCalledWith('antigravity-install', 'failed', 0, {
      PROBLEMS: 'missing file: container/install-antigravity.sh',
    });
  });

  it('logs success on a complete tree', async () => {
    await runAntigravityInstallCheck(fakeAntigravityTree());
    expect(mock.step).toHaveBeenCalledWith('antigravity-install', 'success', 0, {});
  });
});

describe('trunk reach-ins', () => {
  // The skill ships in trunk; an applied tree may not carry it, so the check
  // is skipped rather than failed there.
  const skillPath = path.join(process.cwd(), '.claude', 'skills', 'add-antigravity', 'SKILL.md');
  const skillIt = fs.existsSync(skillPath) ? it : it.skip;

  skillIt('ships the install skill used by fresh setup and standalone provider-auth', () => {
    const skill = fs.readFileSync(skillPath, 'utf-8');
    expect(skill).toContain('nanoclaw-provider: antigravity');
    expect(skill).toContain('nanoclaw-provider-label: Antigravity');
    expect(skill).toContain('nanoclaw-provider-hint: Google Antigravity CLI — Gemini API key');
    expect(skill).toContain('payload/setup/providers/antigravity.ts -> setup/providers/antigravity.ts');
    expect(skill).toContain(ANTIGRAVITY_DOCKERFILE_MARKER);
    expect(skill).toContain('--step provider-auth antigravity');
    for (const barrel of ANTIGRAVITY_BARRELS) expect(skill).toContain(`nc:append to:${barrel}`);
  });

  it('registers the setup entry with the label and hint the skill frontmatter carries', async () => {
    const { getSetupProvider } = await import('./registry.js');
    await import('./antigravity.js');
    expect(getSetupProvider('antigravity')).toMatchObject({
      value: 'antigravity',
      label: 'Antigravity',
      hint: 'Google Antigravity CLI — Gemini API key',
    });
  });
});
