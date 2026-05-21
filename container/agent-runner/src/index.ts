/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { runCliQuery } from './cli-runner.js';
import { runInteractiveQuery, cleanupInteractiveResources } from './interactive-cli-runner.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  /** CLI 执行模式：sdk（默认）| print | interactive */
  cliMode?: 'sdk' | 'print' | 'interactive';
  modelOverride?: {
    model?: string;
    thinking?: 'adaptive' | 'disabled';
  };
  workspacePaths: {
    group: string;
    queryCwd?: string;
    project?: string;
    global?: string;
    ipc: string;
    extra?: string;
  };
}

interface ContainerOutput {
  status: 'success' | 'error' | 'progress';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** progress 消息的子类型 */
  progressType?: 'tool_use' | 'tool_result' | 'thinking' | 'text';
  /** 可折叠面板的展开内容（markdown 格式） */
  detail?: string;
  /** token 用量（仅 result 消息） */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    numTurns: number;
    durationMs: number;
    totalCostUsd: number;
    /** 各模型的实际 context window 大小（tokens），key 为模型名 */
    modelContextWindows?: Record<string, number>;
    model?: string;
  };
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_POLL_MS = 500;

// 工作目录路径 — 在 stdin 解析后初始化
let PATHS: {
  group: string;
  queryCwd?: string;
  project?: string;
  global?: string;
  ipc: string;
  extra?: string;
  ipcInput: string;
  ipcClose: string;
  conversations: string;
  globalClaudeMd?: string;
};

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = PATHS.conversations;
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

/**
 * CLI 模式对话归档 — 退出时将累积的对话写入 conversations/
 */
