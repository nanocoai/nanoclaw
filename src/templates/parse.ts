import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

/** A parsed template folder. Pure data — no DB, no side effects. */
export interface Template {
  mcpServers: Record<string, unknown>; // .mcp.json .mcpServers — name -> launch config
  instructions: string; // context/instructions.md (required)
  contextExtras: { name: string; content: string }[]; // context/**/*.md except instructions.md; name relative to context/
  skills: { name: string; srcDir: string }[]; // skills/<name>/ real folders
  tasks: TemplateTask[]; // tasks/*.md, recurring tasks created paused when stamped
}

export interface TemplateTask {
  name: string;
  schedule: string;
  script?: string;
  prompt: string;
  source: string;
}

function readJson(file: string): unknown {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Read and validate a template folder into a typed object. The folder and
 * context/instructions.md are required; optional task files are strict so a
 * typo cannot silently stamp incomplete automation.
 */
export function parseTemplate(dir: string): Template {
  if (!fs.existsSync(dir)) throw new Error(`Template folder not found: ${dir}`);

  const mcpServers = asRecord(asRecord(readJson(path.join(dir, '.mcp.json'))).mcpServers);

  const instructionsFile = path.join(dir, 'context', 'instructions.md');
  if (!fs.existsSync(instructionsFile)) {
    throw new Error(`Template missing required context/instructions.md: ${dir}`);
  }
  const instructions = fs.readFileSync(instructionsFile, 'utf-8').trimEnd();

  return {
    mcpServers,
    instructions,
    contextExtras: readContextExtras(path.join(dir, 'context')),
    skills: readSkills(path.join(dir, 'skills')),
    tasks: readTasks(path.join(dir, 'tasks')),
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
    .filter((f) => f.endsWith('.md') && f !== 'instructions.md' && fs.statSync(path.join(contextDir, f)).isFile())
    .map((name) => ({ name, content: fs.readFileSync(path.join(contextDir, name), 'utf-8') }));
}

/** Each immediate subdirectory of skills/ is a packaged skill. */
function readSkills(skillsDir: string): { name: string; srcDir: string }[] {
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir)
    .map((name) => ({ name, srcDir: path.join(skillsDir, name) }))
    .filter(({ srcDir }) => fs.statSync(srcDir).isDirectory());
}

/** Immediate Markdown files under tasks/. Filename = task name, body = prompt. */
function readTasks(tasksDir: string): TemplateTask[] {
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => parseTaskFile(tasksDir, entry.name));
}

function parseTaskFile(tasksDir: string, file: string): TemplateTask {
  const source = `tasks/${file}`;
  const name = path.basename(file, '.md');
  if (!name) throw new Error(`Template task ${source} has no task name`);

  const lines = fs.readFileSync(path.join(tasksDir, file), 'utf-8').split(/\r?\n/);
  if (lines[0] !== '---') throw new Error(`Template task ${source} must start with --- frontmatter`);
  const closing = lines.indexOf('---', 1);
  if (closing === -1) throw new Error(`Template task ${source} is missing the closing ---`);

  let metadata: unknown;
  try {
    metadata = parse(lines.slice(1, closing).join('\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Template task ${source} has invalid YAML frontmatter: ${message}`, { cause: err });
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`Template task ${source} frontmatter must be a YAML mapping`);
  }
  const unknownFields = Object.keys(metadata).filter((key) => key !== 'schedule' && key !== 'script');
  if (unknownFields.length > 0) {
    throw new Error(`Template task ${source} frontmatter accepts only schedule and script`);
  }

  const scheduleValue = Reflect.get(metadata, 'schedule');
  if (typeof scheduleValue !== 'string' || !scheduleValue.trim()) {
    throw new Error(`Template task ${source} schedule must be a nonempty string`);
  }
  const schedule = scheduleValue.trim();

  const scriptValue = Reflect.get(metadata, 'script');
  if (scriptValue !== undefined && (typeof scriptValue !== 'string' || !scriptValue.trim())) {
    throw new Error(`Template task ${source} script must be a nonempty string`);
  }

  const prompt = lines
    .slice(closing + 1)
    .join('\n')
    .trim();
  if (!prompt) throw new Error(`Template task ${source} prompt is required`);
  return {
    name,
    schedule,
    ...(typeof scriptValue === 'string' ? { script: scriptValue } : {}),
    prompt,
    source,
  };
}
