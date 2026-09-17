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
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `cred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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
        site: {
          type: 'string',
          description: 'Short site key, e.g. "har-hakesef" — used as the agent-browser auth vault entry name',
        },
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
      id: generateId(),
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
 * This is the load-bearing security property: do not change it to pass the
 * password as a CLI argument, even for testing convenience.
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
      id: generateId(),
      kind: 'chat',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        text: `Got it. Now the password for "${pending.site}" (I won't see it — it goes straight into agent-browser's vault).`,
      }),
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
      id: generateId(),
      kind: 'chat',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        text: `Couldn't save the credential for "${pending.site}": ${e instanceof Error ? e.message : String(e)}`,
      }),
    });
    return true;
  }
  clearPendingCredentialCapture();
  await writeMessageOut({
    id: generateId(),
    kind: 'chat',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({
      text: `Saved. You can now say "log into ${pending.site}" any time — I'll never need to ask for that password again.`,
    }),
  });
  return true;
}

export const requestSubmissionApproval: McpToolDefinition = {
  tool: {
    name: 'request_submission_approval',
    description:
      'Ask an admin to approve a pending agent-browser action before it submits anything (a form, a claim, a payment). Fire-and-forget — you will get a chat message telling you to run `agent-browser confirm <actionId>` once approved, or that it was denied. NEVER call `agent-browser confirm` on a submission-shaped action without this approval first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        actionId: {
          type: 'string',
          description: 'The pending action id agent-browser reported (from its confirm/deny gate)',
        },
        site: { type: 'string', description: 'Which site this is for' },
        summary: {
          type: 'string',
          description:
            'Human-readable summary of exactly what will be submitted — every field and value you filled, in plain language',
        },
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

registerTools([requestCredentialSetup, requestSubmissionApproval]);
