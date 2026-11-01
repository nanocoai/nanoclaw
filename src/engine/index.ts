/**
 * Public engine entry — the surface embedders use.
 *
 * This barrel intentionally re-exports only the seams plugins/hosts should
 * touch. Internals (router.ts, delivery.ts, container-runner.ts) stay in
 * their own modules and are not re-exported, so plugin code can't accidentally
 * couple to upstream internals and create merge-conflict surface.
 */
export { createNanoClawHost, type NanoClawHost, type NanoClawHostOptions } from './host.js';
export type { NanoClawPlugin, PluginContext } from './plugin.js';
export { setLogIdHasher, logId, type LogIdHasher } from '../log-id.js';

export { engineEvents, type EngineEventBus, type EngineEventMap, type EngineEventName } from './events.js';

export {
  setEnginePaths,
  getEnginePaths,
  resolveGroupDir,
  type EnginePaths,
  type EnginePathOverrides,
  type GroupRef,
  type GroupDirResolver,
} from './paths.js';

export {
  setCredentialProvider,
  getCredentialProvider,
  type CredentialProvider,
  type CredentialBundle,
  type CredentialContext,
} from './credentials.js';

export {
  setPlatformCredentialReader,
  getPlatformCredentialReader,
  type PlatformCredentialReader,
} from './platform-credentials.js';

export {
  registerSpawnContribution,
  collectSpawnContributions,
  type SpawnContribution,
  type SpawnContext,
} from './spawn-contrib.js';

export {
  addSkillRoot,
  getExtraSkillRoots,
  addContextFragmentProvider,
  getContextFragments,
  type ExtraSkillRoot,
  type ContextFragmentProvider,
} from './skill-roots.js';

export {
  setWorkspaceResolver,
  resolveWorkspace,
  type WorkspaceResolverFn,
  type WorkspaceContext,
} from './workspace.js';

export {
  addSenderResolver,
  addAccessGate,
  addSenderScopeGate,
  addMessageInterceptor,
  addChannelRequestGate,
} from './router-hooks.js';

// Engage-decision observer. Re-exported straight from the router (no
// router-hooks wrapper) because the registry is already multi-subscriber
// with unsubscribe semantics — there is no singleton setter to compose.
export { registerEngageObserver, type EngageObservation, type EngageObserverFn } from '../router.js';

export {
  addDestinationGuard,
  type DestinationGuardFn,
  type DestinationGuardCtx,
  type DestinationGuardResult,
} from './destination-guards.js';

export {
  registerMultiChannelAdapter,
  type MultiChannelFactory,
  type MultiChannelRegistration,
} from './channel-multi.js';

// Channel adapter surface for plugins that build their own adapters at runtime
// (e.g. Optimus' workspace-credential-driven multi-instance Discord/Telegram).
// Hosts that just want the upstream env-singleton channels do not need these.
export {
  registerChannelAdapter,
  unregisterChannelAdapter,
  addChannelAdapterAtRuntime,
  getActiveAdapters,
  getChannelAdapter,
  getChannelAdapterExact,
  getVerbatimDelivery,
  getRegisteredChannelNames,
} from '../channels/channel-registry.js';
export {
  createChatSdkBridge,
  splitForLimit,
  type ChatSdkBridgeConfig,
  type ReplyContext,
  type ReplyContextExtractor,
} from '../channels/chat-sdk-bridge.js';
export type {
  ChannelAdapter,
  VerbatimProfile,
  VerbatimDelivery,
  ChannelRegistration,
  ChannelSetup,
  ChannelReconnectInfo,
  InboundMessage,
  InboundEvent,
  OutboundMessage,
  ConversationInfo,
  DeliveryAddress,
} from '../channels/adapter.js';

// Support utilities for out-of-tree channel adapters (channel plugins that
// live in the embedding host rather than src/channels/). A host that ships
// its own ChannelAdapter — e.g. Optimus' WhatsApp/Baileys plugin — needs the
// same primitives the in-tree adapters use: emit lifecycle events for host
// indexers, read the channel's env block, sanitize attachment filenames, and
// normalize interactive-question options. Re-exported so the plugin imports
// them via 'nanoclaw/engine' instead of reaching into engine internals.
export { emitEngineEvent } from './events.js';
export { readEnvFile } from '../env.js';
export { isSafeAttachmentName } from '../attachment-safety.js';
export { normalizeOptions, type NormalizedOption } from '../channels/ask-question.js';

export {
  registerPluginMigrations,
  applyPluginMigrations,
  getReadDal,
  type PluginMigration,
  type ReadDal,
} from './db-extensions.js';

// Delivery adapter accessor for plugins that need to send out-of-band
// messages (pause notices, system warnings, etc.) via the same adapter
// the engine uses for normal outbound. Read-only — plugins can't replace
// the adapter, only call deliver/setTyping on it.
export { getDeliveryAdapter, type ChannelDeliveryAdapter } from '../delivery.js';