function archiveCliTranscript(messages: ParsedMessage[], assistantName?: string): void {
  if (messages.length === 0) {
    log('[cli-archive] No messages to archive');
    return;
  }

  try {
    const conversationsDir = PATHS.conversations;
    fs.mkdirSync(conversationsDir, { recursive: true });

    // 从第一条用户消息提取摘要（取前 80 字符）
    const firstUserMsg = messages.find(m => m.role === 'user');
    const summary = firstUserMsg
      ? firstUserMsg.content.slice(0, 80).replace(/\n/g, ' ').trim()
      : null;
    const name = summary ? sanitizeFilename(summary) : generateFallbackName();

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
    fs.writeFileSync(filePath, markdown);
    log(`[cli-archive] Archived ${messages.length} messages to ${filePath}`);
  } catch (err) {
    log(`[cli-archive] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Interactive 模式增量归档 — 每轮查询结束后追加写入，不依赖进程退出
 * 每天一个文件，按日期命名，追加写入当轮的用户消息和助手回复
 */
function appendInteractiveTranscript(
  userMsg: string,
  assistantMsg: string | null,
  assistantName?: string,
): void {
  try {
    const conversationsDir = PATHS.conversations;
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-interactive.md`;
    const filePath = path.join(conversationsDir, filename);

    const exists = fs.existsSync(filePath);
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const name = assistantName || '二狗';

    let content = '';
    if (!exists) {
      content += `# Interactive 对话记录 — ${date}\n\n`;
    }
    content += `---\n\n**[${now}]**\n\n`;
    content += `**User**: ${userMsg.slice(0, 2000)}\n\n`;
    if (assistantMsg) {
      content += `**${name}**: ${assistantMsg.slice(0, 5000)}\n\n`;
    }

    fs.appendFileSync(filePath, content);
    log(`[cli-archive] Appended interactive turn to ${filename}`);
  } catch (err) {
    log(`[cli-archive] Append failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sanitizeFilename(summary: string): string {
  const sanitized = summary
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿㐀-䶿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return sanitized || generateFallbackName();
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(PATHS.ipcClose)) {
    try {
      fs.unlinkSync(PATHS.ipcClose);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

// 动态 context 类型（与宿主侧 MessageContext 一致）
interface WikiMatch {
  title: string;
  path: string;
  snippet: string;
}

interface FactMatch {
  content: string;
  category: string;
  confidence: number;
}

interface MessageContext {
  wiki: WikiMatch[];
  facts: FactMatch[];
}

interface IpcMessage {
  text: string;
  modelOverride?: { model?: string; thinking?: 'adaptive' | 'disabled' };
  context?: MessageContext | null;
}

/**
 * 将 MessageContext 格式化为 <context> XML 块
 */
function formatContext(ctx: MessageContext): string {
  const parts: string[] = ['<context>'];
  if (ctx.wiki?.length) {
    parts.push('Wiki 相关条目:');
    for (const w of ctx.wiki) {
      parts.push(`  - [${w.title}](${w.path}) — ${w.snippet}`);
    }
  }
  if (ctx.facts?.length) {
    parts.push('记忆召回:');
    for (const f of ctx.facts) {
      parts.push(`  - [${f.category} | ${f.confidence.toFixed(2)}] ${f.content}`);
    }
  }
  parts.push('</context>');
  return parts.join('\n');
}

/**
 * 判断 context 是否有效（非空且有实际条目）
 */
function hasValidContext(ctx: MessageContext | null | undefined): ctx is MessageContext {
  if (!ctx) return false;
  return (ctx.wiki?.length > 0) || (ctx.facts?.length > 0);
}

/**
 * 将 context prepend 到消息文本前
 */
function prependContext(text: string, ctx: MessageContext | null | undefined): string {
  if (!hasValidContext(ctx)) return text;
  return formatContext(ctx) + '\n\n' + text;
}

/**
 * Drain all pending IPC input messages.
 */
function drainIpcInput(): IpcMessage[] {
  try {
    fs.mkdirSync(PATHS.ipcInput, { recursive: true });
    const files = fs
      .readdirSync(PATHS.ipcInput)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: IpcMessage[] = [];
    for (const file of files) {
      const filePath = path.join(PATHS.ipcInput, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push({
            text: data.text,
            modelOverride: data.modelOverride,
            context: data.context || null,
          });
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 */
function waitForIpcMessage(): Promise<IpcMessage | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        // 合并多条消息文本，modelOverride + context 取最后一条的
        const last = messages[messages.length - 1];
        const combined: IpcMessage = {
          text: messages.map(m => m.text).join('\n'),
          modelOverride: last.modelOverride,
          context: last.context || null,
        };
        if (hasValidContext(combined.context)) {
          log(`Combined ${messages.length} msgs, context from last (wiki=${combined.context!.wiki.length} facts=${combined.context!.facts.length})`);
        }
        resolve(combined);
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  // q 引用在 query() 创建后赋值，pollIpc 中用于 setModel
  let queryRef: Awaited<ReturnType<typeof query>> | null = null;

  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const msg of messages) {
      log(`Piping IPC message into active query (${msg.text.length} chars)${msg.modelOverride ? ` modelOverride=${JSON.stringify(msg.modelOverride)}` : ''}`);
      // 在 push 消息前切模型（stream.push 后 SDK 会立即开始处理）
      if (queryRef) {
        const targetModel = msg.modelOverride?.model || defaultModel;
        queryRef.setModel(targetModel).then(() => {
          log(`[model-override] piped setModel(${targetModel})${msg.modelOverride?.model ? ' (override)' : ' (default)'}`);
        }).catch((err: unknown) => {
          log(`[model-override] piped setModel FAILED: ${err instanceof Error ? err.message : String(err)}`);
        });
        if (msg.modelOverride?.thinking === 'disabled') {
          (queryRef as any).applyFlagSettings({ thinking: { type: 'disabled' } } as Record<string, unknown>).then(() => {
            log('[model-override] piped thinking disabled (applyFlagSettings)');
          }).catch(() => {});
        } else {
          (queryRef as any).applyFlagSettings({ thinking: { type: 'adaptive' } } as Record<string, unknown>).then(() => {
            log('[model-override] piped thinking adaptive (applyFlagSettings)');
          }).catch(() => {});
        }
      }
      const pushText = prependContext(msg.text, msg.context);
      if (hasValidContext(msg.context)) {
        log(`Piping with context: wiki=${msg.context!.wiki.length} facts=${msg.context!.facts.length}`);
      }
      stream.push(pushText);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let lastAssistantModel: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let lastAssistantUsage: { inputTokens: number; outputTokens: number } | undefined;

  // 💬 事件驱动去重：缓存当前 assistant message 的最后一段 text block，等下一个 message 决定命运
  //
  // 背景：assistant message.content 数组里有两种"非工具调用"块：
  //   - block.type === 'text'     → 模型给用户看的回复内容（含工具调用之间的叙述性文字）
  //   - block.type === 'thinking' → 模型内部独白（reasoning），accumulateSseEvent 不累积
  //
  // 这里缓存的全是 text block — 历史变量名叫 pendingThought 是误导，实际语义是
  // "可能是中间叙述也可能是最终回复的一段文本"。决策时机（按到达顺序优先级）：
  //   1. 下一个 message.type === 'user'（tool_result）→ flushPendingThought
  //      （前面的 text 一定是中间叙述，因为后面还有工具执行）
  //   2. 下一个 message.type === 'result' 且文本完全相等 → drop
  //      （这段就是最终回复，会通过正式回复路径发送，不重复）
  //   3. 下一个 message.type === 'result' 且文本不等 → flushPendingThought
  //      （罕见：result 跟最后一段 text 不一致，至少把 text 发出来）
  //   4. 30s 兜底 timer → flushPendingThought
  //      （仅 abort/error/SDK 异常退出会触发，避免 pending text 永远沉默）
  //
  // ⚠️ 历史教训（ea21e58 引入的 bug）：曾用 isSdkMode 把 SDK 模式整段抑制并打 progressType='thinking'，
  //   主进程 shouldFilterProgress('thinking') 又过滤一次 — 双重抑制导致用户完全看不到
  //   agent 中间的叙述文字。现修复：统一发 progressType='text'，飞书 channel 通过 💬 emoji
  //   走"独立消息、不进进度卡片"路径（feishu.ts handleProgress）。
  //
  // ⚠️ 不要回退成 500ms 时间窗口去重（旧实现）：SDK 事件循环偶尔延迟 > 500ms 时会让中间 text
  //   先 emit progress 再 emit 最终 result，导致重复（Codex review 提出的 race condition）。
  let pendingThought: { text: string; short: string; detail: string | undefined; timer: ReturnType<typeof setTimeout> } | null = null;
  const flushPendingThought = () => {
    if (pendingThought) {
      log(`[text-block] flush → emit 💬 progress (len=${pendingThought.text.length}, short="${pendingThought.short}")`);
      writeOutput({
        status: 'progress',
        result: `💬 ${pendingThought.short}`,
        progressType: 'text',
        detail: pendingThought.detail,
        newSessionId: undefined,
      });
      pendingThought = null;
    }
  };

  // Load global context files: SOUL.md (persona), TOOLS.md (tool guidance), CLAUDE.md (other)
  const globalDir = PATHS.global;
  const contextParts: string[] = [];

  // SOUL.md — 人设和行为规范，最高优先级
  const soulPath = globalDir ? path.join(globalDir, 'SOUL.md') : undefined;
  if (soulPath && fs.existsSync(soulPath)) {
    const soulContent = fs.readFileSync(soulPath, 'utf-8');
    contextParts.push(
      'IMPORTANT: The following SOUL.md defines your persona, tone, and behavioral rules. You MUST embody its persona strictly. Follow its guidance unless higher-priority safety instructions override it.\n\n' +
      soulContent,
    );
  }

  // TOOLS.md — 工具使用指南
  const toolsPath = globalDir ? path.join(globalDir, 'TOOLS.md') : undefined;
  if (toolsPath && fs.existsSync(toolsPath)) {
    const toolsContent = fs.readFileSync(toolsPath, 'utf-8');
    contextParts.push(
      'The following TOOLS.md provides tool usage guidance. It does not control tool availability; it is user guidance on how to use tools effectively.\n\n' +
      toolsContent,
    );
  }

  // CLAUDE.md — 其他全局配置（记忆、Wiki 等）
  const globalClaudeMdPath = PATHS.globalClaudeMd;
  if (globalClaudeMdPath && fs.existsSync(globalClaudeMdPath)) {
    contextParts.push(fs.readFileSync(globalClaudeMdPath, 'utf-8'));
  }

  const globalClaudeMd = contextParts.length > 0 ? contextParts.join('\n\n---\n\n') : undefined;

  // Discover additional directories at extra workspace path
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = PATHS.extra;
  if (extraBase && fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const queryStartTime = Date.now();
  const override = containerInput.modelOverride;
  const resolvedCliPath = path.resolve(
    process.env.AGENT_RUNNER_DIR || '.',
    'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js',
  );
  log(`[query-start] sessionId=${sessionId || 'new'}, resumeAt=${resumeAt || 'latest'}, modelOverride=${override ? JSON.stringify(override) : 'none'}`);
  log(`[query-start] AGENT_RUNNER_DIR=${process.env.AGENT_RUNNER_DIR}, cliPath=${resolvedCliPath}, exists=${fs.existsSync(resolvedCliPath)}`);
  // 日志：显示当前 proxy 用的 access token 前缀（用于验证 per-group 账号隔离）
  const proxyUrl = process.env.HTTPS_PROXY || '';
  const tokenMatch = proxyUrl.match(/x:([^@]{8})/);
  log(`[account] proxy_token_prefix=${tokenMatch?.[1] || '(none)'}, group=${containerInput.groupFolder}`);

  const q = query({
    prompt: stream,
    options: {
      pathToClaudeCodeExecutable: resolvedCliPath,
      executable: 'node' as const,  // 显式指定用 node 运行 cli.js
      stderr: (data: string) => log(`[cli-stderr] ${data.trim()}`),
      cwd: PATHS.queryCwd || PATHS.group,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
          }
        : undefined,
      allowedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],  // 不读 ~/.claude.json，防止全局 MCP 污染
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            NANOCLAW_IPC_DIR: PATHS.ipc,
          },
        },
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
    },
  });
  queryRef = q; // pollIpcDuringQuery 用于 setModel

  // 应用模型/思考覆盖：有 override → 切换；无 override → 用 settings.json 默认模型显式恢复
  // 读取 settings.json 中的默认模型（setModel(undefined) 可能不可靠）
  let defaultModel = 'claude-opus-4-6';
  try {
    const settingsPath = path.join(PATHS.group, '..', '..', 'data', 'sessions', containerInput.groupFolder, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.model) defaultModel = settings.model;
    }
  } catch { /* 使用硬编码默认值 */ }

  const targetModel = override?.model || defaultModel;
  try {
    log(`[model-override] calling setModel(${targetModel})...`);
    await q.setModel(targetModel);
    log(`[model-override] setModel(${targetModel}) done${override?.model ? ' (override)' : ' (default)'}`);
  } catch (err) {
    log(`[model-override] setModel FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (override?.thinking === 'disabled') {
      log('[model-override] applying thinking: disabled...');
      await (q as any).applyFlagSettings({ thinking: { type: 'disabled' } } as Record<string, unknown>);
      log('[model-override] thinking disabled');
    } else {
      log('[model-override] applying thinking: adaptive...');
      await (q as any).applyFlagSettings({ thinking: { type: 'adaptive' } } as Record<string, unknown>);
      log('[model-override] thinking adaptive');
    }
  } catch (err) {
    log(`[model-override] applyFlagSettings FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
  for await (const message of q) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    const elapsed = ((Date.now() - queryStartTime) / 1000).toFixed(1);
    log(`[msg #${messageCount}] type=${msgType} +${elapsed}s`);

    // API 重试事件
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
      const retry = message as { attempt?: number; max_retries?: number; retry_delay_ms?: number; error_status?: number | null; error?: string };
      log(`[api_retry] attempt=${retry.attempt}/${retry.max_retries} delay=${retry.retry_delay_ms}ms status=${retry.error_status} error=${retry.error || 'unknown'}`);
    }

    // 流式事件（大量，只记类型）
    if (message.type === 'stream_event') {
      const se = message as { event?: { type?: string } };
      log(`[stream_event] event_type=${se.event?.type || 'unknown'}`);
    }

    // 认证状态
    if (message.type === 'auth_status') {
      const auth = message as { isAuthenticating?: boolean; error?: string };
      log(`[auth_status] authenticating=${auth.isAuthenticating} error=${auth.error || 'none'}`);
    }

    // 限流事件
    if (message.type === 'rate_limit_event') {
      const rl = message as Record<string, unknown>;
      log(`[rate_limit] ${JSON.stringify(rl).slice(0, 200)}`);
    }

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    // 记录最后一次 assistant 消息的 model 和 usage
    if (message.type === 'assistant') {
      const raw = message as Record<string, unknown>;
      const innerMsg = raw.message as Record<string, unknown> | undefined;
      // BetaMessage.model 是实际 API 调用使用的模型名
      const assistantModel = innerMsg?.model as string | undefined;
      if (assistantModel) {
        lastAssistantModel = assistantModel;
      }
      // 打印 assistant 消息顶层和 inner 的所有 key，定位 usage 字段位置
      // SDK assistant 消息的 usage 在 message.message.usage
      const rawMsgUsage = innerMsg?.usage as Record<string, number> | undefined;
      if (rawMsgUsage) {
        // Anthropic API 的 input_tokens 只是新增（非缓存）部分
        // 完整 context = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
        const totalContext =
          (rawMsgUsage.input_tokens ?? 0) +
          (rawMsgUsage.cache_creation_input_tokens ?? 0) +
          (rawMsgUsage.cache_read_input_tokens ?? 0);
        const outputT = rawMsgUsage.output_tokens ?? 0;
        lastAssistantUsage = { inputTokens: totalContext, outputTokens: outputT };
      }
    }

    // 工具调用进度输出 — 让宿主机能显示进度卡片
    if (message.type === 'assistant') {
      const msg = message as Record<string, unknown>;
      const innerMsg = msg.message as Record<string, unknown> | undefined;
      const innerContent = innerMsg?.content as Array<{ type: string; name?: string; input?: unknown; text?: string }> | undefined;
      const outerContent = msg.content as Array<{ type: string; name?: string; input?: unknown; text?: string }> | undefined;
      const content = innerContent || outerContent;
      log(`[assistant] innerKeys=${innerMsg ? Object.keys(innerMsg).join(',') : 'N/A'}, contentTypes=${Array.isArray(content) ? content.map(b => b.type).join(',') : 'none'}`);
      if (Array.isArray(content)) {
        for (const block of content) {
          // 工具调用 — 提取工具名、输入摘要、详情
          if (block.type === 'tool_use' && block.name) {
            const input = block.input as Record<string, unknown> | null;
            const emoji = block.name === 'Bash' ? '🔧' :
                          block.name === 'Read' ? '📖' :
                          block.name === 'Write' || block.name === 'Edit' ? '✏️' :
                          block.name === 'Grep' ? '🔍' :
                          block.name === 'Glob' ? '📋' :
                          block.name === 'WebSearch' ? '🌐' :
                          block.name === 'WebFetch' ? '🌐' :
                          block.name === 'ListDir' ? '📋' : '⚙️';
            const inputStr = input
              ? (input.command as string || input.file_path as string || input.query as string || input.pattern as string || block.name)
              : block.name;
            const shortInput = typeof inputStr === 'string' ? inputStr.slice(0, 60) : block.name;

            let detail: string | undefined;
            if (input) {
              if (block.name === 'Edit' && input.old_string && input.new_string) {
                const file = (input.file_path as string || '').split('/').pop() || 'file';
                const oldLines = (input.old_string as string).slice(0, 300).split('\n').map((l: string) => `- ${l}`).join('\n');
                const newLines = (input.new_string as string).slice(0, 300).split('\n').map((l: string) => `+ ${l}`).join('\n');
                detail = `**${file}**\n${oldLines}\n${newLines}`;
              } else if (block.name === 'Bash' && input.command) {
                detail = `\`\`\`bash\n${(input.command as string).slice(0, 500)}\n\`\`\``;
              } else if (block.name === 'Write' && input.file_path) {
                const c = (input.content as string || '').slice(0, 300);
                detail = `**${input.file_path}**\n\`\`\`\n${c}${c.length >= 300 ? '\n...' : ''}\n\`\`\``;
              }
            }

            writeOutput({
              status: 'progress',
              result: `${emoji} ${block.name}: ${shortInput}`,
              progressType: 'tool_use',
              detail,
              newSessionId: undefined,
            });
          }

          // assistant text block → 💬 中间消息（不加入进度卡片，走 feishu 独立消息路径）
          // 事件驱动去重：tool_result 到达即 flush（中间叙述）；result 到达即 drop（已含在最终回复）
          if (block.type === 'text' && block.text) {
            // 剥掉 <internal> 标签后判断是否有可见内容；纯 internal 文本不缓存
            // 避免与 result 文本匹配导致 dedup 误杀合法回复
            const stripped = block.text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
            log(`[text-block] received (raw_len=${block.text.length}, stripped_len=${stripped.length})`);
            if (stripped.length > 5) {
              // 先 flush 之前缓存的（如果有的话）— 同一个 message 可能有多段 text
              flushPendingThought();
              // 用剥掉 internal 标签后的可见文本做缓存
              const short = stripped.slice(0, 80) + (stripped.length > 80 ? '...' : '');
              log(`[text-block] cached pending (will flush on tool_result, drop on result, or 30s fallback): "${short}"`);
              // timer 30s 仅作 fallback —— 正常路径下 tool_result message 或 result message
              // 到达时会主动 flush/dedup。timer 触发说明流被中断（abort/error/SDK 异常退出），
              // 此时 pending 的 text 也应该 emit 让用户看到（否则永远沉默）。
              // ⚠️ runQuery finally 中会 clearTimeout + 清空 pendingThought 防止跨会话泄漏
              pendingThought = {
                text: stripped,
                short,
                detail: stripped.length > 80 ? stripped : undefined,
                timer: setTimeout(flushPendingThought, 30_000),
              };
            }
          }
        }
      }
    }

    // 工具执行结果 — 从 user 消息的 content 中提取 tool_result
    if (message.type === 'user') {
      // 关键去重：tool_result message 到达 → 前面 pending 的 text 必然是中间叙述（不是最终回复），
      // 主动 flush 比等 500ms timer 更稳健。否则 result message 若延迟到达 > 500ms 会和 text
      // 双发（Codex review 指出的 race）。timer 仍保留作为 fallback（中断/error 不会泄漏）。
      if (pendingThought) {
        log('[text-block] tool_result arrived → flush pending text (it is interim narration, not final)');
        clearTimeout(pendingThought.timer);
        flushPendingThought();
      }
      const userMsg = message as { message?: { content?: unknown[] } };
      const content = userMsg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; content?: unknown };
          if (b.type === 'tool_result' && b.content) {
            let resultText = '';
            if (typeof b.content === 'string') {
              resultText = b.content;
            } else if (Array.isArray(b.content)) {
              resultText = (b.content as Array<{ type?: string; text?: string }>)
                .filter(c => c.type === 'text' && c.text)
                .map(c => c.text!)
                .join('\n');
            }
            if (resultText && resultText.trim().length > 0) {
              const short = resultText.trim().slice(0, 60) + (resultText.trim().length > 60 ? '...' : '');
              writeOutput({
                status: 'progress',
                result: `✅ 结果: ${short}`,
                progressType: 'tool_result',
                detail: resultText.trim().length > 60 ? resultText.trim().slice(0, 1000) : undefined,
                newSessionId: undefined,
              });
            }
          }
        }
      }
    }

    // 工具调用摘要
    if (message.type === 'tool_use_summary') {
      const summary = (message as { summary?: string }).summary;
      if (summary) {
        writeOutput({
          status: 'progress',
          result: `📊 ${summary.slice(0, 80)}`,
          progressType: 'tool_result',
          detail: summary.length > 80 ? summary : undefined,
          newSessionId: undefined,
        });
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;

      // 💬 去重：result message 必然包含 SDK 这一轮的最终 assistant 文本（textResult 即正式回复）
      // pendingThought 缓存的"最后一段 text block"会通过正式回复路径发送，drop 避免重复
      // 与 interactive 模式 stop_reason='end_turn' 的 drop 语义对齐
      // 例外：textResult 为空（错误/截断），flush pendingThought 让用户至少看到中间叙述
      if (pendingThought) {
        const hasFinalText = !!textResult && textResult.trim().length > 0;
        if (hasFinalText) {
          log('[text-block] result arrived → drop pending (included in final result)');
          clearTimeout(pendingThought.timer);
          pendingThought = null;
        } else {
          log('[text-block] result is empty/null → flush pending so user sees interim narration');
          clearTimeout(pendingThought.timer);
          flushPendingThought();
        }
      }

      // 提取 token 用量
      const msg = message as Record<string, unknown>;
      const rawUsage = msg.usage as Record<string, number> | undefined;
      // 提取各模型的 contextWindow（SDK 返回 modelUsage: Record<string, ModelUsage>）
      const rawModelUsage = msg.modelUsage as
        | Record<string, { contextWindow?: number }>
        | undefined;
      // 调试：打印 modelUsage 原始内容，确认模型名和 contextWindow 字段
      if (rawModelUsage) {
        log(`[DEBUG] modelUsage keys: ${JSON.stringify(Object.entries(rawModelUsage).map(([k, v]) => ({ model: k, contextWindow: v.contextWindow })))}`);
      } else {
        log('[DEBUG] modelUsage is undefined');
      }
      const modelContextWindows = rawModelUsage
        ? Object.fromEntries(
            Object.entries(rawModelUsage)
              .filter(([, v]) => v.contextWindow != null)
              .map(([k, v]) => [k, v.contextWindow as number]),
          )
        : undefined;
      const usage = rawUsage
        ? {
            inputTokens: rawUsage.input_tokens ?? 0,
            outputTokens: rawUsage.output_tokens ?? 0,
            cacheReadInputTokens: rawUsage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: rawUsage.cache_creation_input_tokens ?? 0,
            numTurns: (msg.num_turns as number) ?? 0,
            durationMs: (msg.duration_ms as number) ?? 0,
            totalCostUsd: (msg.total_cost_usd as number) ?? 0,
            modelContextWindows,
            model: lastAssistantModel || (rawModelUsage ? Object.keys(rawModelUsage).pop() : undefined),
            // lastAssistantUsage.inputTokens 已经是完整 context（input + cache_creation + cache_read）
            lastTurnContext: lastAssistantUsage?.inputTokens,
          }
        : undefined;

      log(
        `[result] #${resultCount} model=${lastAssistantModel || 'unknown'} input=${rawUsage?.input_tokens ?? '?'} output=${rawUsage?.output_tokens ?? '?'} turns=${(msg.num_turns as number) ?? '?'} cost=$${((msg.total_cost_usd as number) ?? 0).toFixed(3)}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
        usage,
      });
    }
  }
  } finally {
    // 防御性清理：无论 for-await 正常结束、throw、还是 SDK 异常退出，
    // 都要清掉 pendingThought 的 timer，否则 30s 后 fallback timer 可能在
    // runQuery 已退出（下一轮 query 可能已开始）的情况下触发 writeOutput，
    // 把上一轮的 💬 串到下一个会话。
    ipcPolling = false;
    if (pendingThought) {
      log('[text-block] runQuery exiting → clear pending timer (avoid cross-session leak)');
      clearTimeout(pendingThought.timer);
      pendingThought = null;
    }
  }
  const totalElapsed = ((Date.now() - queryStartTime) / 1000).toFixed(1);
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, totalTime: ${totalElapsed}s`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);

    // 初始化工作目录路径
    const wp = containerInput.workspacePaths;
    PATHS = {
      group: wp.group,
      queryCwd: wp.queryCwd,
      project: wp.project,
      global: wp.global,
      ipc: wp.ipc,
      extra: wp.extra,
      ipcInput: path.join(wp.ipc, 'input'),
      ipcClose: path.join(wp.ipc, 'input', '_close'),
      conversations: path.join(wp.group, 'conversations'),
      globalClaudeMd: wp.global ? path.join(wp.global, 'CLAUDE.md') : undefined,
    };

    log(`Received input for group: ${containerInput.groupFolder} (cliMode=${containerInput.cliMode || 'sdk'})`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(PATHS.ipcInput, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(PATHS.ipcClose);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.map(m => prependContext(m.text, m.context)).join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // ---- 模式分叉：sdk / print / interactive ----
  const cliMode = containerInput.cliMode || 'sdk';
  log(`[mode] cliMode=${cliMode}`);

  if (cliMode === 'print') {
    log('[mode] print mode — spawning claude --print per turn');

    // 加载全局上下文（SOUL.md + TOOLS.md + CLAUDE.md）用于 --append-system-prompt
    const globalDir = PATHS.global;
    const contextParts: string[] = [];
    const soulPath = globalDir ? path.join(globalDir, 'SOUL.md') : undefined;
    if (soulPath && fs.existsSync(soulPath)) {
      contextParts.push(fs.readFileSync(soulPath, 'utf-8'));
    }
    const toolsPath = globalDir ? path.join(globalDir, 'TOOLS.md') : undefined;
    if (toolsPath && fs.existsSync(toolsPath)) {
      contextParts.push(fs.readFileSync(toolsPath, 'utf-8'));
    }
    const globalClaudeMdPath = PATHS.globalClaudeMd;
    if (globalClaudeMdPath && fs.existsSync(globalClaudeMdPath)) {
      contextParts.push(fs.readFileSync(globalClaudeMdPath, 'utf-8'));
    }
    const systemPromptAppend = contextParts.length > 0 ? contextParts.join('\n\n---\n\n') : undefined;

    // 发现额外目录（与 SDK 模式一致）
    const extraDirs: string[] = [];
    const extraBase = PATHS.extra;
    if (extraBase && fs.existsSync(extraBase)) {
      for (const entry of fs.readdirSync(extraBase)) {
        const fullPath = path.join(extraBase, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          extraDirs.push(fullPath);
        }
      }
    }

    // 累积对话记录，退出时归档到 conversations/
    const cliTranscript: ParsedMessage[] = [];

    try {
      while (true) {
        log(`[cli-mode] Starting CLI query (session: ${sessionId || 'new'})...`);

        // 记录用户消息
        cliTranscript.push({ role: 'user', content: prompt });

        const override = containerInput.modelOverride;
        const cliResult = await runCliQuery(
          {
            prompt,
            sessionId,
            model: override?.model || undefined,
            mcpServerPath,
            chatJid: containerInput.chatJid,
            groupFolder: containerInput.groupFolder,
            isMain: containerInput.isMain,
            ipcDir: PATHS.ipc,
            cwd: PATHS.queryCwd || PATHS.group,
            env: sdkEnv,
            additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
            systemPromptAppend,
          },
          writeOutput,
          log,
        );

        if (cliResult.newSessionId) {
          sessionId = cliResult.newSessionId;
        }

        // 记录助手回复
        if (cliResult.result) {
          cliTranscript.push({ role: 'assistant', content: cliResult.result });
        }

        // 检查 _close 信号
        if (shouldClose()) {
          log('[cli-mode] Close sentinel detected, exiting');
          break;
        }

        // runCliQuery 内部已发送 success result，这里只发 session 更新（result=null 表示仅更新 session）
        if (sessionId && !cliResult.result) {
          writeOutput({ status: 'success', result: null, newSessionId: sessionId });
        }

        log('[cli-mode] Query ended, waiting for next IPC message...');

        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('[cli-mode] Close sentinel received, exiting');
          break;
        }

        log(`[cli-mode] Got new message (${nextMessage.text.length} chars)`);
        prompt = prependContext(nextMessage.text, nextMessage.context);
        if (nextMessage.modelOverride) {
          containerInput.modelOverride = nextMessage.modelOverride;
        } else {
          containerInput.modelOverride = undefined;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`[cli-mode] Agent error: ${errorMessage}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: errorMessage,
      });
      // 即使出错也尝试归档
      archiveCliTranscript(cliTranscript, containerInput.assistantName);
      process.exit(1);
    }

    // 正常退出时归档对话
    archiveCliTranscript(cliTranscript, containerInput.assistantName);
    return;
  }

  if (cliMode === 'interactive') {
    log('[mode] interactive mode — tmux + tap proxy');

    // 加载全局上下文（与 print 模式一致）
    const globalDir = PATHS.global;
    const iContextParts: string[] = [];
    const iSoulPath = globalDir ? path.join(globalDir, 'SOUL.md') : undefined;
    if (iSoulPath && fs.existsSync(iSoulPath)) {
      iContextParts.push(fs.readFileSync(iSoulPath, 'utf-8'));
    }
    const iToolsPath = globalDir ? path.join(globalDir, 'TOOLS.md') : undefined;
    if (iToolsPath && fs.existsSync(iToolsPath)) {
      iContextParts.push(fs.readFileSync(iToolsPath, 'utf-8'));
    }
    const iGlobalClaudeMdPath = PATHS.globalClaudeMd;
    if (iGlobalClaudeMdPath && fs.existsSync(iGlobalClaudeMdPath)) {
      iContextParts.push(fs.readFileSync(iGlobalClaudeMdPath, 'utf-8'));
    }
    const iSystemPromptAppend = iContextParts.length > 0 ? iContextParts.join('\n\n---\n\n') : undefined;

    // 额外目录
    const iExtraDirs: string[] = [];
    const iExtraBase = PATHS.extra;
    if (iExtraBase && fs.existsSync(iExtraBase)) {
      for (const entry of fs.readdirSync(iExtraBase)) {
        const fullPath = path.join(iExtraBase, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          iExtraDirs.push(fullPath);
        }
      }
    }

    // 需要从环境变量中提取 OneCLI 上游代理信息
    const upstreamProxy = sdkEnv.HTTPS_PROXY || sdkEnv.https_proxy || '';
    const upstreamCaCert = sdkEnv.NODE_EXTRA_CA_CERTS
      ? (fs.existsSync(sdkEnv.NODE_EXTRA_CA_CERTS) ? fs.readFileSync(sdkEnv.NODE_EXTRA_CA_CERTS, 'utf-8') : undefined)
      : undefined;

    // credential proxy 模式不需要 OneCLI 上游代理（直接 HTTP 转发到 cli-proxy-api）
    const credentialProxyUrl = sdkEnv.CREDENTIAL_PROXY_URL || process.env.CREDENTIAL_PROXY_URL;
    const credentialProxyKey = sdkEnv.CREDENTIAL_PROXY_API_KEY || process.env.CREDENTIAL_PROXY_API_KEY;
    const hasCredentialProxy = !!(credentialProxyUrl && credentialProxyKey);

    if (!upstreamProxy && !hasCredentialProxy) {
      writeOutput({
        status: 'error',
        result: null,
        error: 'Interactive mode requires HTTPS_PROXY (OneCLI proxy) or CREDENTIAL_PROXY_URL to be configured',
      });
      return;
    }

    // 对话记录
    const iTranscript: ParsedMessage[] = [];

    try {
      while (true) {
        log(`[interactive] Starting query (session: ${sessionId || 'new'})...`);
        iTranscript.push({ role: 'user', content: prompt });

        const override = containerInput.modelOverride;
        // credential proxy 变量已在循环外声明
        const credentialProxy = hasCredentialProxy
          ? { url: credentialProxyUrl!, apiKey: credentialProxyKey! }
          : undefined;
        log(`[interactive] credentialProxy: ${credentialProxy ? credentialProxy.url : 'not configured'} (env: ${credentialProxyUrl || 'N/A'})`);

        const result = await runInteractiveQuery(
          {
            prompt,
            sessionId,
            model: override?.model || undefined,
            mcpServerPath,
            chatJid: containerInput.chatJid,
            groupFolder: containerInput.groupFolder,
            isMain: containerInput.isMain,
            ipcDir: PATHS.ipc,
            cwd: PATHS.queryCwd || PATHS.group,
            env: sdkEnv,
            additionalDirectories: iExtraDirs.length > 0 ? iExtraDirs : undefined,
            systemPromptAppend: iSystemPromptAppend,
            upstreamProxy,
            upstreamCaCert,
            credentialProxy,
          },
          writeOutput,
          log,
        );

        if (result.newSessionId) {
          sessionId = result.newSessionId;
        }

        if (result.result) {
          iTranscript.push({ role: 'assistant', content: result.result });
        }

        // 增量归档：每轮查询结束立即写入磁盘，不依赖进程退出
        appendInteractiveTranscript(prompt, result.result || null, containerInput.assistantName);

        // 检查 _close 信号
        if (shouldClose()) {
          log('[interactive] Close sentinel detected, exiting');
          break;
        }

        if (sessionId && !result.result) {
          writeOutput({ status: 'success', result: null, newSessionId: sessionId });
        }

        log('[interactive] Query ended, waiting for next IPC message...');

        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('[interactive] Close sentinel received, exiting');
          break;
        }

        log(`[interactive] Got new message (${nextMessage.text.length} chars)`);
        prompt = prependContext(nextMessage.text, nextMessage.context);
        if (nextMessage.modelOverride) {
          containerInput.modelOverride = nextMessage.modelOverride;
        } else {
          containerInput.modelOverride = undefined;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`[interactive] Agent error: ${errorMessage}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: errorMessage,
      });
      archiveCliTranscript(iTranscript, containerInput.assistantName);
      await cleanupInteractiveResources(log);
      process.exit(1);
    }

    archiveCliTranscript(iTranscript, containerInput.assistantName);
    await cleanupInteractiveResources(log);
    return;
  }

  // ---- SDK 模式（默认路径） ----
  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.text.length} chars), starting new query`);
      prompt = prependContext(nextMessage.text, nextMessage.context);
      // 应用 IPC 消息中的 modelOverride（下次 runQuery 会用）
      if (nextMessage.modelOverride) {
        containerInput.modelOverride = nextMessage.modelOverride;
        log(`[ipc] modelOverride: ${JSON.stringify(nextMessage.modelOverride)}`);
      } else {
        containerInput.modelOverride = undefined;
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
