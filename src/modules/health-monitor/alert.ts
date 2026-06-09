import https from 'https';

import { getDb } from '../../db/connection.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';

export const HEALTH_MONITOR_AGENT_ID = 'health-monitor';
const HEALTH_MONITOR_MG_ID = 'mg-health-monitor';

export async function postAlert(message: string): Promise<void> {
  const env = readEnvFile(['DISCORD_BOT_TOKEN', 'HEALTH_MONITOR_KEEPALIVE_CHANNEL_ID']);
  if (!env.DISCORD_BOT_TOKEN) {
    log.warn('[health-monitor] No DISCORD_BOT_TOKEN — cannot post alert', { message });
    return;
  }
  if (!env.HEALTH_MONITOR_KEEPALIVE_CHANNEL_ID) {
    log.warn('[health-monitor] No HEALTH_MONITOR_KEEPALIVE_CHANNEL_ID — cannot post alert', { message });
    return;
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({ content: message });
    const req = https.request(
      {
        hostname: 'discord.com',
        path: `/api/v10/channels/${env.HEALTH_MONITOR_KEEPALIVE_CHANNEL_ID}/messages`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          log.warn('[health-monitor] Discord alert HTTP error', { status: res.statusCode });
        }
        resolve();
      },
    );
    req.on('error', (err) => {
      log.warn('[health-monitor] Discord alert network error', { err });
      resolve();
    });
    req.write(body);
    req.end();
  });
}

export async function injectTask(prompt: string): Promise<void> {
  try {
    const agentGroup = getDb().prepare('SELECT id FROM agent_groups WHERE id = ?').get(HEALTH_MONITOR_AGENT_ID) as
      | { id: string }
      | undefined;

    if (!agentGroup) {
      log.warn('[health-monitor] Agent group not in DB — skipping task injection');
      return;
    }

    const { session } = resolveSession(HEALTH_MONITOR_AGENT_ID, HEALTH_MONITOR_MG_ID, null, 'shared');
    const messageId = `hm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    writeSessionMessage(HEALTH_MONITOR_AGENT_ID, session.id, {
      id: messageId,
      kind: 'task',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ prompt }),
    });

    await wakeContainer(session);
    log.info('[health-monitor] Task injected', { sessionId: session.id });
  } catch (err) {
    log.error('[health-monitor] Failed to inject task', { err });
  }
}
