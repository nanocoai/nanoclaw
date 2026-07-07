import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Create the agent's persistent memory scaffold, container-side, at boot.
 *
 * The runner owns its own workspace: it writes the memory tree straight into
 * `/workspace/agent` (the host-backed, RW group dir, so it persists across the
 * ephemeral container). No host-side step, nothing mounted in.
 *
 * The default `definition.md` / `index.md` live as real markdown templates next
 * to this module (under `memory-templates/`) — not as strings in code — so the
 * doctrine is editable as markdown and the agent receives an unescaped copy.
 * They ship in the mounted `/app/src` tree, so no image change is needed.
 *
 * Idempotent — only writes what's missing, so the agent's own edits and
 * accumulated memory are never clobbered on a later wake. Provider-agnostic:
 * the runner makes no assumption about which harness is running — a provider
 * opts in via `usesMemoryScaffold`.
 */
const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-templates');

export function ensureMemoryScaffold(baseDir = '/workspace/agent'): void {
  const memoryDir = path.join(baseDir, 'memory');
  const systemDir = path.join(memoryDir, 'system');

  for (const dir of [systemDir, path.join(memoryDir, 'memories'), path.join(memoryDir, 'data')]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  copyTemplateIfMissing('definition.md', path.join(systemDir, 'definition.md'));
  copyTemplateIfMissing('index.md', path.join(memoryDir, 'index.md'));
}

function copyTemplateIfMissing(template: string, dest: string): void {
  if (fs.existsSync(dest)) return;
  fs.copyFileSync(path.join(TEMPLATES_DIR, template), dest);
}