// Mid-turn stop for host plugins: drop a session's queued outbound
// (suppressor), wait out an in-flight send and drain once (settle), and end
// the session's runtime (killContainer: graceful stop, then SIGKILL after the
// stop grace).
export {
  registerOutboundSuppressor,
  settleSessionDelivery,
  dropSuppressedOutbound,
  type OutboundSuppressor,
} from '../delivery.js';
export { killContainer, isContainerRunning, type KillContainerOptions } from '../container-runner.js';
export {
  ChannelUnavailableError,
  isChannelUnavailableError,
  CHANNEL_UNAVAILABLE,
} from '../channels/channel-unavailable.js';

// System-action registry for plugins that handle container-emitted
// `kind: 'system'` outbound messages (e.g. escalate_to_dev_agent,
// schedule_task). The handler runs in the host with the session row
// + inbound DB handle so it can write follow-up state without the
// container touching inbound.db directly.
export { registerDeliveryAction, type DeliveryActionContext, type DeliveryActionHandler } from '../delivery.js';
export { unguarded, type Unguarded } from '../guard/index.js';

// Session mailbox paths remain available for host-side file placement (for
// example generated media beside a session). Mailbox reads/writes themselves
// go through the semantic async seam; raw SQLite handles are implementation
// details of the built-in mailbox driver. inbound.db lives in the read-only
// `mailbox/` folder (legacyInboundDbPath: the pre-migration spot, directly in
// the container-writable session folder); use sessionMailboxDir for the
// session folder itself. Readers must open these without following a link:
// openInboundReadonlyAt does that for either layout; openOutboundReadonlyAt
// for the container-written outbound.db.
export { inboundDbPath, legacyInboundDbPath, outboundDbPath, sessionMailboxDir } from '../mailbox/sqlite/paths.js';
export { openInboundReadonlyAt, openOutboundReadonlyAt } from '../mailbox/sqlite/session-files.js';
export {
  completeInboundDurably,
  withMailboxSession,
  withExistingMailboxSession,
  writeOutboundDirect,
} from '../session-manager.js';
// Session-DB lock waits are short and synchronous; wrap a mailbox session
// whose action is one all-or-nothing host write in retryWhileBusy so a brief
// runner lock neither blocks the event loop nor loses the write.
export { isSqliteBusy, retryWhileBusy } from '../mailbox/sqlite/busy.js';
export type { MailboxSession, TaskUpdate, TaskSeriesSnapshotRecord } from '../mailbox/types.js';
// Agent-group-scoped schedule store (the S405 structural fix — task
// series now live in a host-only schedule.db, not a session inbound.db).
// Plugins that seed/own a recurring series (Optimus maintenance/dream
// task) drive it through this surface instead of insertTask.
export {
  openScheduleDb,
  scheduleDbPath,
  upsertSeries,
  hasSeries,
  cancelSeries,
  pauseSeries,
  resumeSeries,
  updateSeries,
  listLiveSeries,
  getDueSeries,
  type TaskSeriesRow,
  type SeriesUpdate,
  type SeriesStatus,
} from '../modules/scheduling/schedule-store.js';

// Host-side video processing. The engine already runs this internally on
// inbound video *attachments* (session-manager.extractAttachmentFiles).
// Re-exported so a host plugin can feed it a video fetched from a *URL*
// (the Optimus watch-video plugin: yt-dlp → processVideo) and reuse the
// single ffmpeg-frames + Gemini transcript/summary implementation rather
// than forking a second copy host-side.
export {
  processVideo,
  formatVideoMarker,
  type ProcessVideoOpts,
  type ProcessVideoResult,
  type ProcessVideoFrame,
  type VideoTranscriptStatus,
} from '../media/video.js';

// Messaging group queries for plugins that need to enumerate which
// platforms the host owns (e.g. channel-bots driving startup-time
// recoverMissedMessages over every wired chat). Read-only — write
// surface stays inside the router/setup paths.
export { getMessagingGroup, getMessagingGroupsByChannel } from '../db/messaging-groups.js';
export type { MessagingGroup } from '../types.js';

// Session row passed to delivery-action handlers via DeliveryActionHandler's
// second arg. Re-exporting the type here so plugin handler signatures can
// declare it directly without reaching into engine internals.
export type { Session } from '../types.js';

// Cross-group sharing — host registers a resolver that, given an agent
// group (typically a DM), returns the workspace-public groups whose
// memory + identity should be RO-mounted into the spawning container.
// See shared-groups.ts for the full contract.
export { setSharedGroupsResolver, type SharedGroupsResolver, type SharedGroupRef } from '../shared-groups.js';

// ─── Migration writers (host-side seed surface) ─────────────────────────
//
// Hosts that need to seed central + per-session state from a foreign source
// (Optimus' v1 → v2 importer) reuse the same library functions migrate-v2.sh
// drives. The writer surface stays narrow — only the constructors/getters
// migrate-v2 itself touches, plus the connection + migration primitives.
// Internals like update/delete helpers stay private; if a host needs them,
// add the export deliberately here, don't widen by reaching into '../db/...'.
//
// Read-only convenience getters are co-located so an importer that reuses
// these can stay in one engine import block.

