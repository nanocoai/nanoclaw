# Bureaucracy Automation MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `daniel-personal`'s `agent-browser` log into, monitor, and (with approval) submit forms on personal bureaucracy sites — piloted read-only on Har HaKesef — without the agent ever seeing a stored password.

**Architecture:** `agent-browser` (the pinned CLI, `container/cli-tools.json` — a compiled Rust binary, not something this repo can patch) already ships a credential vault (`auth save`/`auth login`, docs say "the LLM never sees passwords"), session persistence (`--session-name`, saved under `~/.agent-browser/`), and an action-confirmation gate (`confirm <id>`/`deny <id>`). This plan does NOT rebuild any of that. It (1) makes `~/.agent-browser/` survive container restarts and encrypts it at rest, (2) adds one narrow piece of host-adjacent plumbing so a one-time credential-setup chat reply reaches `agent-browser auth save` without ever becoming part of the agent's own LLM context, and (3) bridges a submission-shaped `agent-browser` action into nanoclaw's existing admin-approval flow.

**Tech Stack:** Node/pnpm host, Bun agent-runner container, `agent-browser` 0.27.1 CLI, existing `container_configs.direct_browser_egress` flag (this session's prior feature), existing approvals/guard/delivery-action machinery.

**Spec:** `docs/superpowers/specs/2026-09-17-bureaucracy-automation-design.md` — read it first. Note: this plan supersedes the spec's §4.1 (`site_credentials` table), §4.3's `fill-credential` subcommand, and §4.4's custom storage-state file — those are replaced by `agent-browser`'s own native vault/session mechanism, discovered by inspecting the real installed CLI (`agent-browser --help` and `agent-browser skills get core --full` inside the real container image) after the spec was approved. The spec's §3 constraint (agent never sees plaintext), §4.5's approval requirement, and the Har HaKesef pilot scope are unchanged and still govern this plan.

## Global Constraints

- The agent (the LLM) must NEVER see a stored static credential's plaintext value, in any tool result, log line, or approval-card content. One-time SMS/biometric OTP codes are exempt — they are single-use and expire in minutes.
- Every submission-shaped `agent-browser` action MUST route through nanoclaw's admin-approval flow before the real submit click. No auto-submit path anywhere in this MVP.
- `nanoclaw-egress`, `nanoclaw-browser-egress`, and the gateway/proxy mechanics from the already-shipped direct-browser-egress feature (`src/browser-direct-egress.ts`, `src/drivers/*`) must not be touched by this plan. This plan builds strictly on top of that feature — reuse `container_configs.direct_browser_egress` as the single opt-in flag; do not add a second flag.
- Deploying this plan requires `./container/build.sh` (it touches `container/agent-runner/src/`), unlike the direct-browser-egress deploy which was host-only.
- Deploy procedure: `git -c core.autocrlf=false archive HEAD | ssh -o IdentitiesOnly=yes -i ~/.ssh/spentkatz_mac gromit@192.168.1.19 "cd ~/nanoclaw && tar -x"`, then on the Mac restore the 2 local-install-diff files (`package.json`'s `"@chat-adapter/telegram": "4.29.0",` dependency entry, `src/channels/index.ts`'s trailing `import './telegram.js';` line — both wiped by every archive since they're not committed to trunk), `pnpm install --no-frozen-lockfile`, `rm -rf docs/superpowers` (stray plan-doc dir) — **never `rm -rf tmp`**, that directory is load-bearing at runtime (OneCLI's SDK writes `tmp/onecli-proxy-ca.pem` there on every container spawn) — `pnpm run build`, `./container/build.sh`, then `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-2c757f81`.

---

### Task 1: Persist `agent-browser`'s vault/session state across container restarts

**Files:**
- Create: `src/agent-browser-state.ts`
- Test: `src/agent-browser-state.test.ts`
- Modify: `src/container-runner.ts` (in `composeSessionSpec`, the `directBrowserEgress` block added by the prior feature — around where `browserShimMount` is pushed)

**Interfaces:**
- Consumes: `MountSpec` from `src/drivers/types.ts`; `DATA_DIR` from `src/config.ts`; the existing `containerConfig.directBrowserEgress` boolean already computed in `composeSessionSpec` (see `src/container-runner.ts`'s `const directBrowserEgress = containerConfig.directBrowserEgress === true;` line).
- Produces: `agentBrowserStateMount(agentGroupId: string, dataRoot?: string): MountSpec` and `agentBrowserEncryptionKey(agentGroupId: string, hostDir?: string): string` — both consumed by Task 1's own `composeSessionSpec` edit only (no other task calls these directly).

Containers are `docker create --rm` (see `src/drivers/docker-driver.ts`), so anything `agent-browser` writes to its default state directory (confirmed by inspecting the real image: `whoami` → `node`, `HOME=/home/node`, and the CLI's own docs say session state saves to `~/.agent-browser/sessions/` — the auth vault lives alongside it, under the same `~/.agent-browser/` tree) is lost every time the container restarts. Without this task, every login (and the one-time `auth save`, Task 3) would have to be redone on every container spawn.

- [ ] **Step 1: Confirm the exact `~/.agent-browser` layout before writing the mount**

Run this read-only check (no state changed) to pin down whether `auth save`'s vault and `--session-name`'s sessions live under the SAME top-level directory (so one mount covers both) or need two separate mounts:

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/spentkatz_mac gromit@192.168.1.19 "export PATH=\$HOME/.colima/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH; docker run --rm --entrypoint sh nanoclaw-agent-v2-2c757f81:ag-1788707397091-apedp4 -c '
export HOME=/tmp/abtest
mkdir -p \$HOME
echo testpass | agent-browser auth save test-site --url https://example.com --username testuser --password-stdin
agent-browser --session-name test-session open https://example.com >/dev/null 2>&1
agent-browser close >/dev/null 2>&1
find \$HOME/.agent-browser -maxdepth 3
'"
```

Expected: a directory tree under `/tmp/abtest/.agent-browser/` showing where `auth` vault entries and named sessions each land (likely `.agent-browser/auth/` and `.agent-browser/sessions/`, but confirm — don't assume). Record the exact subdirectory names; if they differ from `auth/` and `sessions/` below, adjust Step 2 and Step 3's `containerPath`/`find` calls to match what this step actually found, and note the correction in your task report.

- [ ] **Step 2: Write the failing test**

```typescript
// src/agent-browser-state.test.ts
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { agentBrowserEncryptionKey, agentBrowserStateMount } from './agent-browser-state.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-agent-browser-state-'));
}

