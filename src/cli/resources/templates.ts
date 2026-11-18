/**
 * `ncl templates list`: the templates an agent can be created from. Local by
 * default (no network); `--registry` reads the public library's index from
 * one fixed URL, so nothing the caller typed is sent anywhere. Read-only,
 * which is why group-scoped agents may run it.
 */
import { TEMPLATES_DIR } from '../../config.js';
import {
  fetchTemplateIndex,
  hasLocalTemplate,
  listTemplatesFromDir,
  templateDescription,
  type LibraryTemplate,
} from '../../templates/library.js';
import { isValidTemplateRef } from '../../templates/local-dir.js';
import { registerResource } from '../crud.js';

// The verb runs inside the host's delivery loop: one fetch (or one failure)
// every few minutes keeps a slow or blocked network from stalling delivery.
const INDEX_MEMO_MS = 5 * 60_000;
let indexMemo: { at: number; result: Promise<LibraryTemplate[]> } | undefined;

function libraryIndex(): Promise<LibraryTemplate[]> {
  if (!indexMemo || Date.now() - indexMemo.at > INDEX_MEMO_MS) {
    indexMemo = { at: Date.now(), result: fetchTemplateIndex() };
  }
  return indexMemo.result;
}

/** Tests only: the next listing fetches again. */
export function _forgetLibraryIndex(): void {
  indexMemo = undefined;
}

interface TemplateRow {
  ref: string;
  name: string;
  description: string;
  /** Library rows only: a copy is already on this machine. */
  local?: boolean;
}

registerResource({
  name: 'template',
  plural: 'templates',
  // There is no templates table; with no generic operations nothing reads it.
  table: 'templates',
  description: 'Agent templates: what create_agent and `groups create --template` can build from.',
  idColumn: 'ref',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description:
        'List agent templates. Without flags, the templates on this machine (no network). ' +
        'With --registry, the public template library.',
      args: [{ name: 'registry', type: 'boolean', description: 'List the public template library instead.' }],
      examples: ['ncl templates list', 'ncl templates list --registry'],
      handler: async (args): Promise<TemplateRow[]> => {
        if (args.registry) {
          return (await libraryIndex()).map((t) => ({ ...t, local: hasLocalTemplate(t.ref) }));
        }
        // Only refs create_agent accepts, so an agent is never offered one it cannot use.
        return listTemplatesFromDir(TEMPLATES_DIR)
          .filter((t) => isValidTemplateRef(t.ref))
          .map((t) => ({ ...t, description: templateDescription(t.ref) ?? '' }));
      },
      formatHuman: (data) => {
        const rows = data as TemplateRow[];
        if (rows.length === 0) return 'No templates.';
        return rows.map((r) => `${r.ref}${r.local ? ' [on this machine]' : ''} - ${r.description}`).join('\n');
      },
    },
  },
});
