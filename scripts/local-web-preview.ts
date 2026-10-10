/** Isolated browser fixture for the local-web UI. Never touches the checkout's data/ or groups/. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requestedRoot = process.env.NANOCLAW_LOCAL_WEB_PREVIEW_ROOT?.trim();
const previewRoot = requestedRoot
  ? path.resolve(requestedRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-local-web-preview-'));
const isFresh = !fs.existsSync(path.join(previewRoot, 'data', 'v2.db'));
const port = Number(process.env.NANOCLAW_LOCAL_WEB_PORT ?? 3219);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid NANOCLAW_LOCAL_WEB_PORT');

fs.mkdirSync(path.join(previewRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(previewRoot, 'data'), { recursive: true });
if (!fs.existsSync(path.join(previewRoot, 'src', 'channels'))) {
  fs.symlinkSync(path.join(projectRoot, 'src', 'channels'), path.join(previewRoot, 'src', 'channels'));
}
if (!fs.existsSync(path.join(previewRoot, 'container'))) {
  fs.symlinkSync(path.join(projectRoot, 'container'), path.join(previewRoot, 'container'));
}
process.chdir(previewRoot);
process.env.NANOCLAW_LOCAL_WEB_PORT = String(port);

await import('../src/mailbox/compose.js');
await import('../src/cli/resources/groups.js');
await import('../src/cli/resources/messaging-groups.js');
await import('../src/cli/resources/wirings.js');
await import('../src/providers/index.js');
const { createAgentGroup } = await import('../src/db/agent-groups.js');
const { initDb } = await import('../src/db/connection.js');
const { createMessagingGroup, createMessagingGroupAgent } = await import('../src/db/messaging-groups.js');
const { runMigrations } = await import('../src/db/migrations/index.js');
const { initGroupFilesystem } = await import('../src/group-init.js');
const registry = await import('../src/channels/channel-registry.js');
const { readOrCreateToken } = await import('../src/channels/local-web.js');

await runMigrations(await initDb(path.join(previewRoot, 'data', 'v2.db')));
if (isFresh) {
  const now = new Date().toISOString();
  for (const group of [
    { id: 'ag-preview-claude', name: 'Claude Base', folder: 'claude-base' },
    { id: 'ag-preview-writer', name: 'Writer', folder: 'writer' },
  ]) {
    await createAgentGroup({ ...group, agent_provider: null, created_at: now });
    await initGroupFilesystem({ ...group, agent_provider: null, created_at: now });
  }
  await createMessagingGroup({
    id: 'mg-preview-claude',
    channel_type: 'local-web',
    platform_id: 'local-web:local',
    name: 'Claude Base',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now,
  });
  await createMessagingGroupAgent({
    id: 'mga-preview-claude',
    messaging_group_id: 'mg-preview-claude',
    agent_group_id: 'ag-preview-claude',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
}

await registry.initChannelAdapters(() => ({
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
}));

const token = readOrCreateToken();
process.stdout.write(`PREVIEW_ROOT=${previewRoot}\n`);
process.stdout.write(`PREVIEW_URL=http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}\n`);

async function shutdown(): Promise<void> {
  await registry.teardownChannelAdapters();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await new Promise(() => {});
