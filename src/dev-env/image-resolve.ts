/**
 * Create-time image resolution (C15) — the seam that pins a registry ref to a
 * digest at the approved write, so what the approval signed is BITS, not a
 * tag, and placement pulls exactly those bits or fails.
 *
 * Ruling 1 (2026-08-23): placement egress — this resolution included — goes
 * THROUGH THE GATEWAY, attributed and clamped like everything else. Ruling 3:
 * credentials for private origins ride the same governed custody sandbox git
 * does; the resolver names a credential, custody holds it, and nothing here
 * ever sees a value.
 *
 * The production leg is NOT WIRED in v1: the gateway needs a catalog entry
 * for registry egress (real gateway/governance plumbing, outside this
 * branch), and resolving around it — a direct fetch from the host — would be
 * exactly the ungoverned egress the ruling forbids. Until the catalog work
 * lands, the production resolver REFUSES with that reason, in seconds, in
 * front of the author; nothing fakes a resolution.
 *
 * TODO(upstream/ops: gateway-registry-egress): add the gateway catalog entry
 * + proxy custody for registry hosts, then implement resolveDigest as a
 * manifest HEAD through the gateway (Docker-Content-Digest), and delete
 * UnwiredImageResolver's refusal. The seam, the pin grammar, and every
 * consumer are already shaped for it.
 */
import { IMAGE_DIGEST_RE, imageRefDigest, stampImageOrigin, type K8sStampConfig } from './stamps.js';

export interface ImageResolver {
  /**
   * Resolve `ref` (tag or digest form) to its manifest digest via the
   * governed egress path. `credentialName` names — never carries — a
   * credential in target custody for a private origin. Failures throw with
   * the registry's own message: the refusal the author sees.
   */
  resolveDigest(ref: string, credentialName?: string): Promise<{ digest: string }>;
}

/** The v1 production resolver: honest refusal until the governed leg exists (module header). */
export function gatewayImageResolver(): ImageResolver {
  return {
    async resolveDigest(ref: string): Promise<{ digest: string }> {
      throw new Error(
        `cannot resolve '${ref}': registry egress rides the gateway (ruling 1) and this deployment's gateway has ` +
          `no registry-egress catalog entry yet (gateway-registry-egress) — the pull path is not live here until ` +
          `that plumbing lands`,
      );
    },
  };
}

/**
 * Pin a registry-origin config: resolve its ref and snapshot `<ref>@<digest>`
 * into the config the approval stores — the card and the row then carry the
 * digest, and the approver signs bits. A ref the author already pinned is
 * VERIFIED rather than re-resolved: a resolver answer that disagrees with the
 * author's pin is a refusal, not a silent correction. Non-pull configs pass
 * through untouched.
 */
export async function pinImageConfig(config: K8sStampConfig, resolver: ImageResolver): Promise<K8sStampConfig> {
  const origin = stampImageOrigin(config);
  if (origin.kind !== 'pull') return config;
  const { digest } = await resolver.resolveDigest(origin.ref, origin.credential);
  if (!IMAGE_DIGEST_RE.test(digest)) {
    throw new Error(`resolver returned a malformed digest for '${origin.ref}': ${digest}`);
  }
  const authorPinned = imageRefDigest(origin.ref);
  if (authorPinned !== null) {
    if (authorPinned !== digest) {
      throw new Error(
        `image '${origin.ref}' is pinned to a digest the registry does not confirm (registry says ${digest}) — ` +
          `fix the pin or drop it and let resolution pin the tag`,
      );
    }
    return config;
  }
  return { ...config, app: { ...config.app!, image: `${origin.ref}@${digest}` } };
}
