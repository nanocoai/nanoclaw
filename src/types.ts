export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

/** CLI 执行模式 */
export type CliMode = 'sdk' | 'print' | 'interactive' | 'codex' | 'gemini';

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  /** CLI 执行模式：sdk（默认）| print（--print spawn）| interactive（tmux + tap proxy）| codex | gemini */
  cliMode?: CliMode;
  /** @deprecated 使用 cliMode: 'print' 替代。向后兼容：useCliMode: true 等同于 cliMode: 'print' */
  useCliMode?: boolean;
  /** 安静模式：LLM 中间文字（💬）进进度卡片而非独立发消息 */
  quietProgress?: boolean;
  /** 最终回复发送后，自动补发一轮简短总结请求 */
  autoFollowupSummary?: boolean;
  /** 语音播报配置：按群独立控制本机 Mac 播报等出口 */
  voiceNotify?: {
    /** 最终回复摘要通过 Pushover 推送到手机/耳机播报 */
    push?: boolean;
    /** @deprecated 早期 Mac 本地播报开关，保留兼容旧配置 */
    mac?: boolean;
    /** 启用 v2 智能摘要：按内容类型（代码/表格/方案/列表/对话）分流不同 prompt，
     *  替代一刀切 120 字压缩。灰度期间按群开关，验证通过后全量 */
    summaryV2?: boolean;
  };
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  customCwd?: string; // Custom cwd for Claude Code query(), set via /cwd command
}

/** Commander 派工任务状态 */
export type DelegationStatus =
  | 'dispatched'
  | 'progress'
  | 'blocked'
  | 'question'
  | 'done'
  | 'failed'
  | 'closed';

/** 子群 report_to_main 允许的状态（dispatched 由派发设、closed 由命令设，不在此列） */
export type ReportStatus =
  | 'progress'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'question';

/** Commander 派工账本一行 */
export interface DelegationTask {
  taskId: string;
  targetGroup: string;
  targetJid: string;
  title?: string;
  status: DelegationStatus;
  summary?: string;
  details?: string;
  artifacts?: string[];
  dispatchMsgId?: string;
  dispatchedAt: string;
  lastReportAt?: string;
  updatedAt: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

/** 任务账本：任务状态 */
export type TaskLedgerStatus =
  | 'draft'
  | 'draft_prd'
  | 'ready'
  | 'effect_locked'
  | 'e2e_defined'
  | 'tests_planned'
  | 'in_progress'
  | 'implementing'
  | 'blocked'
  | 'review'
  | 'testing'
  | 'verifying'
  | 'done'
  | 'cancelled';

/** 任务账本：任务类型 */
export type TaskLedgerType =
  | 'bug'
  | 'feature'
  | 'refactor'
  | 'review'
  | 'e2e'
  | 'research'
  | 'ops'
  | 'other';

/** 任务账本：执行清单状态 */
export type TaskLedgerChecklistStatus =
  | 'todo'
  | 'doing'
  | 'done'
  | 'blocked'
  | 'skipped';

/** 任务账本：测试/验收用例状态 */
export type TaskLedgerTestCaseStatus =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'skipped';

/** 任务账本主任务。用于把“最终效果、验收标准、执行过程”固定成 LLM 可查的结构化事实。 */
export interface TaskLedgerTask {
  id: string;
  title: string;
  project: string;
  task_type: TaskLedgerType;
  status: TaskLedgerStatus;
  priority: string;
  description: string | null;
  desired_outcome: string | null;
  acceptance_criteria: string[];
  owner_group: string;
  chat_jid: string | null;
  created_by: string | null;
  artifact_root: string | null;
  prd_path: string | null;
  spec_path: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskLedgerChecklistItem {
  id: string;
  task_id: string;
  title: string;
  status: TaskLedgerChecklistStatus;
  position: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskLedgerTestCase {
  id: string;
  task_id: string;
  title: string;
  description: string | null;
  status: TaskLedgerTestCaseStatus;
  evidence: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface TaskLedgerEvent {
  id: number;
  task_id: string;
  event_type: string;
  summary: string;
  details: string | null;
  actor_group: string | null;
  actor_sender: string | null;
  created_at: string;
}

export interface TaskLedgerDetail {
  task: TaskLedgerTask;
  checklist: TaskLedgerChecklistItem[];
  test_cases: TaskLedgerTestCase[];
  events: TaskLedgerEvent[];
}

// --- Channel abstraction ---

export interface SendMessageOptions {
  // 命令回复：跳过进度卡片清理等副作用，避免打断正在运行的 agent
  isCommandReply?: boolean;
  // 调用方显式标记为进度消息，不再依赖 emoji 猜测
  isProgress?: boolean;
  // 跳过语音播报推送（如语音回显：用户刚说过的话不要再总结播回去）
  skipVoiceNotify?: boolean;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string | undefined>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: rename the chat/group on the platform.
  renameChat?(jid: string, name: string): Promise<void>;
}

// --- Usage API ---

export interface OAuthCredential {
  secret_name: string;
  refresh_token: string;
  access_token: string | null;
  expires_at: number | null; // Unix timestamp ms
  cached_usage: string | null; // JSON string of RateLimits
  last_usage_check: number | null; // Unix timestamp ms
  error_state: string | null; // null | 'auth' | 'network'
  updated_at: string;
}

export interface RateLimits {
  fiveHourPercent: number;
  weeklyPercent?: number;
  fiveHourResetsAt?: string | null;
  weeklyResetsAt?: string | null;
  sonnetWeeklyPercent?: number;
  sonnetWeeklyResetsAt?: string | null;
  opusWeeklyPercent?: number;
  opusWeeklyResetsAt?: string | null;
}

export interface UsageResult {
  secretName: string;
  rateLimits: RateLimits | null;
  error?: 'auth' | 'network' | 'no_credentials' | 'rate_limited';
  stale?: boolean;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (
  chatJid: string,
  message: NewMessage,
) => void | Promise<void>;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
