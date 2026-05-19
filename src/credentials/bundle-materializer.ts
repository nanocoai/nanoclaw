/**
 * Native auth bundle materializer.
 *
 * `native_auth_bundle` decisions point at a vendor-runtime-owned auth file
 * (Codex `~/.codex/auth.json`, future Pi `~/.pi/agent/auth.json`). The
 * materializer copies the bundle into a per-session host dir so the
 * container's mount is isolated from the host's own state — same pattern
 * the existing Codex provider config fn uses, generalized.
 *
 * Schemes:
 *   `host:<path>` — copy from host filesystem. `~` expands to `hostEnv.HOME`.
 *   `onecli:<bundle-id>` — reserved. Returns `unsupported_scheme` until
 *                          OneCLI bundle storage exists.
 *
 * Future: `onecli:` will materialize an encrypted bundle into the session
 * dir, optionally with a sync-back path after the runtime refreshes it.
 * That work is gated on OneCLI exposing bundle storage; the type system
 * is ready for it via `decision.syncBack`.
 */
import fs from 'fs';
import path from 'path';
import type { CredentialDecision } from './types.js';
import type { VolumeMount } from '../providers/provider-container-registry.js';

export type MaterializeResult =
  | { ok: true; mount: VolumeMount }
  | { ok: false; reason: 'missing_source' | 'unsupported_scheme' | 'copy_failed'; detail?: string };

export function materializeNativeAuthBundle(
  decision: Extract<CredentialDecision, { kind: 'native_auth_bundle' }>,
  sessionDir: string,
  hostEnv: NodeJS.ProcessEnv,
): MaterializeResult {
  const schemeMatch = /^([a-z]+):(.+)$/.exec(decision.bundleRef);
  if (!schemeMatch) {
    return { ok: false, reason: 'unsupported_scheme', detail: decision.bundleRef };
  }
  const [, scheme, ref] = schemeMatch;

  if (scheme !== 'host') {
    return { ok: false, reason: 'unsupported_scheme', detail: scheme };
  }

  const home = hostEnv.HOME;
  const expanded = ref.startsWith('~/') ? (home ? path.join(home, ref.slice(2)) : ref) : ref;

  if (!fs.existsSync(expanded)) {
    return { ok: false, reason: 'missing_source', detail: expanded };
  }

  const bundleDir = path.join(sessionDir, 'credentials', decision.providerId);
  fs.mkdirSync(bundleDir, { recursive: true });
  const dest = path.join(bundleDir, path.basename(decision.mountPath));

  try {
    fs.copyFileSync(expanded, dest);
  } catch (err) {
    return { ok: false, reason: 'copy_failed', detail: String(err) };
  }

  return {
    ok: true,
    mount: {
      hostPath: dest,
      containerPath: decision.mountPath,
      readonly: decision.readonly === true,
    },
  };
}
