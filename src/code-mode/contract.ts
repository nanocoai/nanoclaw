/**
 * Contract-test helpers for the code-mode seams.
 *
 * A module that plugs into code mode proves it did so against the REAL
 * composed tree: its test imports the real barrels, then asserts through
 * these that its hook, verb or surface provider is registered. Each helper
 * throws with the refusal's reason when it is not, so a seam-version
 * mismatch reads as the failure it is.
 */
import { lookup } from '../cli/registry.js';
import { sandboxHookNames, type SandboxHookKind } from './hooks.js';
import { seamRefusals } from '../seams.js';

function refusalNote(registry: string, registrant: string): string {
  const refused = seamRefusals().find((r) => r.registry === registry && r.registrant === registrant);
  return refused
    ? ` (refused: seam ${refused.wanted} expected, ${refused.got === undefined ? 'none' : refused.got} given)`
    : '';
}

/** The hook `name` is registered for `kind`. */
export function assertSandboxHook(kind: SandboxHookKind, name: string): void {
  if (!sandboxHookNames(kind).includes(name)) {
    throw new Error(
      `sandbox hook '${kind}:${name}' is not registered${refusalNote('sandbox-hooks', `${kind}:${name}`)}`,
    );
  }
}

/** `ncl sandboxes <verb>` exists (a multi-word verb is space-separated: 'remote enable'). */
export function assertSandboxVerb(verb: string): void {
  const name = `sandboxes-${verb.replace(/ /g, '-')}`;
  if (!lookup(name)) {
    throw new Error(`ncl sandboxes ${verb} is not registered${refusalNote('resource-extension', `sandboxes ${verb}`)}`);
  }
}
