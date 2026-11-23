import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['src/test-setup.ts'],
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'scripts/**/*.test.ts',
      'container/*.test.ts',
      // A gateway skill's own scripts, tested where they live. NOT its
      // `payload/` — those files import as if already installed under `src/`,
      // so they only resolve once the skill has been applied, and the skill
      // runs them itself as its `nc:run effect:test` step.
      '.claude/skills/*/scripts/**/*.test.ts',
    ],
  },
});
