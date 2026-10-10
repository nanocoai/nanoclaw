/**
 * Modules barrel.
 *
 * Each module self-registers at import time. This barrel is imported by
 * src/index.ts for side effects (registry registrations, typing impl setup,
 * etc.). Core runs with an empty barrel — the registries have inline
 * fallbacks and `sqlite_master` guards.
 *
 * Default modules (ship with main, direct core import):
 *   - src/modules/typing/        → imported directly by router/delivery/container-runner
 *   - src/modules/mount-security/ → imported directly by container-runner
 *
 * Registry-based modules (installed via /add-<name> skills, pulled from the
 * `modules` branch): append imports below. The singular mailbox slot is the
 * exception: skills replace mailbox/compose.ts and leave this import intact.
 */
import '../mailbox/compose.js';

// Approvals (default tier) must load before self-mod (optional) so the
// registerApprovalHandler / requestApproval symbols are bound when self-mod
// registers its handlers at import time.
import './approvals/index.js';
import './interactive/index.js';
import './permissions/index.js';
import './agent-to-agent/index.js';
import './self-mod/index.js';

// slack canvas actions (canvas_edit / canvas_read delivery actions).
// Active here per this branch's fully-loaded convention; /add-slack appends
// the same import on user installs. Registers through the trunk guard
// registry (src/guard/, 3-arg registerDeliveryAction), on this branch since
// the main sync underneath this commit.
import './canvas-actions/index.js';

// slack room membership (adopt-on-invite, detach/re-attach, owner-presence).
// Active per this branch's fully-loaded convention; /add-slack appends the
// same import on user installs.
import './slack-room-membership/index.js';

// slack DM onboarding + thread titles (welcome prompts, auto-title).
import './slack-onboarding/index.js';
import './community-portal/index.js';
