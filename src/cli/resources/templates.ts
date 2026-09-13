/**
 * `ncl templates list` — read-only discovery of stampable agent templates.
 *
 * Two sources, one verb: the install's own `templates/` directory (default, a
 * plain dir read) and the public registry index (`--registry`, the host GETs
 * one fixed public URL). Listing carries no approval and sends no
 * request-derived data, so a group-scoped agent may run it to offer templates
 * when creating an agent comes up.
 *
 * Versions are deliberately absent from every row: they feed provenance at
 * stamp time, never listings.
 */
import { fetchRegistryIndex, hasLocalTemplate, listLocalTemplates } from '../../templates/registry.js';
import { registerResource } from '../crud.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface TemplateRow {
  ref: string;
  name: string;
  description: string;
  /** Registry rows only: an install-local copy of this ref already exists. */
  local?: boolean;
  /** Local rows only. */
  source?: 'local';
}

registerResource({
  name: 'template',
  plural: 'templates',
  // No `templates` table exists: `operations: {}` registers no generic verb, so
  // the generic SQL handlers that read `table` are never created. The name is
  // help-only.
  table: 'templates',
  description: 'Agent templates: stampable agent definitions (local templates/ dir + the public registry).',
  idColumn: 'ref',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description:
        'List agent templates. Without flags, the templates already on this machine (no network). ' +
        'With --registry, the public template library; narrow it with --category <first ref segment> and --limit <n>.',
      args: [
        { name: 'registry', type: 'boolean', description: 'List the public registry instead of local templates/.' },
        { name: 'category', type: 'string', description: 'Registry only: filter by first ref segment (e.g. sales).' },
        {
          name: 'limit',
          type: 'number',
          description: `Registry only: max rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      ],
      examples: ['ncl templates list', 'ncl templates list --registry --category sales --limit 10'],
      handler: async (args): Promise<TemplateRow[]> => {
        if (!args.registry && (args.category !== undefined || args.limit !== undefined)) {
          throw new Error('The --category/--limit flags require --registry.');
        }

        if (!args.registry) {
          return listLocalTemplates().map((t) => ({
            ref: t.ref,
            name: t.name,
            description: t.description ?? '',
            source: 'local' as const,
          }));
        }

        // A fetch failure propagates as a handler error on purpose — that IS
        // the "no registry access" signal the caller reports.
        const index = await fetchRegistryIndex();
        const category = args.category as string | undefined;
        const limit = Math.min(Math.max((args.limit as number | undefined) ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
        return index.templates
          .filter((t) => !category || t.ref.split('/')[0] === category)
          .slice(0, limit)
          .map((t) => ({ ref: t.ref, name: t.name, description: t.description, local: hasLocalTemplate(t.ref) }));
      },
      formatHuman: (data) => {
        const rows = data as TemplateRow[];
        if (rows.length === 0) return 'No templates.';
        return rows.map((r) => `${r.ref}${r.local ? ' [local]' : ''} - ${r.description}`).join('\n');
      },
    },
  },
});
