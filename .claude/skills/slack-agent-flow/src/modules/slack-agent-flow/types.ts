/**
 * slack-agent-flow shared types.
 * Congruence: env-key shapes mirror the adapter's native SLACK_INSTANCES
 * conventions (src/channels/slack.ts, instanceEnvKeySuffix);
 * broker protocol mirrors src/provisioning/slack-app.ts and
 * .claude/skills/slack-managed-agents/scripts/slack-create-agent.ts. Pinned by
 * provision.congruence.test.ts.
 */

export type SlackFlowStep =
  | 'operator-identity'
  | 'origin-auth'
  | 'no-credentials'
  | 'broker'
  | 'direct-create'
  /** Waiting out a workspace install approval before the bot token exists. */
  | 'install-wait'
  | 'env-write'
  | 'adapter-start'
  | 'dm-open'
  | 'dm-wire'
  | 'mpim-open'
  | 'a2a-env'
  | 'room-wire'
  | 'intro-post'
  /** room-actions module — create_room / add_to_room participant resolution. */
  | 'room-resolve'
  /** slack-room-membership module — join/left handling, not a create_agent flow step. */
  | 'membership';

/** Typed failure for the Slack leg. `message` MUST never contain a token value. */
export class SlackFlowError extends Error {
  constructor(
    readonly step: SlackFlowStep,
    message: string,
  ) {
    super(message);
    this.name = 'SlackFlowError';
  }
}

export interface ProvisionInput {
  /** Instance slug: output of normalizeName(), post-dedupe. */
  slug: string;
  /** Display name for the Slack app/bot (the raw agent name). */
  displayName: string;
  /** Repo root; .env lives at `${rootDir}/.env`. */
  rootDir: string;
  /** Slack workspace the app is provisioned into (broker mode requires it). */
  teamId?: string;
  /** Agent description/instructions — drives the broker's generated avatar. */
  description?: string;
  /**
   * true → plain manifest variant (no agent_view): workspace guests are
   * hard-blocked from agent-enabled apps. Default false → agent mode, the
   * default variant — a one-way door decided at provision time.
   */
  allowGuests?: boolean;
  /**
   * Request-origin metadata, all optional — sent on the broker's
   * POST /v1/apps body only when defined (requested_by / parent_app_id /
   * template on the wire; a broker that predates them ignores unknown body
   * fields). client_version is derived from rootDir's package.json inside
   * provisionSlackApp, not supplied here.
   */
  /** Slack user id (U…/W…) of the human who asked for this agent. */
  requestedBy?: string;
  /** The creating agent's own Slack app id (A…) when an agent created this one. */
  parentAppId?: string;
  /** Template name, when the agent was stamped from one. */
  template?: string;
  /**
   * Called once when the workspace has not approved the app's install and the
   * flow is about to wait for it — `resumed` distinguishes a fresh refusal
   * from picking a parked app back up. Exceptions are swallowed: telling the
   * human is best-effort, the wait happens either way.
   */
  onInstallPending?: (info: { appId: string; installUrl?: string; resumed: boolean }) => void | Promise<void>;
  /** Wait budget for a deferred install. Tests shorten it; callers rarely set it. */
  installWait?: { intervalMs?: number; timeoutMs?: number };
}

export interface ProvisionResult {
  slug: string;
  /** slug.toUpperCase().replace(/-/g, '_') — the .env key suffix. */
  envSuffix: string;
  botToken: string; // xoxb-… NEVER log
  appToken: string; // xapp-… NEVER log
  appId: string;
  /** True when tokens were already in .env and no provisioning call was made. */
  reused: boolean;
  /**
   * True when the bot token arrived only after waiting out a workspace install
   * approval (auto-install was refused). Everything downstream is identical —
   * the flag exists so the completion message can say what happened.
   */
  deferredInstall?: boolean;
}

export interface OrchestrateSuccess {
  slug: string;
  newBotUserId: string;
  operatorUserId: string;
  dmChannelId: string;
  /** Absent when the create ran with room:'none' — no shared room. */
  roomChannelId?: string;
  /** True when the bot only came online after a workspace install approval. */
  deferredInstall?: boolean;
}
