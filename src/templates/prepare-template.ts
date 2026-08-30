import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type AgentCreateSpec,
  type TemplateContextContribution,
  type TemplateSkillContribution,
  validateAgentCreateSpec,
} from './create-spec.js';
import { parseTemplate } from './parse.js';

const NANOCLAW_EXTENSION = 'ai.nanoco.nanoclaw';
const MCP_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

export interface PreparedTemplate {
  dir: string;
  cleanup(): void;
}

/**
 * Produce a normal template directory containing the exact effective inputs
 * selected by an external orchestrator. The ordinary template stamper remains
 * unaware of overlays: it only ever reads a template from disk.
 */
export function prepareTemplateForCreateSpec(sourceDir: string, spec: AgentCreateSpec): PreparedTemplate {
  validateAgentCreateSpec(spec);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-prepared-template-'));
  const dir = path.join(root, 'template');
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(root, { recursive: true, force: true });
  };

  try {
    fs.cpSync(sourceDir, dir, {
      recursive: true,
      filter: (source) => path.basename(source) !== '.git',
    });
    applyInstructions(dir, spec.templateContributions?.standingInstructions ?? []);
    applyContextFiles(dir, spec.templateContributions?.contextFiles ?? []);
    applyMcpServers(dir, spec.config.mcpServers);
    applyPackages(dir, spec.config.packagesApt, spec.config.packagesNpm);
    applySkills(dir, spec.templateContributions?.skills ?? []);

    // Parse the prepared result before any agent-group side effect. This is the
    // same parser the normal template stamper uses.
    const parsed = parseTemplate(dir);
    const requestedServers = Object.keys(spec.config.mcpServers).sort();
    const effectiveServers = Object.keys(parsed.mcpServers).sort();
    if (JSON.stringify(effectiveServers) !== JSON.stringify(requestedServers)) {
      const notices = parsed.report.filter((line) => line.startsWith('mcp.json:')).join('; ');
      throw new Error(
        `prepared plugin did not accept the exact MCP server set` + (notices ? `: ${notices}` : ''),
      );
    }
    return { dir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function applyInstructions(dir: string, additions: readonly string[]): void {
  if (additions.length === 0) return;
  const file = path.join(dir, NANOCLAW_EXTENSION, 'context', 'instructions.md');
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const combined = [original, ...additions]
    .map((instructions) => instructions.trimEnd())
    .filter((instructions) => instructions.trim())
    .join('\n\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${combined}\n`, 'utf8');
}

function applyContextFiles(dir: string, files: readonly TemplateContextContribution[]): void {
  for (const file of files) {
    const destination = path.join(dir, NANOCLAW_EXTENSION, 'context', ...file.name.split('/'));
    if (fs.existsSync(destination)) {
      throw new Error(`template contribution context file collides with existing template file: ${file.name}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content, 'utf8');
  }
}

function applyMcpServers(dir: string, mcpServers: AgentCreateSpec['config']['mcpServers']): void {
  const pluginServers = Object.fromEntries(
    Object.entries(mcpServers).map(([name, server]) => {
      if (server.type === 'http') {
        return [
          name,
          {
            type: 'streamable-http',
            url: server.url,
            ...(server.headers === undefined ? {} : { headers: server.headers }),
          },
        ];
      }
      return [
        name,
        {
          type: 'stdio',
          command: server.command,
          ...(server.args === undefined ? {} : { args: server.args }),
          ...(server.env === undefined ? {} : { env: server.env }),
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        },
      ];
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    `${JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: pluginServers }, null, 2)}\n`,
    'utf8',
  );
}

function applyPackages(dir: string, apt: readonly string[], npm: readonly string[]): void {
  const packagesDir = path.join(dir, 'packages');
  fs.mkdirSync(packagesDir, { recursive: true });
  writeLines(path.join(packagesDir, 'apt.txt'), apt);
  writeLines(path.join(packagesDir, 'npm.txt'), npm);
}

function writeLines(file: string, values: readonly string[]): void {
  fs.writeFileSync(file, values.length > 0 ? `${values.join('\n')}\n` : '', 'utf8');
}

function applySkills(dir: string, skills: readonly TemplateSkillContribution[]): void {
  for (const skill of skills) {
    const skillDir = path.join(dir, 'skills', skill.name);
    if (fs.existsSync(skillDir)) {
      throw new Error(`template contribution skill collides with existing template skill: ${skill.name}`);
    }
    for (const [file, content] of Object.entries(skill.files)) {
      const destination = path.join(skillDir, ...file.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content, 'utf8');
    }
  }
}
