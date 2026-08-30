/**
 * `ncl templates` — read-only inspection over the host-owned template format.
 *
 * Templates are folder-backed (under `templates/`), so this resource has no DB
 * table: only custom verbs.
 *   list        — browse summaries (provider, skills, MCP, policy categories)
 *   get <name>  — full detail: the template policy + MCP catalog + provider
 *                 (what the service reads to compute `agent = template ∩ policy`)
 */
import { listTemplates, templateDetail } from '../../templates/registry.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'template',
  plural: 'templates',
  // Folder-backed — no DB table; only the custom verbs below are registered.
  table: '',
  description: 'Agent templates (folder-backed under templates/). Read-only browse and inspection.',
  idColumn: 'name',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List agent templates with a browse summary (provider, skills, MCP servers, policy categories).',
      handler: async () => ({ templates: listTemplates() }),
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
  },
});
