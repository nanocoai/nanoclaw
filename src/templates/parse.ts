/**
 * Template = Agent Plugins 1.0.0 plugin directory. This is the flag-day
 * reader: plugin.json is the only hard requirement; skills, mcp.json, and the
 * NanoClaw extension (persona, context, tasks) are all optional, so a plain
 * conformant third-party plugin stamps fine. The pre-plugin template layout
 * is detected only to emit a migration error.
 *
 * Pure data — no DB, no side effects. Per-component failure boundaries follow
 * the spec: invalid skill/server → skip + named report; invalid manifest or
 * containment/caps violation → whole plugin rejected.
 */
import fs from 'fs';
import path from 'path';

import type { McpServerConfig } from '../container-config.js';
import { readNanoclawExtension } from './extension.js';
import { parsePluginManifest, PLUGIN_MANIFEST_FILE } from './manifest.js';
import { readPluginMcp } from './mcp.js';
import { walkPluginDir } from './plugin-dir.js';
import { readPluginSkills } from './skills.js';
import type { TemplateTask } from './tasks.js';

export type { TemplateTask } from './tasks.js';

/** A parsed plugin directory. */
export interface Template {
  /** The manifest's machine name — also the folder the plugin is stamped under. */
  name: string;
  /** Display name from extensions["ai.nanoco.nanoclaw"].agentName, when given. */
  agentName?: string;
  mcpServers: Record<string, McpServerConfig>; // mcp.json — name -> validated launch config
  instructions?: string; // ai.nanoco.nanoclaw/context/instructions.md (optional persona)
  contextExtras: { name: string; content: string }[]; // other extension-dir context/**/*.md
  skills: { name: string; srcDir: string }[]; // skills/<name>/ conforming skill folders
  tasks: TemplateTask[]; // ai.nanoco.nanoclaw/tasks/*.md, created paused when stamped
  /** Absolute, containment-validated plugin root (stamping copies from here). */
  dir: string;
  /** Named skip/ignore notices — never silently stripped components. */
  report: string[];
}

/**
 * Read and validate a plugin directory into a typed object. Throws for fatal
 * violations (missing/invalid manifest, containment or cap violations,
 * smuggled secrets); per-component problems land in `report` instead.
 */
export function parseTemplate(dir: string): Template {
  if (!fs.existsSync(dir)) throw new Error(`Template folder not found: ${dir}`);

  if (!fs.existsSync(path.join(dir, PLUGIN_MANIFEST_FILE))) {
    if (fs.existsSync(path.join(dir, 'context', 'instructions.md'))) {
      throw new Error(
        `This template predates the plugin format (no ${PLUGIN_MANIFEST_FILE}); ` +
          're-fetch it from the template library',
      );
    }
    throw new Error(`Not an agent plugin: ${PLUGIN_MANIFEST_FILE} not found in ${dir}`);
  }

  // Containment + caps gate BEFORE any content is read, so a hostile tree
  // (symlink to ~/.ssh, 10 GB file) is rejected without touching its targets.
  walkPluginDir(dir);

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(fs.readFileSync(path.join(dir, PLUGIN_MANIFEST_FILE), 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${PLUGIN_MANIFEST_FILE} is not valid JSON: ${message}`, { cause: err });
  }
  const manifest = parsePluginManifest(manifestRaw);
  const { skills, report: skillsReport } = readPluginSkills(dir);
  const { servers, report: mcpReport } = readPluginMcp(dir);
  const extension = readNanoclawExtension(dir, manifest.extensions);

  return {
    name: manifest.name,
    ...(extension.agentName === undefined ? {} : { agentName: extension.agentName }),
    mcpServers: servers,
    ...(extension.instructions === undefined ? {} : { instructions: extension.instructions }),
    contextExtras: extension.contextExtras,
    skills,
    tasks: extension.tasks,
    dir: path.resolve(dir),
    report: [...manifest.report, ...skillsReport, ...mcpReport, ...extension.report],
  };
}
