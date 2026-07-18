import fs from 'fs';
import path from 'path';

export const MEMORY_FILE_BUDGET_CHARS = 16_000;
export const MEMORY_TRUNCATION_NOTICE = '[truncated: slim this file and move detail into linked memory files]';

/**
 * Render the two always-loaded memory files inside the container. Host-side
 * composers never read agent-controlled memory.
 */
export function renderMemorySection(baseDir = '/workspace/agent'): string {
  const memoryDir = path.join(baseDir, 'memory');
  const index = readMemoryFile(path.join(memoryDir, 'index.md'));
  const definition = readMemoryFile(path.join(memoryDir, 'system', 'definition.md'));

  return [
    '## Memory',
    '',
    'These files are loaded at startup, after clear, and after compaction:',
    '',
    '- `/workspace/agent/memory/index.md` - top-level memory index and Core Memory',
    '- `/workspace/agent/memory/system/definition.md` - memory system behavior',
    '',
    'The files on disk are authoritative. Edit them directly; follow links from',
    'the index when more detail is relevant.',
    '',
    '`memory/` is an Open Knowledge Format (OKF) v0.1 bundle: one Markdown',
    'concept per file, opened by a short YAML frontmatter with a `type`',
    '(`index.md` and `log.md` are exempt; see the definition).',
    '',
    '### memory/index.md',
    '',
    index,
    '',
    '### memory/system/definition.md',
    '',
    definition,
    '',
  ].join('\n');
}

function readMemoryFile(filePath: string): string {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '(unavailable during this hook invocation)';
  }
  if (content.length <= MEMORY_FILE_BUDGET_CHARS) return content;

  let truncated = content.slice(0, MEMORY_FILE_BUDGET_CHARS);
  const last = truncated.charCodeAt(truncated.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) truncated = truncated.slice(0, -1);
  return `${truncated}\n${MEMORY_TRUNCATION_NOTICE}`;
}
