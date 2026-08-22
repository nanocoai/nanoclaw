/**
 * Away Mode sessions — one row per Away Mode activation. See
 * away-mode/POLICY.md for what Away Mode is and how authority levels work.
 *
 * Host-operated infrastructure: every operation below is `hostOnly: true`,
 * which src/cli/guard.ts rejects for ANY agent caller regardless of
 * `cli_scope` -- including `global` (Pepper's own scope today). This is
 * deliberate and load-bearing: `cli_scope: 'group'`'s GROUP_SCOPE_RESOURCES
 * allowlist (src/cli/registry.ts) only gates `group`-scoped agents, so
 * relying on it alone would leave any `global`-scoped agent free to read or
 * mutate these tables directly -- including forging a Kirk answer onto
 * `kirk_questions`, granting itself Level-B deployment authority via
 * `deployment_allowlist`, or reactivating a STOPPED session. Only the host
 * CLI (Claude Code / Kirk, over the trusted Unix socket) can reach this.
 * Extending agent access is a deliberate future decision, never an accident
 * of this resource's `access` value.
 *
 * Ported verbatim from old commit 0fb28c04 -- the OperationSpec/hostOnly
 * mechanism this depends on landed standalone in 4d39c31d.
 */
import { registerResource } from '../crud.js';

registerResource({
  name: 'away-mode-session',
  plural: 'away-mode-sessions',
  table: 'away_mode_sessions',
  description:
    'Away Mode activation — start/stop record, authority level, and standing deployment allowlist for one Away Mode run.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Auto-generated.', generated: true },
    { name: 'started_at', type: 'string', description: 'Auto-set.', generated: true },
    { name: 'stopped_at', type: 'string', description: 'Set when Away Mode stops.', updatable: true },
    {
      name: 'authority_level',
      type: 'string',
      description: 'Default authority level for queue items in this activation.',
      enum: ['A', 'B', 'C'],
      default: 'A',
    },
    {
      name: 'special_instructions',
      type: 'string',
      description: "Kirk's instructions for this activation, verbatim.",
      default: '',
    },
    {
      name: 'production_exclusions',
      type: 'string',
      description: 'Explicit statement of what must not be touched this activation.',
      default: '',
    },
    {
      name: 'deployment_allowlist',
      type: 'json',
      description:
        'JSON array of deployment-class changes pre-authorized without asking (Level B). Starts empty — everything marks READY FOR KIRK REVIEW until Kirk deliberately expands this.',
      default: '[]',
      updatable: true,
    },
    {
      name: 'status',
      type: 'string',
      description: 'ACTIVE while running; STOPPED once ended.',
      enum: ['ACTIVE', 'STOPPED'],
      default: 'ACTIVE',
      updatable: true,
    },
  ],
  operations: {
    list: { access: 'open', hostOnly: true },
    get: { access: 'open', hostOnly: true },
    create: { access: 'open', hostOnly: true },
    update: { access: 'open', hostOnly: true },
  },
});
