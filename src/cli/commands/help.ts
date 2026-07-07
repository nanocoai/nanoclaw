/**
 * Built-in help command. Introspects the resource and command registries.
 *
 *   ncl help               — list all resources and commands
 *   ncl groups help         — show group resource details (verbs, columns, enums)
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { getResource, getResources } from '../crud.js';
import type { CallerContext } from '../frame.js';
import { listCommands, register } from '../registry.js';

const GROUP_SCOPE_RESOURCES = new Set(['groups', 'sessions', 'destinations', 'members']);

function getCliScope(ctx: CallerContext): string | undefined {
  if (ctx.caller !== 'agent') return undefined;
  return getContainerConfig(ctx.agentGroupId)?.cli_scope ?? 'group';
}

register({
  name: 'help',
  description: 'List available resources and commands.',
  access: 'open',
  parseArgs: () => ({}),
  handler: async (_args, ctx) => {
    const cliScope = getCliScope(ctx);
    let resources = getResources();
    if (cliScope === 'group') {
      resources = resources.filter((r) => GROUP_SCOPE_RESOURCES.has(r.plural));
    }
    const commands = listCommands().filter((c) => !c.resource);

    const lines: string[] = [];

    if (cliScope === 'group') {
      lines.push('CLI scope: group (--id and group args are auto-filled to your agent group)');
      lines.push('');
    }

    if (resources.length > 0) {
      lines.push('Resources:');
      for (const r of resources) {
        const ops: string[] = [];
        if (r.operations.list) ops.push('list');
        if (r.operations.get) ops.push('get');
        if (r.operations.create) ops.push('create');
        if (r.operations.update) ops.push('update');
        if (r.operations.delete) ops.push('delete');
        if (r.customOperations) ops.push(...Object.keys(r.customOperations));
        lines.push(`  ${r.plural.padEnd(20)} ${r.description}`);
        lines.push(`  ${''.padEnd(20)} verbs: ${ops.join(', ')}`);
      }
    }

    if (commands.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Commands:');
      for (const c of commands) {
        lines.push(`  ${c.name.padEnd(20)} ${c.description}`);
      }
    }

    lines.push('');
    lines.push('Run `ncl <resource> help` for detailed field information.');
    return lines.join('\n');
  },
});

// Register per-resource help commands. These are registered dynamically
// after the resources barrel has been imported.
// We use a lazy approach: register a catch-all pattern isn't possible with
// the flat registry, so we register `<plural>-help` for each resource
// in a post-import hook.
export function registerResourceHelpCommands(): void {
  for (const res of getResources()) {
    // Skip if already registered (e.g. from a previous call)
    try {
      register({
        name: `${res.plural}-help`,
        description: `Show ${res.name} resource details.`,
        access: 'open',
        resource: res.plural,
        parseArgs: () => ({}),
        handler: async (_args, ctx) => {
          const cliScope = getCliScope(ctx);
          const lines: string[] = [];
          lines.push(`${res.plural}: ${res.description}`);

          if (cliScope === 'group' && GROUP_SCOPE_RESOURCES.has(res.plural)) {
            lines.push('');
            lines.push('Note: --id and group args are auto-filled to your agent group. You do not need to pass them.');
          }

          lines.push('');

          // Verbs
          const idAutoFilled = cliScope === 'group' && (res.plural === 'groups' || res.plural === 'destinations');
          const idHint = idAutoFilled ? '' : ' <id>';
          const verbs: string[] = [];
          if (res.operations.list) verbs.push(`list [open]`);
          if (res.operations.get) verbs.push(`get${idHint} [open]`);
          if (res.operations.create) verbs.push(`create [approval]`);
          if (res.operations.update) verbs.push(`update${idHint} [approval]`);
          if (res.operations.delete) verbs.push(`delete${idHint} [approval]`);
          if (res.customOperations) {
            for (const [verb, op] of Object.entries(res.customOperations)) {
              verbs.push(`${verb} [${op.access}] — ${op.description}`);
            }
          }
          lines.push('Verbs:');
          for (const v of verbs) lines.push(`  ${v}`);
          lines.push('');

          // Columns
          const autoFilledFields =
            cliScope === 'group' ? new Set(['id', 'agent_group_id', 'group']) : new Set<string>();
          lines.push('Fields:');
          for (const col of res.columns) {
            const tags: string[] = [];
            if (autoFilledFields.has(col.name)) tags.push('auto-filled');
            if (col.generated) tags.push('auto');
            if (col.required) tags.push('required');
            if (col.updatable) tags.push('updatable');
            if (col.default !== undefined && col.default !== null) tags.push(`default: ${col.default}`);
            if (col.enum) tags.push(`values: ${col.enum.join(' | ')}`);

            const flag = `--${col.name.replace(/_/g, '-')}`;
            const tagStr = tags.length > 0 ? ` (${tags.join(', ')})` : '';
            lines.push(`  ${flag.padEnd(28)} ${col.description}${tagStr}`);
          }
          return lines.join('\n');
        },
      });
    } catch {
      // Already registered — skip
    }
  }
}
