/**
 * Host-side container config for the `pi` provider.
 *
 * pi (Pi Coding Agent) resolves models and credentials exclusively from its
 * agentDir files (auth.json / models.json / settings.json) — its SDK reads no
 * environment variables for auth. Setup seeds those files into a per-session
 * host directory which is mounted at /pi-agent; the container-side provider
 * (container/agent-runner/src/providers/pi.ts) picks it up via PI_AGENT_DIR
 * and passes it to createAgentSession as `agentDir`.
 *
 * Seeding: on first spawn of a session, auth.json / models.json /
 * settings.json are copied once from a host template directory (default
 * ~/.pi/agent, override with PI_TEMPLATE_AGENT_DIR). Per-session copies mean
 * credential rotation is a host-side file edit followed by deleting the
 * session's pi-agent dir — no image rebuild, and existing sessions pick up
 * the new files on next spawn.
 *
 * Session transcripts are NOT stored here — the container-side provider
 * keeps them under the RW workspace (.pi/sessions), so removing this
 * directory never loses conversation history.
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

const CONTAINER_PI_AGENT_DIR = '/pi-agent';
const SEEDED_FILES = ['auth.json', 'models.json', 'settings.json'] as const;

function seedFromTemplate(piAgentDir: string, hostEnv: NodeJS.ProcessEnv): void {
  const templateDir =
    hostEnv.PI_TEMPLATE_AGENT_DIR ?? path.join(process.env.HOME ?? '', '.pi', 'agent');
  for (const file of SEEDED_FILES) {
    const src = path.join(templateDir, file);
    const dst = path.join(piAgentDir, file);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.copyFileSync(src, dst);
      } catch (err) {
        // A failed seed must not kill the spawn — pi will surface a clear
        // auth error to the user if the files end up missing.
        console.error(`[pi-provider-host] failed to seed ${file}: ${String(err)}`);
      }
    }
  }
}

registerProviderContainerConfig('pi', (ctx) => {
  const piAgentDir = path.join(ctx.sessionDir, 'pi-agent');
  fs.mkdirSync(piAgentDir, { recursive: true });
  seedFromTemplate(piAgentDir, ctx.hostEnv);

  return {
    mounts: [{ hostPath: piAgentDir, containerPath: CONTAINER_PI_AGENT_DIR, readonly: false }],
    env: { PI_AGENT_DIR: CONTAINER_PI_AGENT_DIR },
  };
});
