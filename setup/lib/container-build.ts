/**
 * The one seam through which setup rebuilds the agent container image.
 *
 * Both callers used to shell out to `build.sh` directly and drop the result:
 * `setup/auto.ts` ignored the exit status outright, so a failed build read like
 * a successful one and the run carried on against a stale image.
 *
 * It also refuses when the image is pinned. An install that pulled its image
 * holds those bytes under the local slug tag, and an unconditional
 * `docker build -t <slug>:latest` replaces them in place — same name, different
 * bytes, invisible downstream, because the tag is all `src/container-runner.ts`
 * ever looks at. `build.sh` refuses too; this is the earlier, better-worded stop.
 *
 * The result is returned, never printed: `setup/auto.ts` renders it through
 * clack's `fail()`, the standalone step through `console.error` + exit.
 */
import { spawnSync } from 'child_process';
import path from 'path';

import { HARDENED_IMAGE_ENV_KEY, readImageSource } from './registry-state.js';

/**
 * Discriminated so a caller that has checked `ok` gets a `message` typed
 * `string`, not `string | undefined` — the failure branch is the whole point.
 */
export type ContainerBuildResult =
  | { ok: true }
  | {
      ok: false;
      /** One user-facing sentence naming the failure. */
      message: string;
      /** What the operator can do about it. */
      hint?: string;
    };

/**
 * Rebuild the agent container image, refusing when the image is pinned.
 *
 * Synchronous with inherited stdio — docker's own output is the progress
 * indicator. Callers must inspect the result.
 */
export function buildContainerImage(projectRoot: string = process.cwd()): ContainerBuildResult {
  if (readImageSource() === 'hardened') {
    return {
      ok: false,
      message: `This install runs a pinned agent image (${HARDENED_IMAGE_ENV_KEY}=true in .env), and a local build would overwrite it under the same tag.`,
      hint: `Run \`./container/build.sh pull\` to refresh the pinned image, or remove ${HARDENED_IMAGE_ENV_KEY} from .env to go back to locally built ones.`,
    };
  }

  const script = path.join(projectRoot, 'container', 'build.sh');
  const res = spawnSync(script, [], { cwd: projectRoot, stdio: 'inherit' });

  if (res.error) {
    return {
      ok: false,
      message: `Couldn't run ${script}: ${res.error.message}`,
      hint: 'Check that the script exists at that path and is executable.',
    };
  }
  if (res.signal) {
    return {
      ok: false,
      message: `The container image build was terminated by ${res.signal}.`,
      hint: 'If you interrupted it, re-run when ready. Otherwise it was most likely killed for memory — give Docker more, then retry.',
    };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      message: `The container image build failed (exit ${res.status}).`,
      hint: 'The build output above has the reason. Docker must be running, and the build needs network access to fetch base layers.',
    };
  }

  return { ok: true };
}
