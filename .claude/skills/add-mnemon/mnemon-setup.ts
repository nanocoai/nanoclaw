/**
 * mnemon graph-memory registration — payload of the `add-mnemon` skill.
 *
 * Installed to `container/agent-runner/src/mnemon/setup.ts` and called once
 * from the runner's startup (`container/agent-runner/src/index.ts`).
 *
 * WHAT IT DOES
 * `mnemon setup --target claude-code --yes --global` writes the memory
 * integration into `$HOME/.claude`: `skills/mnemon/SKILL.md`, `mnemon/prompt/`,
 * `hooks/mnemon/{prime,user_prompt,stop}.sh`, and the `SessionStart` /
 * `UserPromptSubmit` / `Stop` entries in `settings.json` that invoke them.
 * `$HOME/.claude` is the per-agent-group `.claude-shared` mount — host-backed
 * and read-write — so the registration outlives the container, but it still
 * has to be asserted by whoever starts the agent (a fresh group has an empty
 * mount). `mnemon setup` is idempotent and re-running it does not duplicate or
 * drop foreign hook entries, so asserting it on every start is both correct
 * and cheap.
 *
 * WHY HERE, AND NOT IN container/entrypoint.sh
 * The image ENTRYPOINT is not on the spawn path. The host composes the agent
 * container's argv itself — `composeSessionSpec` in `src/container-runner.ts`
 * emits `command: ['bash','-c'], args: ['exec bun run /app/src/index.ts']`, and
 * the driver realizes that with `--entrypoint bash`. `container/entrypoint.sh`
 * therefore only runs for a bare `docker run`, and anything wired into it is
 * dead code for every real session. This module sits on the path that argv
 * actually names.
 *
 * Two consequences worth keeping in mind:
 *   - `/app/src` is a read-only bind mount of `container/agent-runner/src`, so
 *     changing this file takes effect on the next container start with no image
 *     rebuild. Only the binary (the Dockerfile layer) needs a rebuild.
 *   - This runs before the provider is constructed, so the provider's own
 *     `settings.json` merge (`writeMemorySessionHook` in
 *     `providers/claude.ts`) lands after ours and preserves it.
 *
 * Failure is never fatal: an agent without memory hooks still serves messages,
 * so every outcome is reported and returned rather than thrown.
 */
import { spawnSync } from 'child_process';

/**
 * Provider name (as the runner resolves it) → mnemon `--target`.
 *
 * mnemon >= 0.2 also ships `--target opencode` (writing to
 * `~/.config/opencode/`), but this install only wires the Claude Code target:
 * a non-Claude provider declares its own agent surfaces, so the `.claude`
 * mount those hooks live in may not even be mounted. Adding a provider here is
 * the whole change needed to extend it — see the skill's SKILL.md.
 */
const TARGET_BY_PROVIDER: Readonly<Record<string, string>> = { claude: 'claude-code' };

/** How long a wedged binary may hold up container startup. */
const SETUP_TIMEOUT_MS = 30_000;

export type MnemonSetupOutcome =
  | { status: 'registered'; target: string }
  | { status: 'unsupported-provider'; provider: string }
  | { status: 'binary-missing' }
  | { status: 'failed'; target: string; detail: string };

function defaultLog(msg: string): void {
  console.error(`[mnemon] ${msg}`);
}

/**
 * Assert mnemon's memory hooks for this container's provider. Idempotent,
 * never throws — the outcome is returned (and logged) instead.
 */
export function ensureMnemonSetup(provider: string, log: (msg: string) => void = defaultLog): MnemonSetupOutcome {
  const target = TARGET_BY_PROVIDER[provider.trim().toLowerCase()];
  if (!target) {
    log(
      `no memory target for provider '${provider}' — hooks not registered ` +
        `(this install wires the claude-code target only)`,
    );
    return { status: 'unsupported-provider', provider };
  }

  // `env` is passed explicitly rather than left to default: Bun's spawnSync
  // resolves the executable against the PATH the process started with and
  // ignores later `process.env.PATH` mutations, so the default would make both
  // an operator's PATH fix-up and this module's own tests unobservable.
  const result = spawnSync('mnemon', ['setup', '--target', target, '--yes', '--global'], {
    encoding: 'utf8',
    timeout: SETUP_TIMEOUT_MS,
    env: { ...process.env },
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log('binary not on PATH — rebuild the agent image (./container/build.sh) to install it; memory stays off');
      return { status: 'binary-missing' };
    }
    log(`setup could not run: ${result.error.message}`);
    return { status: 'failed', target, detail: result.error.message };
  }

  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim() || `exit ${String(result.status)}`;
    log(`setup --target ${target} failed, memory stays off: ${detail.split('\n').slice(-3).join(' / ')}`);
    return { status: 'failed', target, detail };
  }

  log(`memory hooks registered (--target ${target})`);
  return { status: 'registered', target };
}
