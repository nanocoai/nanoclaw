/**
 * `ncl templates` — the host-owned template library over the wire.
 *
 * Two libraries answer here. `templates/` on disk is the local dev library
 * (`TEMPLATES_DIR`); `agent_templates` in the central database is the stored
 * library, which is what a stateless Host actually provisions from. `list` and
 * `get` read both. `put` and `rm` write the stored one only — the folder is
 * never runtime-mutable, and that is upstream's rule, not ours.
 *
 *   list                  — browse summaries, each marked local|stored
 *   get  --name           — full detail: digest, policy, MCP catalog, skills
 *   put  --name --from-dir <dir> [--source S] [--dry-run]
 *                         — pack a directory the CLIENT can see and store it;
 *                           idempotent by digest. `--bundle-stdin` takes a
 *                           pre-packed bundle instead.
 *   rm   --name           — remove a stored template (a local one is a file
 *                           the operator deletes, not a verb)
 *
 * `put` carries the whole template: every file, text or base64. The host
 * validates it parses through the production plugin reader and that the
 * declared plugin name matches before any row is written.
 */
import { listTemplates, templateDetail } from '../../templates/registry.js';
import { parseBundle } from '../../templates/bundle.js';
import { deleteStoredTemplate, putTemplate } from '../../templates/store.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'template',
  plural: 'templates',
  // Custom verbs only: `list`/`get` span two libraries and `put` validates a
  // bundle, none of which the generic CRUD over one table expresses.
  table: '',
  description: 'Agent templates — the local folder library plus the stored library in the central database.',
  idColumn: 'name',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List agent templates from both libraries with a browse summary (origin, skills, MCP servers, policy categories).',
      handler: async () => ({ templates: await listTemplates() }),
    },
    get: {
      access: 'open',
      description:
        "Show a template's digest and full detail — raw policies/policy.json, MCP catalog, packages, provider, " +
        'skills, and instructions. Use --name <template>.',
      handler: async (args) => {
        const name = (args.name ?? args.id) as string | undefined;
        if (!name) throw new Error('--name <template> is required');
        return templateDetail(name);
      },
    },
    put: {
      // Held for approval from an agent caller, like every other mutation of
      // host-owned state; the deploy pushes over the trusted host-control door.
      access: 'approval',
      description:
        'Store a template in the central database. --name <template> with --from-dir <dir> (packed by the ncl client) ' +
        'or --bundle-stdin. Idempotent by content digest. --source names the writer (default operator). --dry-run reports without writing.',
      examples: [
        'ncl templates put --name engineering-agent --from-dir /path/to/templates/engineering-agent --source release:986',
        'ncl templates put --name seed-assistant --from-dir /tmp/seed --source seed --json',
      ],
      handler: async (args) => {
        const name = args.name as string | undefined;
        if (!name) throw new Error('--name <template> is required');
        const bundleText = args.bundle;
        if (typeof bundleText !== 'string') {
          throw new Error('put needs --from-dir <dir> or --bundle-stdin (the ncl client packs the directory)');
        }
        const source = typeof args.source === 'string' && args.source ? args.source : 'operator';
        return putTemplate(name, parseBundle(bundleText), source, { dryRun: args['dry-run'] === true });
      },
    },
    rm: {
      access: 'approval',
      description: 'Remove a template from the stored library. --name <template>. A local folder template is not affected.',
      handler: async (args) => {
        const name = args.name as string | undefined;
        if (!name) throw new Error('--name <template> is required');
        return { name, removed: await deleteStoredTemplate(name) };
      },
    },
  },
});