describe('agentBrowserStateMount', () => {
  it('mounts under the group-state data root, read-write', () => {
    const dataRoot = tmpDir();
    const mount = agentBrowserStateMount('agent-1', dataRoot);
    expect(mount.class).toBe('group-state');
    expect(mount.mode).toBe('rw');
    expect(mount.groupScope).toBe('agent-1');
    expect(mount.hostPath).toBe(path.join(dataRoot, 'v2-sessions', 'agent-1', 'agent-browser-state'));
    expect(mount.containerPath).toBe('/home/node/.agent-browser');
  });

  it('creates the host directory if missing', () => {
    const dataRoot = tmpDir();
    agentBrowserStateMount('agent-1', dataRoot);
    expect(fs.existsSync(path.join(dataRoot, 'v2-sessions', 'agent-1', 'agent-browser-state'))).toBe(true);
  });
});

describe('agentBrowserEncryptionKey', () => {
  it('generates a 64-char hex key on first call and persists it', () => {
    const hostDir = tmpDir();
    const key1 = agentBrowserEncryptionKey('agent-1', hostDir);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
    const key2 = agentBrowserEncryptionKey('agent-1', hostDir);
    expect(key2).toBe(key1);
  });

  it('gives different groups different keys', () => {
    const hostDir = tmpDir();
    const keyA = agentBrowserEncryptionKey('agent-a', hostDir);
    const keyB = agentBrowserEncryptionKey('agent-b', hostDir);
    expect(keyA).not.toBe(keyB);
  });
});
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/agent-browser-state.test.ts`
Expected: FAIL — `agent-browser-state.js` does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/agent-browser-state.ts
/**
 * Persistence for `agent-browser`'s own credential vault and session state
 * across container restarts — and the per-group key that encrypts both at
 * rest. `agent-browser` already implements the vault (`auth save`/`auth
 * login`) and session persistence (`--session-name`) natively; this module
 * only keeps its state directory from being lost to `docker create --rm`
 * and gives each group's vault its own encryption key.
 *
 * Opt-in via the SAME flag as direct browser egress
 * (`container_configs.direct_browser_egress`) — there is no separate flag.
 * A group with no real internet route has nothing here worth persisting.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import type { MountSpec } from './drivers/types.js';

/** Container path confirmed against the real image in Task 1 Step 1 — HOME=/home/node when `runAs` maps a non-root uid (see composeSessionSpec). */
const AGENT_BROWSER_HOME = '/home/node/.agent-browser';

/** Host directory holding the per-group encryption keys. Never mounted — read host-side only, into `contributedEnv`. */
export const AGENT_BROWSER_KEY_HOST_DIR = path.join(DATA_DIR, 'agent-browser-keys');

export function agentBrowserStateMount(agentGroupId: string, dataRoot: string = DATA_DIR): MountSpec {
  const hostPath = path.join(dataRoot, 'v2-sessions', agentGroupId, 'agent-browser-state');
  fs.mkdirSync(hostPath, { recursive: true });
  return {
    class: 'group-state',
    hostPath,
    containerPath: AGENT_BROWSER_HOME,
    mode: 'rw',
    groupScope: agentGroupId,
  };
}

/**
 * One key per group, generated once and reused forever. A 64-char hex
 * string never matches `looksLikeCredential`'s issuer-prefix patterns, so it
 * is safe to carry in `contributedEnv` (the sanctioned lane) despite the
 * `AGENT_BROWSER_ENCRYPTION_KEY` name ending in `_KEY` — `validateSpec`
 * only name-checks plain `env`, never `contributedEnv`.
 */
export function agentBrowserEncryptionKey(agentGroupId: string, hostDir: string = AGENT_BROWSER_KEY_HOST_DIR): string {
  fs.mkdirSync(hostDir, { recursive: true });
  const keyPath = path.join(hostDir, `${agentGroupId}.key`);
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, 'utf-8').trim();
  const key = randomBytes(32).toString('hex');
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run src/agent-browser-state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into `composeSessionSpec`**

In `src/container-runner.ts`, find the block the direct-browser-egress feature added (`const directBrowserEgress = containerConfig.directBrowserEgress === true;` through the `mounts:` line using `composedMounts`). Add, in the same `if (directBrowserEgress)` scope:

```typescript
import { agentBrowserEncryptionKey, agentBrowserStateMount } from './agent-browser-state.js';

