/**
 * `ncl fallback status|force|return` — operator-only CLI mirror of the
 * `/fallback` chat command (commands.ts). Not in dispatch.ts's group-scope
 * whitelist, so a group-scoped agent can never reach it; a global-scoped
 * (owner) agent can, same as every other unrestricted resource.
 */
import { registerResource } from '../../cli/crud.js';
import { enterFallback, exitFallback } from './controller.js';
import { getFallbackState } from './db.js';
import { statusNotice } from './notices.js';
import { getActiveSessions } from '../../db/sessions.js';
import { log } from '../../log.js';

registerResource({
  name: 'fallback',
  plural: 'fallback',
  table: 'fallback_state',
  description:
    'Install-wide LLM fallback state — single global row. Switches the whole install to the backup provider when the native one (Claude) exhausts limits, and back. See `/fallback` for the chat-side equivalent.',
  idColumn: 'id',
  columns: [
    { name: 'active', type: 'boolean', description: 'Whether the install is currently on the backup provider.' },
    {
      name: 'mode',
      type: 'string',
      description: '"auto" auto-returns when limits reset; "forced" only via `fallback return`.',
      enum: ['auto', 'forced'],
    },
    {
      name: 'classification',
      type: 'string',
      description: 'Why fallback triggered.',
      enum: ['quota', 'billing', 'overload', 'timeout', 'manual'],
    },
    {
      name: 'backup_provider',
      type: 'string',
      description: 'Provider name currently overriding native (e.g. "opencode").',
    },
  ],
  operations: {},
  customOperations: {
    status: {
      access: 'open',
      description: 'Show current fallback state (active provider, mode, reason, next retry).',
      handler: async () => {
        const state = getFallbackState();
        return { ...state, summary: statusNotice(state) };
      },
    },
    force: {
      access: 'approval',
      description:
        'Force the install onto the backup provider now. Never auto-returns — only `fallback return` exits it.',
      handler: async () => {
        const sessions = getActiveSessions();
        const originSession = sessions[0];
        await enterFallback({
          mode: 'forced',
          classification: 'manual',
          reason: 'manual ncl fallback force',
          resetAt: null,
          originSessionId: originSession?.id ?? null,
          originGroupId: originSession?.agent_group_id ?? null,
        });
        return getFallbackState();
      },
    },
    return: {
      access: 'approval',
      description: 'Return the install to the native provider now, regardless of whether it has actually recovered.',
      handler: async () => {
        const before = getFallbackState();
        if (!before.active) return before;
        exitFallback({ via: 'manual' });
        return getFallbackState();
      },
    },
  },
});
