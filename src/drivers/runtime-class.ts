/**
 * Kata runtime wiring, resolved where it is used (the `podNamespace` rule):
 * both keys are meaningless to a host without this driver, so trunk's SETTINGS
 * list never grows them. Same precedence as every other NanoClaw setting —
 * `process.env`, then `.env` — because the host service has no
 * `EnvironmentFile=` and parses `.env` in-process, so a value written where
 * every other NanoClaw setting lives has to be seen.
 *
 * Availability and the class NAME are separate facts on purpose. Availability
 * is an operator declaration made only after the deployment has proved the
 * RuntimeClass on its node; a wrong declaration surfaces at `ensureReady`'s
 * probe or at prepare's server dry-run as the apiserver's own refusal. The
 * name defaults to the class the encrypted-workspace harness provisions on a
 * Kata-ready substrate; a cluster whose class is named differently points
 * NANOCO_KATA_RUNTIME_CLASS at it.
 */
import { readEnvFile } from '../env.js';

const DEFAULT_KATA_RUNTIME_CLASS = 'kata-qemu-runtime-rs';

/** The RuntimeClass a vm-tier pod names. */
export function kataRuntimeClass(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.NANOCO_KATA_RUNTIME_CLASS?.trim() ||
    readEnvFile(['NANOCO_KATA_RUNTIME_CLASS']).NANOCO_KATA_RUNTIME_CLASS?.trim() ||
    DEFAULT_KATA_RUNTIME_CLASS
  );
}

/** Whether this deployment's cluster holds a Kata RuntimeClass ('1' means yes). */
export function kataAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    (env.NANOCO_KATA_AVAILABLE?.trim() || readEnvFile(['NANOCO_KATA_AVAILABLE']).NANOCO_KATA_AVAILABLE?.trim()) === '1'
  );
}
