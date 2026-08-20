/**
 * Install-shape guard for `/add-ollama-tool`. Runs with `pnpm run test:skills`
 * (see vitest.skills.config.ts) and asserts the *applied* state, so it is
 * expected to fail on a checkout where the skill has not been applied.
 *
 * The skill installs one file into the container tree and one row of per-group
 * config; it edits no trunk source. Everything below is a way that could break
 * without any test going red:
 *
 *  - the container path the skill's `--args` names stops matching the trunk
 *    mount, so `bun run /app/src/ollama-mcp-stdio.ts` is a missing file and the
 *    MCP server dies on spawn with nothing in the transcript;
 *  - `ncl groups config add-mcp-server` tightens validation and rejects the
 *    documented payload;
 *  - the stored entry is rewritten on the way to container.json and loses its
 *    args (which carry the daemon URL);
 *  - somebody "fixes" the skill by patching agent-runner's index.ts again,
 *    reintroducing install-wide registration and a merge conflict surface.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, test } from 'vitest';

import { parseMcpServerConfig, sanitizeStoredMcpServers } from '../../../src/container-config.js';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SKILL_DIR, '../../..');

/** The single container path the skill documents in its `--args`. */
const SERVER_CONTAINER_PATH = '/app/src/ollama-mcp-stdio.ts';
const SERVER_HOST_PATH = path.join(ROOT, 'container', 'agent-runner', 'src', 'ollama-mcp-stdio.ts');

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('installed payload', () => {
  test('the MCP server is in the container tree', () => {
    expect(fs.existsSync(SERVER_HOST_PATH)).toBe(true);
  });

  test('its behavior test came along — the config seam is covered', () => {
    expect(
      fs.existsSync(path.join(ROOT, 'container', 'agent-runner', 'src', 'ollama-mcp-stdio.test.ts')),
    ).toBe(true);
  });
});

describe('container path', () => {
  test('the documented path resolves inside the read-only agent-runner mount', () => {
    const runner = read('src/container-runner.ts');
    // composeSessionSpec mounts container/agent-runner/src at /app/src.
    expect(runner).toContain("path.join(projectRoot, 'container', 'agent-runner', 'src')");
    expect(runner).toContain("containerPath: '/app/src'");

    const rel = path.posix.relative('/app/src', SERVER_CONTAINER_PATH);
    expect(rel).toBe('ollama-mcp-stdio.ts');
    expect(fs.existsSync(SERVER_HOST_PATH)).toBe(true);
  });
});

describe('per-group MCP entry', () => {
  const documented = {
    command: 'bun',
    args: ['run', SERVER_CONTAINER_PATH, '--host', 'http://host.docker.internal:11434', '--admin-tools'],
  };

  test('ncl groups config add-mcp-server accepts the documented payload', () => {
    // Same parse the CLI verb and the approval replay both run.
    expect(parseMcpServerConfig(documented)).toEqual({
      command: 'bun',
      args: documented.args,
      env: {},
    });
  });

  test('the stored entry survives materialization with its args intact', () => {
    const stored = sanitizeStoredMcpServers({ ollama: parseMcpServerConfig(documented) }, 'test-group');
    expect(stored.ollama).toBeDefined();
    expect(stored.ollama).toMatchObject({ command: 'bun', args: documented.args });
  });
});

describe('documented network limitation still holds', () => {
  // The skill's Prerequisites tell the operator that a host-local daemon is
  // unreachable under egress lockdown, and why. If trunk ever stops aliasing
  // host.docker.internal to the gateway, or starts adding the host-gateway
  // mapping on the locked-down network too, that warning becomes wrong — which
  // is worse than silence, because it is the reason an operator turns the
  // feature down.
  test('lockdown replaces the host-gateway route with an internal network', () => {
    const drivers = read('src/drivers/index.ts');
    expect(drivers).toContain('--add-host=host.docker.internal:host-gateway');
    // The host-gateway mapping is the else-branch of the lockdown check.
    expect(drivers).toMatch(/ensureEgressNetwork\(\)[\s\S]{0,400}return egressNetworkArgs\(\)/);
  });

  test('on that network host.docker.internal is the OneCLI gateway', () => {
    const lockdown = read('src/egress-lockdown.ts');
    expect(lockdown).toContain("'network', 'create', '--internal'");
    expect(lockdown).toContain("'--alias', 'host.docker.internal'");
  });
});

describe('no trunk-source edits', () => {
  const skillMd = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');
  const removeMd = fs.readFileSync(path.join(SKILL_DIR, 'REMOVE.md'), 'utf-8');

  test('the skill registers per group, never by patching agent-runner', () => {
    // The old shape hardcoded an `ollama` entry into the shared mcpServers
    // literal, giving every group in the install the tools unconditionally.
    expect(skillMd).not.toMatch(/agent-runner\/src\/index\.ts/);
    expect(read('container/agent-runner/src/index.ts')).not.toMatch(/ollama/i);
  });

  test('the daemon URL travels in the MCP entry, not through host env plumbing', () => {
    expect(skillMd).not.toMatch(/ollamaEnv/);
    expect(fs.existsSync(path.join(ROOT, 'src', 'ollama-env.ts'))).toBe(false);
    expect(read('src/container-runner.ts')).not.toMatch(/ollama/i);
  });

  test('removal is per-group config plus one file — no rebuild, no source revert', () => {
    expect(removeMd).toContain('remove-mcp-server');
    // The file is mounted, so neither install nor removal rebuilds the image.
    expect(removeMd).not.toMatch(/container\/build\.sh/);
    expect(skillMd).not.toMatch(/container\/build\.sh/);
  });
});
