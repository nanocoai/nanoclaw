/**
 * The NanoClaw side-channel of a plugin — everything that is not portable
 * Agent Plugins surface lives behind this one module boundary:
 *
 *   - the `ai.nanoco.nanoclaw/` extension directory (persona, context extras,
 *     scheduled tasks), the spec's §8.2 mechanism for client-specific files
 *   - the `extensions["ai.nanoco.nanoclaw"]` manifest key (agentName)
 *
 * Everything here is optional: a plain conformant plugin with no NanoClaw
 * extension stamps fine (skills + MCP, folder-derived name, no persona, no
 * tasks). If the spec ever absorbs one of these fields, promoting it is a
 * code move out of this file, not a rewrite.
 */
import fs from 'fs';
import path from 'path';

import { readTasks, type TemplateTask } from './tasks.js';

export const NANOCLAW_EXTENSION_NS = 'ai.nanoco.nanoclaw';

export interface NanoclawExtension {
  /** Display name for the stamped agent group; folder-leaf fallback applies when absent. */
  agentName?: string;
  /** Persona from <ns>/context/instructions.md — optional by decision; registries may require it by policy. */
  instructions?: string;
  /** Other <ns>/context/**\/*.md, names relative to context/ so references resolve unchanged. */
  contextExtras: { name: string; content: string }[];
  tasks: TemplateTask[];
  report: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readNanoclawExtension(
  pluginDir: string,
  manifestExtensions: Record<string, unknown>,
): NanoclawExtension {
  const report: string[] = [];

  let agentName: string | undefined;
  const ours = manifestExtensions[NANOCLAW_EXTENSION_NS];
  if (ours !== undefined) {
    if (!isPlainObject(ours)) {
      report.push(`plugin.json: extensions["${NANOCLAW_EXTENSION_NS}"] is not an object; ignored`);
    } else {
      const value = ours.agentName;
      if (value !== undefined) {
        if (typeof value === 'string' && value.trim()) agentName = value.trim();
        else
          report.push(
            `plugin.json: extensions["${NANOCLAW_EXTENSION_NS}"].agentName must be a nonempty string; ignored`,
          );
      }
      for (const key of Object.keys(ours)) {
        if (key !== 'agentName') {
          report.push(`plugin.json: extensions["${NANOCLAW_EXTENSION_NS}"].${key} is not recognized; ignored`);
        }
      }
    }
  }

  const extDir = path.join(pluginDir, NANOCLAW_EXTENSION_NS);
  const contextDir = path.join(extDir, 'context');
  const instructionsFile = path.join(contextDir, 'instructions.md');
  let instructions: string | undefined;
  if (fs.existsSync(instructionsFile)) {
    if (!fs.lstatSync(instructionsFile).isFile()) {
      throw new Error(`${NANOCLAW_EXTENSION_NS}/context/instructions.md must be a regular file`);
    }
    instructions = fs.readFileSync(instructionsFile, 'utf-8').trimEnd();
  }

  return {
    ...(agentName === undefined ? {} : { agentName }),
    ...(instructions === undefined ? {} : { instructions }),
    contextExtras: readContextExtras(contextDir),
    tasks: readTasks(path.join(extDir, 'tasks'), `${NANOCLAW_EXTENSION_NS}/tasks`),
    report,
  };
}

/**
 * Every context/**\/*.md except the top-level instructions.md, recursively.
 * `name` keeps the path relative to context/ so stamping can preserve the
 * layout — a reference like `additional_context/faq.md` written in
 * instructions.md resolves unchanged in the agent's workspace.
 */
function readContextExtras(contextDir: string): { name: string; content: string }[] {
  if (!fs.existsSync(contextDir)) return [];
  return (fs.readdirSync(contextDir, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => f.endsWith('.md') && f !== 'instructions.md' && fs.lstatSync(path.join(contextDir, f)).isFile())
    .sort()
    .map((name) => ({ name, content: fs.readFileSync(path.join(contextDir, name), 'utf-8') }));
}
