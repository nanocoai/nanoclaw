import type { Migration } from './index.js';

/**
 * Per-agent-group `system_prompt_mode` on `container_configs`.
 *
 * NULL = `claude_code` (the Claude Code system-prompt preset with the composed
 * instructions appended) — deliberately no backfill. `plain` passes only the
 * composed instructions as the system prompt, for non-Claude models served
 * through an Anthropic-compatible endpoint that cannot follow the preset.
 */
export const migration026: Migration = {
  version: 26,
  name: 'container-config-system-prompt-mode',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN system_prompt_mode TEXT;`);
  },
};