export { initDb, closeDb } from '../db/connection.js';
export { runMigrations } from '../db/migrations/index.js';
export { createAgentGroup, getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../db/agent-groups.js';
export {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupsByAgentGroup,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
export type { AgentGroup } from '../types.js';
export type { MessagingGroupAgent } from '../types.js';
export type { ContainerConfigRow } from '../types.js';

// Container-config + media-pipeline primitives for out-of-tree channel
// plugins. The WhatsApp plugin reads per-group assistant-name/prefix
// (getContainerConfig + configFromDb) for shared-number prefixing, and
// resizes/transcodes inbound media (image-processing) before handing
// attachments to the engine. image-processing also has an in-tree consumer
// (chat-sdk-bridge), so it stays in the submodule and is re-exported here.
export { getContainerConfig } from '../db/container-configs.js';
export { configFromDb, type ContainerConfig } from '../container-config.js';
export { maybeResizeImage, shouldTranscodeAnimated, maybeTranscodeAnimated } from '../media/image-processing.js';

// Session lifecycle for importers seeding cold sessions (writes routing +
// initializes per-session DBs). Hosts that want to enqueue messages into an
// existing session should keep using the higher-level router instead.
//
// Exception: `writeSessionMessage` is exposed for deep-backfill plugins
// (e.g. discord_channel_history) that need to inject historical messages
// directly with `trigger: 0`. Backfill volumes (potentially tens of
// thousands of rows) make the engine's full per-message wake/access-gate
// evaluation excessive; direct write keeps the cost linear in row count.
// The `isBackfill` flag on InboundEvent remains the safety net for the
// `adapter.onInbound → routeInbound` path where engagement evaluation
// still runs.
export {
  resolveSession,
  writeSessionMessage,
  writeSessionMessageOnce,
  writeSessionRouting,
} from '../session-manager.js';

// Inbound entrypoint for hosts that synthesize events from non-channel
// sources (e.g. dashboard-driven trigger fires). Constructs an
// `InboundEvent` with channelType/platformId pointing at an existing
// wired `messaging_group` and routes it through the normal router —
// sender resolution, access gate, session resolution, write, wake all
// run identically to a real chat message.
export { routeInbound } from '../router.js';

// Sensitive-action gate (Phase 1, v6/v7). The dashboard-server MCP
// preHandler can't call requestConfirmation directly (separate process,
// no engine link, adapter+registry engine-only — spike-verified). It
// forwards every tools/call to the optimus dashboard-bridge, which calls
// decideSensitiveGate() here, in-process with the engine, so the actor-id
// namespacing, the (session,actor) grant check, and the policy all have
// one source of truth (zero drift vs clicker-auth — the reason for the
// bridge-decides seam). See modules/approvals/sensitive-gate.ts and
// knowledge/projects/sensitive-action-approvals.md.
export {
  decideSensitiveGate,
  // The single source of actor-id namespacing — a host plugin that mints
  // its own self-confirm card MUST namespace the raw platform sender id
  // with this before passing it to requestConfirmation, or clicker-auth
  // (which compares the namespaced clicker id) rejects the actor's own
  // Confirm.
  namespaceActorId,
  parseCallClassification,
  type CallClassification,
  type SensitiveGateInput,
  type SensitiveGateDecision,
} from '../modules/approvals/sensitive-gate.js';

// Self-confirmation primitive + approval-handler registry, for host plugins
// that drive their own in-channel approval flows (e.g. auto-escalation's
// owner approval). Engine-side because the delivery adapter + response
// registry live here. See knowledge/projects/sensitive-action-approvals.md.
export {
  requestApproval,
  requestConfirmation,
  registerApprovalHandler,
  notifyAgent,
  type RequestApprovalOptions,
  type RequestConfirmationOptions,
  type ApprovalHandlerContext,
} from '../modules/approvals/primitive.js';
// Owner/admin role reads. Re-exported so a host plugin can target the
// install owner specifically (e.g. the auto-escalation gate, which must
// route approval to the owner rather than the standard pickApprover
// precedence that also includes group admins).
export { getOwners, getGlobalAdmins } from '../modules/permissions/db/user-roles.js';
// Read-only caller-to-DM evidence; unlike ensureUserDm, never opens a DM.
export { getUserDm } from '../modules/permissions/db/user-dms.js';
// Host fallback for a channel-registration card no approver could receive.
export {
  setChannelApprovalUndeliverableHandler,
  type ChannelApprovalUndeliverable,
} from '../modules/permissions/channel-approval.js';
export type { UserRole } from '../types.js';

export { addSpawnAdmissionGuard, type SpawnAdmissionGuard } from './spawn-admission.js';

export { addTaskMaterializationGuard, type TaskMaterializationGuard } from './task-materialization.js';
