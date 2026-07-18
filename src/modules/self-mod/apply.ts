/**
 * Approval handlers for self-modification actions.
 *
 * The approvals module calls these when an admin clicks Approve on a
 * pending_approvals row whose action matches. Each handler mutates the
 * container config, rebuilds/kills the container as needed, and lets the
 * host sweep respawn it on the new image on the next message.
 *
 * install_packages: rebuild image + kill container (apt/npm global installs
 *   must be baked into the image layer).
 * add_mcp_server: kill container only — bun runs TS directly, so a pure
 *   MCP wiring change needs nothing more than a process restart.
 */
import fs from 'fs';
import path from 'path';
import { updateContainerConfig } from '../../container-config.js';
import { buildAgentGroupImage, killContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { writeSessionMessage, sessionDir } from '../../session-manager.js';
import type { ApprovalHandler } from '../approvals/index.js';

export const applyInstallPackages: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('install_packages approved but agent group missing.');
    return;
  }
  updateContainerConfig(agentGroup.folder, (cfg) => {
    if (payload.apt) cfg.packages.apt.push(...(payload.apt as string[]));
    if (payload.npm) cfg.packages.npm.push(...(payload.npm as string[]));
  });

  const pkgs = [
    ...((payload.apt as string[] | undefined) || []),
    ...((payload.npm as string[] | undefined) || []),
  ].join(', ');
  log.info('Package install approved', { agentGroupId: session.agent_group_id, userId });
  try {
    await buildAgentGroupImage(session.agent_group_id);
    killContainer(session.id, 'rebuild applied');
    // Schedule a follow-up prompt a few seconds after kill so the host sweep
    // respawns the container on the new image and the agent verifies + reports.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
        sender: 'system',
        senderId: 'system',
      }),
      processAfter: new Date(Date.now() + 5000)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, ''),
    });
    log.info('Container rebuild completed (bundled with install)', { agentGroupId: session.agent_group_id });
  } catch (e) {
    notify(
      `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Tell the user — an admin will need to retry the install_packages request or inspect the build logs.`,
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId: session.agent_group_id, err: e });
  }
};

export const applyAddMcpServer: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('add_mcp_server approved but agent group missing.');
    return;
  }
  updateContainerConfig(agentGroup.folder, (cfg) => {
    cfg.mcpServers[payload.name as string] = {
      command: payload.command as string,
      args: (payload.args as string[]) || [],
      env: (payload.env as Record<string, string>) || {},
    };
  });

  killContainer(session.id, 'mcp server added');
  notify(`MCP server "${payload.name}" added. Your container will restart with it on the next message.`);
  log.info('MCP server add approved', { agentGroupId: session.agent_group_id, userId });
};

export const applyChangeModel: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notify('change_model approved but agent group missing.');
    return;
  }

  const model = payload.model as string;
  updateContainerConfig(agentGroup.folder, (cfg) => {
    cfg.model = model;
  });

  // Clear the OpenCode XDG session DB so the next container starts a fresh
  // session using the new model instead of resuming the old one.
  const xdgOpencode = path.join(sessionDir(session.agent_group_id, session.id), 'opencode-xdg', 'opencode');
  try {
    fs.rmSync(xdgOpencode, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // Also clear the stored OpenCode session ID (continuation) in outbound.db
  // so the next container starts a fresh session, not the now-invalid one.
  const outboundPath = path.join(sessionDir(session.agent_group_id, session.id), 'outbound.db');
  if (fs.existsSync(outboundPath)) {
    try {
      const Database = (await import('better-sqlite3')).default;
      const outDb = new Database(outboundPath);
      outDb.prepare('DELETE FROM session_state').run();
      outDb.close();
    } catch {
      /* ignore */
    }
  }

  killContainer(session.id, 'model changed');
  log.info('Model change approved', { agentGroupId: session.agent_group_id, model, userId });
};