// ... inside composeSessionSpec, alongside the existing
// `if (directBrowserEgress) composedMounts.push(browserShimMount(agentGroup.id));`
if (directBrowserEgress) {
  composedMounts.push(browserShimMount(agentGroup.id));
  composedMounts.push(agentBrowserStateMount(agentGroup.id));
  contributedEnv.AGENT_BROWSER_ENCRYPTION_KEY = agentBrowserEncryptionKey(agentGroup.id);
}
```

(`contributedEnv` is already an object in scope earlier in the function — confirm its exact declaration line by reading the surrounding ~40 lines of `composeSessionSpec` before editing; do not redeclare it.)

- [ ] **Step 6: Add a `composeSessionSpec` test**

In `src/container-runner.test.ts`, in the existing `describe('composeSessionSpec — direct browser egress', ...)` block (added by the prior feature), add:

```typescript
it('persists agent-browser state and sets a per-group encryption key when opted in', () => {
  const spec = compose({ containerConfig: optedIn });
  const stateMount = spec.containers[0].mounts.find((m) => m.containerPath === '/home/node/.agent-browser');
  expect(stateMount).toBeDefined();
  expect(stateMount!.class).toBe('group-state');
  expect(stateMount!.mode).toBe('rw');
  expect(spec.containers[0].contributedEnv?.AGENT_BROWSER_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
});

it('does not persist agent-browser state for a group that did not opt in', () => {
  const spec = compose();
  expect(spec.containers[0].mounts.some((m) => m.containerPath === '/home/node/.agent-browser')).toBe(false);
  expect(spec.containers[0].contributedEnv?.AGENT_BROWSER_ENCRYPTION_KEY).toBeUndefined();
});
```

- [ ] **Step 7: Run the full container-runner test file and typecheck**

Run: `node_modules/.bin/vitest run src/container-runner.test.ts src/agent-browser-state.test.ts`
Expected: all PASS.
Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/agent-browser-state.ts src/agent-browser-state.test.ts src/container-runner.ts src/container-runner.test.ts
git commit -m "feat(bureaucracy-automation): persist agent-browser vault/session state across restarts"
```

---

### Task 2: Session-state helpers for the credential-capture flow

**Files:**
- Create: `container/agent-runner/src/db/credential-capture.ts`
- Test: `container/agent-runner/src/db/credential-capture.test.ts`

**Interfaces:**
- Consumes: `getAgentMailbox` from `../mailbox/index.js` (same primitive `session-state.ts` uses — read `container/agent-runner/src/db/session-state.ts` in full before writing this file; mirror its `getValue`/`setValue`/`deleteValue` shape exactly, don't reinvent it).
- Produces: `PendingCredentialCapture { site: string; url: string; step: 'username' | 'password'; username?: string }`, `getPendingCredentialCapture(): PendingCredentialCapture | undefined`, `setPendingCredentialCapture(state: PendingCredentialCapture): void`, `clearPendingCredentialCapture(): void`. Consumed by Task 3.

This is container-local, per-session state (bun:sqlite via the mailbox abstraction, same DB Task 3's poll-loop interception reads from) — not a central-DB migration. It tracks "we are mid-way through capturing a credential for site X, waiting on step Y" so the poll loop (Task 3) knows to intercept the next inbound reply instead of handing it to the LLM.

- [ ] **Step 1: Write the failing test**

```typescript
// container/agent-runner/src/db/credential-capture.test.ts
import { describe, expect, it } from 'bun:test';

import {
  clearPendingCredentialCapture,
  getPendingCredentialCapture,
  setPendingCredentialCapture,
} from './credential-capture.js';

describe('pending credential capture state', () => {
  it('is undefined when nothing is pending', () => {
    clearPendingCredentialCapture();
    expect(getPendingCredentialCapture()).toBeUndefined();
  });

  it('round-trips a set value', () => {
    setPendingCredentialCapture({ site: 'har-hakesef', url: 'https://itur.mof.gov.il', step: 'username' });
    expect(getPendingCredentialCapture()).toEqual({
      site: 'har-hakesef',
      url: 'https://itur.mof.gov.il',
      step: 'username',
    });
  });

  it('advances to the password step carrying the captured username', () => {
    setPendingCredentialCapture({
      site: 'har-hakesef',
      url: 'https://itur.mof.gov.il',
      step: 'password',
      username: '123456789',
    });
    expect(getPendingCredentialCapture()?.step).toBe('password');
    expect(getPendingCredentialCapture()?.username).toBe('123456789');
  });

  it('clears', () => {
    setPendingCredentialCapture({ site: 'x', url: 'https://x.example', step: 'username' });
    clearPendingCredentialCapture();
    expect(getPendingCredentialCapture()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `container/agent-runner/`): `bun test src/db/credential-capture.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// container/agent-runner/src/db/credential-capture.ts
/**
 * Tracks an in-progress agent-browser credential-vault setup for THIS
 * session — at most one at a time. The poll loop (poll-loop.ts) checks this
 * on every inbound message and, while a capture is pending, intercepts the
 * reply itself instead of ever turning it into an LLM prompt. See
 * request_credential_setup in mcp-tools/bureaucracy-automation.ts.
 */
import { getAgentMailbox } from '../mailbox/index.js';

const STATE_KEY = 'pending_credential_capture';

export interface PendingCredentialCapture {
  site: string;
  url: string;
  step: 'username' | 'password';
  /** Set once the username step completes; carried into the password step. */
  username?: string;
}

export function getPendingCredentialCapture(): PendingCredentialCapture | undefined {
  const raw = getAgentMailbox().operations.getState(STATE_KEY)?.value;
  return raw ? (JSON.parse(raw) as PendingCredentialCapture) : undefined;
}

export function setPendingCredentialCapture(state: PendingCredentialCapture): void {
  getAgentMailbox().operations.setState(STATE_KEY, JSON.stringify(state));
}

export function clearPendingCredentialCapture(): void {
  getAgentMailbox().operations.deleteState(STATE_KEY);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/db/credential-capture.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/db/credential-capture.ts container/agent-runner/src/db/credential-capture.test.ts
git commit -m "feat(bureaucracy-automation): add pending-credential-capture session state"
```

---

### Task 3: Credential-setup MCP tool + poll-loop interception + `auth save`

**Files:**
- Create: `container/agent-runner/src/mcp-tools/bureaucracy-automation.ts`
- Test: `container/agent-runner/src/mcp-tools/bureaucracy-automation.test.ts`
- Modify: `container/agent-runner/src/poll-loop.ts` (the message-classification block that already special-cases `/clear` and `/upload-trace` — see the loop in `runPollLoop` around the `commandIds`/`normalMessages` split)
- Modify: `container/agent-runner/src/mcp-tools/server.js`-registered tool barrel — read how `installPackages`/`addMcpServer` get registered (grep `registerTools` call sites) and add this task's new tool the same way.

**Interfaces:**
- Consumes: `PendingCredentialCapture`, `getPendingCredentialCapture`, `setPendingCredentialCapture`, `clearPendingCredentialCapture` from Task 2's `../db/credential-capture.js`; `writeMessageOut` from `../db/messages-out.js` (used the same way `interactive.ts` and `self-mod.ts` already use it).
- Produces: the `request_credential_setup` MCP tool (agent-facing: declares intent only, never carries a secret); `handleCredentialCaptureReply(text: string): Promise<boolean>` — called from `poll-loop.ts` per inbound message; returns `true` if the message was a credential-capture reply (and was fully handled — the poll loop must `continue`, never hand it to the LLM), `false` otherwise (normal message, falls through to the existing `normalMessages` path).

This is the task that satisfies the "agent never sees plaintext" constraint for real: `handleCredentialCaptureReply` runs as ordinary deterministic TypeScript inside the agent-runner's own poll loop — never inside an LLM turn — exactly like the existing `/clear` and `/upload-trace` interceptions a few lines above it in `poll-loop.ts`.

- [ ] **Step 1: Read the exact interception shape to mirror**

Open `container/agent-runner/src/poll-loop.ts` and read the `for (const msg of messages) { if (... isClearCommand(msg)) { ... continue; } if (... isUploadTraceCommand(msg)) { ... continue; } }` block in full (inside `runPollLoop`). Your Step 4 edit adds a third branch in that same loop, same shape: check the condition, do the deterministic work, `writeMessageOut` a confirmation, push to `commandIds`, `continue`. Do not add a new loop or a new code path outside this existing one.

- [ ] **Step 2: Write the failing test for the MCP tool**

Before writing this test, check how `interactive.test.ts` (the `ask_user_question` test) sets up its test DB / session fixture — its handler also calls `getSessionRouting()` internally, so whatever fixture makes that test file's DB calls work (a test DB helper, a `beforeEach` seeding a session-routing row, etc.) is what this test needs too. Reuse that fixture rather than mocking `getSessionRouting` directly, unless `interactive.test.ts` itself mocks it — mirror whatever it actually does.

```typescript
// container/agent-runner/src/mcp-tools/bureaucracy-automation.test.ts
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { clearPendingCredentialCapture, getPendingCredentialCapture } from '../db/credential-capture.js';
import { requestCredentialSetup } from './bureaucracy-automation.js';

describe('requestCredentialSetup', () => {
  afterEach(() => clearPendingCredentialCapture());

  it('starts a pending capture at the username step and never echoes a value back', async () => {
    const result = await requestCredentialSetup.handler({ site: 'har-hakesef', url: 'https://itur.mof.gov.il' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain('password');
    expect(getPendingCredentialCapture()).toEqual({
      site: 'har-hakesef',
      url: 'https://itur.mof.gov.il',
      step: 'username',
    });
  });

  it('rejects a second setup while one is already pending', async () => {
    await requestCredentialSetup.handler({ site: 'har-hakesef', url: 'https://itur.mof.gov.il' });
    const result = await requestCredentialSetup.handler({ site: 'clal', url: 'https://clal.example' });
    expect(result.isError).toBe(true);
  });

  it('requires site and url', async () => {
    const result = await requestCredentialSetup.handler({});
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 3: Write the MCP tool implementation**

```typescript
// container/agent-runner/src/mcp-tools/bureaucracy-automation.ts
/**
 * Bureaucracy-automation MCP tools.
 *
 * request_credential_setup declares INTENT only — "set up a login for this
 * site" — and never carries a username or password as an argument or a
 * return value. The actual capture happens in poll-loop.ts's
 * handleCredentialCaptureReply, which runs as plain TypeScript in the
 * agent-runner's own poll loop, never as an LLM turn, so the plaintext
 * never enters this process's LLM-facing context at all. See
 * docs/superpowers/plans/2026-09-17-bureaucracy-automation-mvp.md Task 3.
 */
import { execFileSync } from 'node:child_process';

import {
  clearPendingCredentialCapture,
  getPendingCredentialCapture,
  setPendingCredentialCapture,
} from '../db/credential-capture.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/**
 * A `kind: 'chat'` message needs routing (platform_id/channel_type/thread_id)
 * to actually reach the user's chat — unlike the `kind: 'system'` messages
 * self-mod.ts writes, which the host's own delivery dispatch consumes
 * directly and never routes to a channel. Mirrors interactive.ts's `routing()`.
 */
function routing() {
  return getSessionRouting();
}

export const requestCredentialSetup: McpToolDefinition = {
  tool: {
    name: 'request_credential_setup',
    description:
      'Start a one-time login setup for a site so agent-browser can log in on your own later (`agent-browser auth login <site>`) without you ever handling the password. Do NOT pass a username or password here — this tool only starts the flow; the user is asked for both directly and the values never reach you.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        site: { type: 'string', description: 'Short site key, e.g. "har-hakesef" — used as the agent-browser auth vault entry name' },
        url: { type: 'string', description: 'Login page URL' },
      },
      required: ['site', 'url'],
    },
  },
  async handler(args) {
    const site = args.site as string;
    const url = args.url as string;
    if (!site || !url) return err('site and url are required');
    if (getPendingCredentialCapture()) return err('A credential setup is already in progress for this session.');

    setPendingCredentialCapture({ site, url, step: 'username' });
    const r = routing();
    await writeMessageOut({
      id: `cred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ text: `Setting up login for "${site}". What's the username?` }),
    });
    return ok(`Setup started for "${site}". Waiting on the user's reply — you'll get a confirmation once it's saved.`);
  },
};

/**
 * Runs the actual `auth save` once both username and password are captured.
 * `input` carries the password to the child process's stdin — it is never
 * placed in `args`, so it never appears in any logged argv or process list.
 */
function saveCredential(site: string, url: string, username: string, password: string): void {
  execFileSync('agent-browser', ['auth', 'save', site, '--url', url, '--username', username, '--password-stdin'], {
    input: password,
    encoding: 'utf-8',
  });
}

/**
 * Called from poll-loop.ts for every inbound message BEFORE it can become an
 * LLM turn. Returns true (and fully handles the message — writes its own
 * chat confirmation) if a credential capture was in progress; false means
 * "not mine, let it through to the normal message path."
 */
export async function handleCredentialCaptureReply(text: string): Promise<boolean> {
  const pending = getPendingCredentialCapture();
  if (!pending) return false;

  const r = routing();

  if (pending.step === 'username') {
    setPendingCredentialCapture({ site: pending.site, url: pending.url, step: 'password', username: text.trim() });
    await writeMessageOut({
      id: `cred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ text: `Got it. Now the password for "${pending.site}" (I won't see it — it goes straight into agent-browser's vault).` }),
    });
    return true;
  }

  // step === 'password'
  const username = pending.username ?? '';
  try {
    saveCredential(pending.site, pending.url, username, text);
  } catch (e) {
    clearPendingCredentialCapture();
    await writeMessageOut({
      id: `cred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ text: `Couldn't save the credential for "${pending.site}": ${e instanceof Error ? e.message : String(e)}` }),
    });
    return true;
  }
  clearPendingCredentialCapture();
  await writeMessageOut({
    id: `cred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({ text: `Saved. You can now say "log into ${pending.site}" any time — I'll never need to ask for that password again.` }),
  });
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/mcp-tools/bureaucracy-automation.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the poll-loop interception**

In `poll-loop.ts`, inside the `for (const msg of messages)` loop (same one from Step 1), add, alongside the `isClearCommand`/`isUploadTraceCommand` branches:

```typescript
import { handleCredentialCaptureReply } from './mcp-tools/bureaucracy-automation.js';

// ... inside the for loop, after the isUploadTraceCommand branch:
if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && (await handleCredentialCaptureReply(extractText(msg)))) {
  commandIds.push(msg.id);
  continue;
}
```

`extractText(msg)` — check whether `poll-loop.ts` already has a helper that pulls the plain text out of a `chat`/`chat-sdk` message's `content` JSON (it almost certainly does, since `isClearCommand`/`isUploadTraceCommand` must do the same to compare against `/clear`/`/upload-trace`); reuse it rather than writing a second JSON-parsing helper. If no such helper exists, read `isClearCommand`'s implementation and extract its parsing into a small shared function used by both.

- [ ] **Step 6: Register the new MCP tool**

Find where `installPackages`/`addMcpServer` (from `self-mod.ts`) get passed to `registerTools(...)` — grep for `registerTools(` across `container/agent-runner/src/mcp-tools/`. Add `requestCredentialSetup` to the same registration call, importing it from `./bureaucracy-automation.js`.

- [ ] **Step 7: Run the full agent-runner test suite and typecheck**

Run (from `container/agent-runner/`): `bun test`
Expected: all PASS, including the new file and `poll-loop.test.ts` (which may need a small fixture update if it asserts an exhaustive list of interception branches — check before assuming it's unaffected).
Run: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (from repo root)
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add container/agent-runner/src/mcp-tools/bureaucracy-automation.ts container/agent-runner/src/mcp-tools/bureaucracy-automation.test.ts container/agent-runner/src/poll-loop.ts
git commit -m "feat(bureaucracy-automation): credential-setup flow never surfaces passwords to the agent"
```

---

### Task 4: Approval-gated submission bridge

**Files:**
- Create: `src/modules/bureaucracy-automation/guard.ts`
- Create: `src/modules/bureaucracy-automation/request.ts`
- Create: `src/modules/bureaucracy-automation/apply.ts`
- Create: `src/modules/bureaucracy-automation/index.ts`
- Create: `src/modules/bureaucracy-automation/index.test.ts`
- Create: `container/agent-runner/src/mcp-tools/bureaucracy-automation.ts` — MODIFY (Task 3 already created this file; add the new tool to it, don't create a second file)

**Interfaces:**
- Consumes: `registerDeliveryAction`, `DeliveryActionHandler`, `GuardedDeliveryHandler`, `DeliveryGuardSpec` from `../../delivery.js`; `HOLD`, `DENY`, `defineGuardedAction`, `GuardInput` from `../../guard/index.js`; `requestApproval`, `notifyAgent`, `registerApprovalHandler` from `../approvals/index.js`; `reenterGuardedDeliveryAction` from `../../delivery.js`. Read `src/modules/self-mod/{guard,request,apply,index}.ts` in full first — this task mirrors that quartet's file split and wiring exactly, with a single, non-rebuilding action instead of self-mod's two rebuild-capable ones.
- Produces: the `request_submission_approval` MCP tool (container-side, fire-and-forget, mirrors `installPackages` in `self-mod.ts`).

Unlike self-mod, approval here does not mutate any config or rebuild anything — it only tells the agent it may proceed. So `apply.ts`'s handler is a single `notifyAgent` call, and the guard carries no capability gate (compare `selfModInstallPackages`'s `imageBuild` check, which this action does not need).

- [ ] **Step 1: Write the guard**

```typescript
// src/modules/bureaucracy-automation/guard.ts
/**
 * Bureaucracy-automation guard adapter — mirrors src/modules/self-mod/guard.ts's
 * shape exactly, minus the imageBuild capability gate (this action never
 * rebuilds anything — approval only unblocks an in-flight agent-browser
 * action already sitting behind its own `confirm`/`deny` gate).
 */
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';

function bureaucracySubmitDecide(input: GuardInput) {
  if (input.actor.kind !== 'agent') {
    return DENY('bureaucracy_submit is a container-originated action.');
  }
  return HOLD('bureaucracy_submit always requires admin approval from the container path');
}

export const bureaucracySubmit = defineGuardedAction({
  action: 'bureaucracy_automation.submit',
  grantActionName: 'bureaucracy_submit',
  decide: bureaucracySubmitDecide,
});
```

- [ ] **Step 2: Write the request/hold builder**

```typescript
// src/modules/bureaucracy-automation/request.ts
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

export async function validateBureaucracySubmit(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notifyAgent(session, 'bureaucracy_submit failed: agent group not found.');
    return false;
  }
  const actionId = content.actionId as string;
  const summary = content.summary as string;
  if (!actionId || !summary) {
    await notifyAgent(session, 'bureaucracy_submit failed: actionId and summary are required.');
    log.warn('bureaucracy_submit: missing actionId or summary');
    return false;
  }
  return true;
}

export async function requestBureaucracySubmitHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;
  const actionId = content.actionId as string;
  const summary = content.summary as string;
  const site = (content.site as string) || 'unknown site';

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'bureaucracy_submit',
    payload: { actionId, site, summary },
    title: 'Bureaucracy Submission Request',
    question: `Agent "${agentGroup.name}" wants to submit something on ${site}:\n\n${summary}`,
  });
}
```

- [ ] **Step 3: Write the apply handler**

```typescript
// src/modules/bureaucracy-automation/apply.ts
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';

