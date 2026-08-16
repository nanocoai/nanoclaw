/**
 * Strict parser for template task files (tasks/*.md with YAML frontmatter).
 * Shared plumbing, not extension-specific code — the NanoClaw extension dir
 * is merely where the files live in a plugin.
 */
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

import { prepareScheduledTask, taskNameSlug, type PreparedScheduledTask } from '../modules/scheduling/create.js';

export interface TemplateTask {
  name: string;
  schedule: string;
  script?: string;
  prompt: string;
  source: string;
}

/**
 * Validate and prepare a template's tasks for stamping, keyed by task name.
 * Task ids embed a truncated name slug; two names colliding on it would
 * silently fight over one live series on a later update, so a colliding
 * template is refused here — at first stamp, before anything is created,
 * not on the first restamp. Both stamp paths (create and in-place update)
 * go through this single validity gate.
 */
export function prepareTemplateTasks(tasks: TemplateTask[], timezone: string): Map<string, PreparedScheduledTask> {
  const slugs = new Map<string, string>();
  for (const task of tasks) {
    const slug = taskNameSlug(task.name);
    if (!slug) {
      throw new Error(`Template task ${task.source}: name "${task.name}" produces an empty id slug; rename it`);
    }
    const clash = slugs.get(slug);
    if (clash !== undefined) {
      throw new Error(`Template tasks "${clash}" and "${task.name}" collide on id slug "${slug}"; rename one`);
    }
    slugs.set(slug, task.name);
  }
  return new Map(
    tasks.map((task) => {
      try {
        return [
          task.name,
          prepareScheduledTask({
            name: task.name,
            prompt: task.prompt,
            recurrence: task.schedule,
            script: task.script,
            timezone,
          }),
        ];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid template task ${task.source}: ${message}`, { cause: err });
      }
    }),
  );
}

/** Immediate Markdown files under tasksDir. Filename = task name, body = prompt. */
export function readTasks(tasksDir: string, sourcePrefix: string): TemplateTask[] {
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => parseTaskFile(tasksDir, entry.name, sourcePrefix));
}

function parseTaskFile(tasksDir: string, file: string, sourcePrefix: string): TemplateTask {
  const source = `${sourcePrefix}/${file}`;
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
