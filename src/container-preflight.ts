import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { configFromDb } from './container-config.js';
import { CONTAINER_RUNTIME_BIN, removeContainer, stopContainer } from './container-runtime.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { sessionDir } from './session-manager.js';
import { buildContainerArgs, buildMounts, resolveProviderName } from './container-runner.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';
import type { ContainerConfigRow } from './types.js';

export interface ConfigPreflightResult {
  providerOutput: string;
  exitCode: number;
}

/** Run a candidate config in an ephemeral container before persisting it. */
export async function preflightContainerConfig(
  agentGroupId: string,
  candidateRow: ContainerConfigRow,
): Promise<ConfigPreflightResult> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error(`Agent group not found: ${agentGroupId}`);

  const token = `preflight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const root = path.join(DATA_DIR, token);
  const groupDir = path.join(root, 'agent');
  const sessDir = sessionDir(token, token);
  const containerName = `nanoclaw-${token}`;

  try {
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(sessDir, { recursive: true });

    const ephemeralGroup = { ...agentGroup, id: token, folder: path.relative(GROUPS_DIR, groupDir) };
    const ephemeralSession = {
      id: token,
      agent_group_id: token,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active' as const,
      container_status: 'stopped' as const,
      last_active: null,
      created_at: new Date().toISOString(),
    };
    const candidate = configFromDb(candidateRow, ephemeralGroup);
    // Scalar updates do not need to start unrelated MCP servers or mount
    // existing host paths during validation.
    candidate.mcpServers = {};
    candidate.additionalMounts = [];
    fs.writeFileSync(path.join(groupDir, 'container.json'), JSON.stringify(candidate, null, 2) + '\n');

    const provider = resolveProviderName(ephemeralSession.agent_provider, candidate.provider);
    const contribution =
      getProviderContainerConfig(provider)?.({
        sessionDir: sessDir,
        agentGroupId: token,
        groupDir,
        selectedSkills: [],
        hostEnv: process.env,
      }) ?? {};
    const mounts = buildMounts(ephemeralGroup, ephemeralSession, candidate, provider, contribution);
    const args = await buildContainerArgs(
      mounts,
      containerName,
      ephemeralGroup,
      candidate,
      provider,
      contribution,
      agentGroup.id,
      'exec bun run /app/src/preflight.ts',
    );

    const child = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const appendOutput = (chunks: string[], data: Buffer): void => {
      const remaining = 64 * 1024 - chunks.join('').length;
      if (remaining > 0) chunks.push(data.toString('utf8', 0, remaining));
    };
    child.stdout?.on('data', (data) => appendOutput(stdout, data));
    child.stderr?.on('data', (data) => appendOutput(stderr, data));

    const exitCode = await new Promise<number>((resolve, reject) => {
      let timedOut = false;
      const timeoutError = new Error(`preflight container timed out after 120s\n${stderr.join('')}`);
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          stopContainer(containerName);
        } catch {
          try {
            removeContainer(containerName);
          } catch {
            /* the container may already have exited */
          }
        }
        child.kill('SIGKILL');
      }, 120_000);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (timedOut) reject(timeoutError);
        else resolve(code ?? 1);
      });
    });
    const providerOutput = `${stdout.join('')}${stderr.join('')}`.trim();
    if (exitCode !== 0)
      throw new Error(`preflight container exited with code ${exitCode}: ${providerOutput || 'no output'}`);
    return { providerOutput, exitCode };
  } finally {
    for (const tempPath of [root, sessDir, path.dirname(sessDir)]) {
      try {
        fs.rmSync(tempPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        log.warn('Could not immediately remove preflight path', {
          path: tempPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      fs.rmdirSync(path.dirname(path.dirname(sessDir)));
    } catch {
      /* shared session root is retained when it contains other sessions */
    }
  }
}
