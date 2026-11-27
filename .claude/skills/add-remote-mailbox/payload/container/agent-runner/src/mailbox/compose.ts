/** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
import { registerAgentMailbox } from './index.js';
import { RemoteAgentMailbox } from './remote/index.js';
import { SqliteAgentMailbox } from './sqlite/index.js';
import type { AgentMailbox } from './types.js';

/** Remote (HTTP) mailbox when NANOCLAW_MAILBOX_URL is set, SQLite otherwise. */
export function createComposedMailbox(env: NodeJS.ProcessEnv = process.env): AgentMailbox {
  const url = env.NANOCLAW_MAILBOX_URL;
  if (!url) return new SqliteAgentMailbox();
  const token = env.NANOCLAW_MAILBOX_TOKEN;
  if (!token) throw new Error('NANOCLAW_MAILBOX_URL is set but NANOCLAW_MAILBOX_TOKEN is missing');
  return new RemoteAgentMailbox({ url, token, session: env.NANOCLAW_MAILBOX_SESSION });
}

registerAgentMailbox(() => createComposedMailbox());
