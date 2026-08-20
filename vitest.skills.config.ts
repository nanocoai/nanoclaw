import { defineConfig } from 'vitest/config';

/**
 * Opt-in project for the guard tests that `/add-*` skills ship.
 *
 * Run it with `pnpm run test:skills`. It is deliberately NOT part of
 * `pnpm test` (vitest.config.ts), because these tests assert the *applied*
 * state of the skill they ship with — `add-vercel/vercel-manifest.test.ts`
 * asserts `vercel` is present in `container/cli-tools.json`, and so on. On a
 * pristine checkout, where no skill has been applied, they are expected to
 * fail. That is the point: they are the post-install verification the skill's
 * own SKILL.md tells the applier to run, and the copy that lands in `src/`
 * during install is what the main suite then guards.
 *
 * The include glob used to be `.claude/skills/**\/tests/*.test.ts`, which
 * matched zero files on trunk — no skill has ever used a `tests/` subdirectory.
 * Skills keep their guard tests either at the skill root
 * (`add-vercel/vercel-manifest.test.ts`) or beside the payload they guard
 * (`add-dashboard/resources/dashboard-wiring.test.ts`), so the glob below
 * matches anywhere under a skill directory.
 *
 * Excluded: tests whose runner is not vitest, or which the applier copies
 * elsewhere before running. Add an exclusion here with a one-line reason
 * rather than loosening the include.
 */
export default defineConfig({
  test: {
    include: ['.claude/skills/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      // Skill payload destined for container/agent-runner/src/, whose tests
      // import from `bun:test` and only run under Bun (see vitest.config.ts).
      '.claude/skills/add-atomic-chat-tool/atomic-chat-registration.test.ts',
      '.claude/skills/add-ollama-tool/ollama-registration.test.ts',
      // Skill payload destined for src/: it imports host core by relative
      // specifier (`./claude-md-compose.js`), which only resolves once the
      // applier has copied it into src/.
      '.claude/skills/add-karpathy-llm-wiki/wiki-delivery-seam.test.ts',
    ],
  },
});
