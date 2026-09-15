/**
 * Contract-test helper for the session-surface seam: a module's test
 * imports the real barrels and asserts its provider is registered, with the
 * refusal's reason when it is not.
 */
import { seamRefusals } from '../../seams.js';
import { getSessionSurface } from './registry.js';

export { assertSandboxHook, assertSandboxVerb } from '../contract.js';

export function assertSurfaceRegistered(channelType: string): void {
  if (getSessionSurface(channelType)) return;
  const refused = seamRefusals().find((r) => r.registry === 'session-surface' && r.registrant === channelType);
  throw new Error(
    `no session surface is registered for '${channelType}'` +
      (refused
        ? ` (refused: seam ${refused.wanted} expected, ${refused.got === undefined ? 'none' : refused.got} given)`
        : ''),
  );
}
