/**
 * Composition bootstrap for the in-tree host harnesses.
 *
 * Import this FIRST (before anything that touches a session) from any script
 * that drives the real host path — `scripts/test-v2-host.ts`,
 * `scripts/test-v2-channel-e2e.ts`, and anything modeled on them.
 *
 * Why it exists. The host is composed, not monolithic: `src/index.ts` imports
 * `src/modules/index.js` for side effects, and that barrel is where the
 * singular mailbox composition slot is filled (`src/mailbox/compose.ts` →
 * `registerAgentMailbox`). A script that skips it dies the first time it
 * resolves a session, with `No agent mailbox registered` thrown from
 * `getAgentMailbox` — deep inside `initSessionFolder`, several frames below
 * `routeInbound`, where it reads like a router bug rather than a missing
 * import. Every harness in this directory acquired exactly that break when
 * the mailbox seam landed (#3349).
 *
 * So the harnesses import the composition through here, in one place, and the
 * next seam extraction is a one-line change to this file instead of a silent
 * break in four scripts. Keep this list in step with the side-effect imports
 * in `src/index.ts`; a harness that needs a specific channel adapter or the
 * `ncl` command registry imports those itself, since most do not.
 */

// Modules barrel — registration modules, including the mailbox slot.
import '../src/modules/index.js';

// Offline gateway, registered but never selected unless the operator asks for
// it with NANOCLAW_GATEWAY_PROVIDER=harness-noop. See the file header for why
// a harness needs one and why it cannot leak into the host.
import './harness-gateway-noop.js';
