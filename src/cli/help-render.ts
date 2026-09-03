/**
 * Pure renderers for command help. Single source for three surfaces that must
 * never disagree:
 *   - `ncl <resource> help [<verb>]` (commands/help.ts)
 *   - `--help` on any command (dispatch interception)
 *   - the usage block appended to invalid-args errors (crud.ts validation)
 *
 * Imports only types from crud.ts, so crud.ts can import these functions at
 * runtime without a cycle.
 */
import type { ColumnDef, CustomOperation, ResourceDef } from './crud.js';

const GENERIC_VERBS = ['list', 'get', 'create', 'update', 'delete'] as const;
type GenericVerb = (typeof GENERIC_VERBS)[number];

export function flagName(col: Pick<ColumnDef, 'name'>): string {
  return `--${col.name.replace(/_/g, '-')}`;
}

/** First line of a possibly multi-paragraph description. */
export function summaryLine(description: string): string {
  return description.split('\n', 1)[0];
}

/** Indent every non-empty line of a block by `pad`. */
export function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

function flagLine(col: ColumnDef, extraTags: string[] = []): string {
  const tags: string[] = [...extraTags];
  if (col.required) tags.push('required');
  if (col.default !== undefined && col.default !== null) tags.push(`default: ${col.default}`);
  if (col.enum) tags.push(`values: ${col.enum.join(' | ')}`);
  const tagStr = tags.length > 0 ? ` (${tags.join(', ')})` : '';
  return `  ${flagName(col).padEnd(28)} ${summaryLine(col.description)}${tagStr}`;
}

/** All verbs a resource exposes, generics first, in help order. */
export function listVerbs(res: ResourceDef): string[] {
  const verbs: string[] = GENERIC_VERBS.filter((v) => res.operations[v]);
  if (res.customOperations) verbs.push(...Object.keys(res.customOperations));
  return verbs;
}

/** Flags a generic verb accepts, derived from the resource's columns. */
function genericFlags(res: ResourceDef, verb: GenericVerb): ColumnDef[] {
  switch (verb) {
    case 'create':
      return res.columns.filter((c) => !c.generated);
    case 'update':
      return res.columns.filter((c) => c.updatable);
    case 'list':
      // Non-generated columns double as equality filters.
      return [
        ...res.columns.filter((c) => !c.generated).map((c) => ({ ...c, required: false })),
        { name: 'limit', type: 'number', description: 'Max rows returned.', default: 200 } as ColumnDef,
      ];
    case 'get':
    case 'delete':
      return [];
  }
}

function genericSummary(res: ResourceDef, verb: GenericVerb): string {
  switch (verb) {
    case 'list':
      return `List ${res.plural}. Flags below act as equality filters.`;
    case 'get':
      return `Get a ${res.name} by ID.`;
    case 'create':
      return `Create a new ${res.name}.`;
    case 'update':
      return `Update a ${res.name} by ID. Provide at least one updatable flag.`;
    case 'delete':
      return `Delete a ${res.name} by ID.`;
  }
}

/**
 * Deep help for one verb: usage line, full description, flags, examples.
 * `verb` is a custom-operation key or a generic CRUD verb. Returns undefined
 * for a verb the resource doesn't have.
 */
export function renderVerbHelp(res: ResourceDef, verb: string): string | undefined {
  const op: CustomOperation | undefined = res.customOperations?.[verb];
  const generic = !op && (GENERIC_VERBS as readonly string[]).includes(verb) ? (verb as GenericVerb) : undefined;
  if (!op && !generic) return undefined;
  if (generic && !res.operations[generic]) return undefined;

  const access = op ? op.access : res.operations[generic!];
  const accessTag = access && access !== 'open' ? ` [${access}]` : '';
  const needsId = generic === 'get' || generic === 'update' || generic === 'delete';

  const lines: string[] = [];
  lines.push(`ncl ${res.plural} ${verb}${needsId ? ' <id>' : ''}${accessTag}`);
  lines.push('');
  lines.push(op ? op.description : genericSummary(res, generic!));

  const flags = op ? (op.args ?? []) : genericFlags(res, generic!);
  if (flags.length > 0) {
    lines.push('');
    lines.push('Flags:');
    for (const f of flags) lines.push(flagLine(f));
  }
  if (op?.examples?.length) {
    lines.push('');
    lines.push('Examples:');
    for (const ex of op.examples) lines.push(indent(ex, '  '));
  }
  return lines.join('\n');
}