export async function applyBureaucracySubmit(payload: Record<string, unknown>, session: Session): Promise<void> {
  const actionId = payload.actionId as string;
  await notifyAgent(session, `Approved. Run: agent-browser confirm ${actionId}`);
}
```

- [ ] **Step 4: Write the module index**

```typescript
// src/modules/bureaucracy-automation/index.ts
/**
 * Bureaucracy-automation module — admin-approved agent-browser submissions.
 * Mirrors src/modules/self-mod/index.ts's registration shape; see that file
 * for the full rationale of guard-wrapped delivery actions.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { applyBureaucracySubmit } from './apply.js';
import { bureaucracySubmit } from './guard.js';
import { requestBureaucracySubmitHold, validateBureaucracySubmit } from './request.js';

registerDeliveryAction('bureaucracy_submit', applyBureaucracySubmit, {
  guardAction: bureaucracySubmit,
  precheck: validateBureaucracySubmit,
  requestHold: requestBureaucracySubmitHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `bureaucracy_submit denied: ${reason}`),
});

registerApprovalHandler('bureaucracy_submit', reenterGuardedDeliveryAction('bureaucracy_submit'));
```

- [ ] **Step 5: Write the module test**

Read `src/modules/self-mod/guard.test.ts` first and mirror its shape (it's the exact same kind of module). At minimum:

```typescript
// src/modules/bureaucracy-automation/index.test.ts
import { describe, expect, it } from 'vitest';

import { bureaucracySubmit } from './guard.js';

describe('bureaucracySubmit guard', () => {
  it('holds for a container-originated request', () => {
    const decision = bureaucracySubmit.decide({ actor: { kind: 'agent' } } as never);
    expect(decision.kind).toBe('hold');
  });

  it('denies a non-agent actor', () => {
    const decision = bureaucracySubmit.decide({ actor: { kind: 'operator' } } as never);
    expect(decision.kind).toBe('deny');
  });
});
```

Adjust the `GuardInput`/decision shape to match what `src/guard/index.ts` actually exports if it differs from this sketch — read that file before finalizing this test.

- [ ] **Step 6: Register the module at host startup**

Find where `src/modules/self-mod/index.ts` gets imported for its registration side-effects (grep `modules/self-mod` across `src/`) and add the same import for `./modules/bureaucracy-automation/index.js` alongside it.

- [ ] **Step 7: Add the container-side `request_submission_approval` MCP tool**

Append to `container/agent-runner/src/mcp-tools/bureaucracy-automation.ts` (the file Task 3 created):

```typescript
export const requestSubmissionApproval: McpToolDefinition = {
  tool: {
    name: 'request_submission_approval',
    description:
      'Ask an admin to approve a pending agent-browser action before it submits anything (a form, a claim, a payment). Fire-and-forget — you will get a chat message telling you to run `agent-browser confirm <actionId>` once approved, or that it was denied. NEVER call `agent-browser confirm` on a submission-shaped action without this approval first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        actionId: { type: 'string', description: 'The pending action id agent-browser reported (from its confirm/deny gate)' },
        site: { type: 'string', description: 'Which site this is for' },
        summary: { type: 'string', description: 'Human-readable summary of exactly what will be submitted — every field and value you filled, in plain language' },
      },
      required: ['actionId', 'site', 'summary'],
    },
  },
  async handler(args) {
    const actionId = args.actionId as string;
    const site = args.site as string;
    const summary = args.summary as string;
    if (!actionId || !site || !summary) return err('actionId, site, and summary are required');

    await writeMessageOut({
      id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({ action: 'bureaucracy_submit', actionId, site, summary }),
    });
    return ok('Submitted for admin approval. You will be notified when approved or denied.');
  },
};
```

Add it to the same `registerTools(...)` call from Task 3 Step 6.

- [ ] **Step 8: Run tests and typecheck**

Run: `node_modules/.bin/vitest run src/modules/bureaucracy-automation/index.test.ts`
Run (from `container/agent-runner/`): `bun test src/mcp-tools/bureaucracy-automation.test.ts`
Run: `node_modules/.bin/tsc --noEmit -p tsconfig.json` and `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: all PASS, no errors.

- [ ] **Step 9: Commit**

```bash
git add src/modules/bureaucracy-automation/ container/agent-runner/src/mcp-tools/bureaucracy-automation.ts
git commit -m "feat(bureaucracy-automation): approval-gate agent-browser submissions"
```

---

### Task 5: Teach the agent the workflow (container skill)

**Files:**
- Create: `container/skills/agent-browser/bureaucracy-automation.md` (a reference doc alongside `SKILL.md`, following the same pattern as `container/skills/agent-browser`'s existing `references/authentication.md` etc.)
- Modify: `container/skills/agent-browser/SKILL.md` (add one short pointer section to the new reference doc, same pattern as the existing "See references/authentication.md" style links)

**Interfaces:**
- Consumes: nothing new — this is instructional content only, no code.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Read the existing SKILL.md structure**

Open `container/skills/agent-browser/SKILL.md` in full and note exactly how it links to its `references/*.md` files, so the new doc matches the existing house style (heading levels, link format).

- [ ] **Step 2: Write the reference doc**

```markdown
# Bureaucracy automation (this install's extensions)

Beyond agent-browser's own auth vault and session persistence (see
references/authentication.md), this install adds three things:

## Setting up a new site

Never construct `agent-browser auth save ... --password-stdin` yourself —
you would end up typing the password into your own tool call. Instead call
the `request_credential_setup` tool with just the site key and login URL.
The user is asked for the username and password directly by the host; you
get back only a confirmation once it's saved. After that, log in any time
with `agent-browser auth login <site>` — you never handle the password.

## Two-factor / SMS / biometric codes

These are different from the vault: they're single-use and expire in
minutes, so there's no harm in you seeing one. After `auth login`, if the
page shows a code challenge (read it with `snapshot`, don't guess), just
ask the user for the code in a normal chat message and end your turn — the
browser session stays alive while you wait (this container and
agent-browser's own daemon persist independently of any single turn). When
the reply arrives, `agent-browser fill @ref "<code>"` and continue.

## Submitting anything

Before clicking submit on a claim, application, payment, or any other
action that commits something on the user's behalf, call
`request_submission_approval` with the pending action's id and a plain-
language summary of every field and value you're about to submit. Wait for
the chat confirmation telling you it was approved (or denied) before doing
anything else — never click submit, and never call `agent-browser confirm`
on your own judgment.
```

- [ ] **Step 3: Add the pointer in SKILL.md**

Add a short section (matching the existing reference-link style you read in Step 1) pointing to `bureaucracy-automation.md`, placed near the existing authentication section since it extends that topic.

- [ ] **Step 4: Commit**

```bash
git add container/skills/agent-browser/bureaucracy-automation.md container/skills/agent-browser/SKILL.md
git commit -m "docs(bureaucracy-automation): teach the agent the credential-setup, OTP, and approval workflow"
```

---

### Task 6: Deploy and verify live against Har HaKesef

**Files:** none (deployment + manual verification only).

**Interfaces:** Consumes everything from Tasks 1–5, already deployed.

This task follows the same live-verification discipline used earlier this session for the direct-browser-egress feature: real deploy, real container, real site, read evidence rather than assume success.

- [ ] **Step 1: Deploy**

Follow the Global Constraints deploy procedure exactly (including `./container/build.sh`, required this time). After `launchctl kickstart`, confirm via `tail -20 ~/nanoclaw/logs/nanoclaw.log` that the service started cleanly (no new migration — this plan added no central-DB migration — and no startup errors).

- [ ] **Step 2: Set up the Har HaKesef credential**

Via Telegram to Gromit: ask it to set up Har HaKesef (triggers `request_credential_setup`). Provide the real username/password when asked. Confirm via `docker exec <container> sh -c 'ls -la /home/node/.agent-browser'` (read-only inspection) that a vault entry now exists, and confirm via the chat transcript (`sqlite3 outbound.db 'select content from messages_out order by seq desc limit 10;'` on the real session, same technique used earlier this session) that no message anywhere in that exchange contains the raw password.

- [ ] **Step 3: Verify session persistence**

Ask Gromit to check Har HaKesef status (triggers `auth login` + whatever the 2FA relay turns out to need live — be ready to relay a real SMS/biometric code through chat). Confirm success, then restart the container (`ncl groups restart --id ag-1788707397091-apedp4`) and ask again — this second check should NOT re-prompt for the OTP, confirming the persisted `~/.agent-browser` mount survived the restart.

- [ ] **Step 4: Confirm no stray artifacts**

Check `docker network ls` / `docker ps -a` on the Mac for anything this task's manual testing left running, and clean up any throwaway container/network the same way the direct-browser-egress work's leftovers were cleaned up earlier this session.

- [ ] **Step 5: Report**

Summarize what worked, what (if anything) needed live adjustment from the plan's assumptions (the 2FA relay path in particular has no automated test — this is its first real exercise), and hand off to `superpowers:finishing-a-development-branch`.
