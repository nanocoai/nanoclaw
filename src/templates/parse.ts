import fs from 'fs';
import path from 'path';

/** A parsed template folder. Pure data — no DB, no side effects. */
export interface Template {
  mcpServers: Record<string, unknown>; // .mcp.json .mcpServers — name -> launch config
  instructions: string; // context/instructions.md (required)
  contextExtras: { name: string; content: string }[]; // context/**/*.md except instructions.md; name relative to context/
  skills: { name: string; srcDir: string }[]; // skills/<name>/ real folders
}

function readJson(file: string): unknown {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Read and lightly validate a template folder into a typed object. Throws only
 * if the folder is missing or `context/instructions.md` (the one required file)
 * is absent. `unknown`-in / parsed-out at the .mcp.json boundary.
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
