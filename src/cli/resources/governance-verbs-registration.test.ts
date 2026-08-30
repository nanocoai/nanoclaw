/**
 * Registration + scope guard for the governance CLI verbs.
 *
 * Both suites import the REAL command barrel — the same side-effect import
 * chain the host's CLI socket server boots with (`commands/index.ts` → the
 * resources barrel).
 *
 * Suite 1 asserts the four governance resources' verbs are in the registry:
 * goes red if any of the four import lines in `src/cli/resources/index.ts` is
 * dropped, or if a resource module stops evaluating. The per-resource behavior
 * tests import their module directly, so this is the only leg that guards the
 * barrel wiring itself.
 *
 * Suite 2 asserts the SKILL.md's stated security property — group-scoped
 * agents fail closed on all four resources — through the real dispatch chain
 * (registry → guard → GROUP_SCOPE_RESOURCES whitelist) against a real central
 * DB with an explicit `cli_scope: 'group'` container config. Goes red if
 * a2a-events drops its `resource: 'a2a-events'` declaration (whose omission
 * EXEMPTS a command from the whitelist), or if the registerResource-derived
 * resource names on schedules/skills/files stop reaching the guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Production barrel — side-effect imports populate the real registry.
import '../commands/index.js';

import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { listCommands } from '../registry.js';

describe('governance CLI verbs registration', () => {
  it('the resources barrel registers a2a-events, schedules, skills, and files', () => {
    const names = new Set(listCommands().map((c) => c.name));
    for (const expected of [
      'a2a-events',
      'schedules-list',
      'schedules-pause',
      'schedules-resume',
      'schedules-cancel',
      'schedules-update',
      'skills-list',
      'skills-export',
      'skills-add',
      'files-list',
      'files-read',
      'files-write',
    ]) {
      expect(names.has(expected), `registry is missing "${expected}"`).toBe(true);
    }
  });
});

describe('governance CLI verbs fail closed for group-scoped agents', () => {
  const GROUP = 'ag-gov-scope';
  const ctx: CallerContext = {
    caller: 'agent',
    agentGroupId: GROUP,
    sessionId: 'sess-gov-scope',
    messagingGroupId: 'mg-gov-scope',
  };

  beforeAll(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: GROUP,
      name: 'gov-scope',
      folder: 'gov-scope',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    // Explicit rather than relying on the absent-row default, so this test
    // pins the exact configuration the SKILL.md's claim is about.
    await ensureContainerConfig(GROUP);
    await updateContainerConfigScalars(GROUP, { cli_scope: 'group' });
  });

  afterAll(async () => {
    await closeDb();
  });

  // One read verb per resource, plus one mutation (files-write). The guard
  // denies before parseArgs, so empty args are fine — a passing (or
  // differently-failing) response here would mean the whitelist exemption
  // leaked fleet-wide data to a group-scoped container agent.
  it.each(['a2a-events', 'schedules-list', 'skills-list', 'files-list', 'files-write'])(
    '%s is forbidden for a cli_scope=group agent caller',
    async (command) => {
      const resp = await dispatch({ id: `req-scope-${command}`, command, args: {} }, ctx);
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.error.code).toBe('forbidden');
        expect(resp.error.message).toContain('scoped to this agent group');
      }
    },
  );
});
