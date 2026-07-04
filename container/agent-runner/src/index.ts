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
import { runCodexQuery } from './codex-runner.js';
import { runGeminiQuery } from './gemini-runner.js';
import {
  runInteractiveQuery,
  cleanupInteractiveResources,
  checkCliHealth,
  shouldEmitInteractiveSessionKeepalive,
} from './interactive-cli-runner.js';
import { buildSendMessageToolEnv } from './mcp-tool-policy.js';
import { readGroupModelSettings } from './model-settings.js';
import { resolveQueryCwdForSession } from './session-cwd.js';
import { isFinalizingOnly } from './finalizing-tools.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  /** 触发用户 ID（飞书 open_id），传给 MCP server 用于记忆读写 */
  senderId?: string;
  /** CLI 执行模式：sdk（默认）| print | interactive | codex | gemini */
  cliMode?: 'sdk' | 'print' | 'interactive' | 'codex' | 'gemini';
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
  /** CLI interactive 模式：终端态错误已污染当前 Claude session，需要提示用户决定是否清理。 */
  terminalSessionCorruption?: boolean;
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
    /** 最后一轮 API 调用的实际 context 大小 */
    lastTurnContext?: number;
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

// 上游用 thinking:'adaptive'|'disabled' 表达「思考意图」，但 4.8 只支持 adaptive thinking，
// 无法真正关闭。控制思考深度的官方杠杆是 effortLevel —— 在 SDK 的 Settings 里生效。
// 这里把意图翻译成 effortLevel：disabled→'low'（最少思考、最快），adaptive→'high'（默认）。
function effortForThinking(thinking: 'adaptive' | 'disabled'): 'low' | 'high' {
  return thinking === 'disabled' ? 'low' : 'high';
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
    } catch (err) {
      log(`[cli-archive] Skip invalid transcript line: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  senderId?: string;
  modelOverride?: { model?: string; thinking?: 'adaptive' | 'disabled' };
  context?: MessageContext | null;
  claimPath?: string;
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
            senderId: typeof data.senderId === 'string' ? data.senderId : undefined,
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
          senderId: last.senderId,
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

function claimNextIpcMessage(): IpcMessage | null {
  try {
    fs.mkdirSync(PATHS.ipcInput, { recursive: true });
    const inflightDir = path.join(PATHS.ipcInput, '.inflight');
    fs.mkdirSync(inflightDir, { recursive: true });

    const files = fs
      .readdirSync(PATHS.ipcInput)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort();

    for (const file of files) {
      const filePath = path.join(PATHS.ipcInput, file);
      const claimPath = path.join(inflightDir, file);
      try {
        fs.renameSync(filePath, claimPath);
      } catch {
        continue;
      }

      try {
        const data = JSON.parse(fs.readFileSync(claimPath, 'utf-8'));
        if (data.type === 'message' && data.text) {
          return {
            text: data.text,
            senderId: typeof data.senderId === 'string' ? data.senderId : undefined,
            modelOverride: data.modelOverride,
            context: data.context || null,
            claimPath,
          };
        }
        fs.unlinkSync(claimPath);
      } catch (err) {
        log(
          `Failed to process claimed IPC file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(claimPath);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    log(`Interactive IPC claim error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function ackClaimedIpcMessages(claimPaths: string[]): void {
  for (const claimPath of claimPaths) {
    try {
      fs.unlinkSync(claimPath);
    } catch {
      /* ignore */
    }
  }
}

function requeueClaimedIpcMessages(claimPaths: string[]): void {
  for (const claimPath of claimPaths) {
    if (!fs.existsSync(claimPath)) continue;
    const targetPath = path.join(PATHS.ipcInput, path.basename(claimPath));
    try {
      fs.renameSync(claimPath, targetPath);
    } catch {
      /* keep inflight for restart recovery */
    }
  }
}

function recoverInflightIpcMessages(): number {
  const inflightDir = path.join(PATHS.ipcInput, '.inflight');
  if (!fs.existsSync(inflightDir)) return 0;

  let recovered = 0;
  for (const file of fs.readdirSync(inflightDir).filter((f) => f.endsWith('.json')).sort()) {
    const claimPath = path.join(inflightDir, file);
    const targetPath = path.join(PATHS.ipcInput, file);
    try {
      if (fs.existsSync(targetPath)) {
        const recoveredName = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${file}`;
        fs.renameSync(claimPath, path.join(PATHS.ipcInput, recoveredName));
      } else {
        fs.renameSync(claimPath, targetPath);
      }
      recovered++;
    } catch {
      /* keep inflight for next recovery attempt */
    }
  }
  return recovered;
}

function waitForInteractiveIpcMessage(): Promise<IpcMessage | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }

      const recovered = recoverInflightIpcMessages();
      if (recovered > 0) {
        log(`[interactive] recovered ${recovered} inflight IPC message(s)`);
      }

      const message = claimNextIpcMessage();
      if (message) {
        resolve(message);
        return;
      }

      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * 计算 additionalDirectories —— 让 nanoclaw 的 CLAUDE.md 跨 cwd 加载。
 * cwd 切到 nine 等额外挂载目录后，nanoclaw 的群记忆/通用指令/根指令不在 cwd 父链上会丢，
 * 这里把它们显式作为 additionalDirectories 注入（cwd 无关兜底）。
 * sdk / print / interactive 三模式共用此逻辑。
 *
 * 注意：cwd 已落在额外挂载目录(如 nine)子树内时，其子目录走 cwd 子树懒加载(conditionalRule)，
 * 不再塞进 additionalDirectories —— 否则会变成全量加载，破坏懒加载意图。
 */
function computeExtraDirs(paths: {
  group: string;
  queryCwd?: string;
  extra?: string;
}): string[] {
  const extraDirs: string[] = [];
  const pushDir = (d?: string) => {
    if (d && fs.existsSync(d) && !extraDirs.includes(d)) extraDirs.push(d);
  };

  const effectiveCwd = paths.queryCwd || paths.group;
  const extraBase = paths.extra;
  const cwdInExtra = !!(
    extraBase && effectiveCwd.startsWith(extraBase + path.sep)
  );
  if (extraBase && fs.existsSync(extraBase) && !cwdInExtra) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) pushDir(fullPath);
    }
  }

  // nanoclaw 相关 CLAUDE.md 目录：群目录(记忆) / groups(通用指令) / nanoclaw 根(GitNexus)。
  // additional-dir 加载只读各目录自己的 CLAUDE.md + .claude/CLAUDE.md（不递归、不爬父链），
  // SDK 内部按 processedPaths 去重，cwd=群目录时与父链加载重复也无害。
  const groupsDir = paths.group ? path.dirname(paths.group) : undefined;
  const nanoclawRoot = groupsDir ? path.dirname(groupsDir) : undefined;
  pushDir(paths.group);
  pushDir(groupsDir);
  pushDir(nanoclawRoot);
  return extraDirs;
}

/**
 * 收集一组目录的 CLAUDE.md 内容（含 .claude/CLAUDE.md），用于 codex 首轮 prompt 前缀注入。
 * codex 不读 CLAUDE.md、无懒加载、无 additionalDirectories，prompt 前缀是它唯一的注入通道，
 * 故把 Claude 模式靠 cwd 父链 + additionalDirectories 加载的内容，在这里手动读出来拼进前缀。
 */
function collectClaudeMdContents(dirs: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const rel of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]) {
      const p = path.join(dir, rel);
      if (seen.has(p)) continue;
      seen.add(p);
      if (fs.existsSync(p)) parts.push(fs.readFileSync(p, 'utf-8'));
    }
  }
  return parts;
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

  const pollIpcDuringQuery = async () => {
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
      // 在 push 消息前切模型 + 切 thinking。
      // ⚠️ 必须 await：applyFlagSettings 的 flag settings 是「读取时」生效的，
      //   而 stream.push 会让 SDK 立即开始处理消息并读取当前配置。若不 await，
      //   push 会抢在 setModel/applyFlagSettings 写入之前触发 query，本轮仍用旧配置。
      //   踩过的坑：thinking-only 重试时 pipe 了 thinking=disabled，日志也打了
      //   「piped thinking disabled」，但同轮 assistant 的 contentTypes 仍是 thinking
      //   —— 因为 push 抢跑，disabled 只对再下一轮生效，而那时已到重试上限被放弃。
      if (queryRef) {
        const targetModel = msg.modelOverride?.model || defaultModel;
        try {
          await queryRef.setModel(targetModel);
          log(`[model-override] piped setModel(${targetModel})${msg.modelOverride?.model ? ' (override)' : ' (default)'}`);
        } catch (err: unknown) {
          log(`[model-override] piped setModel FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
        // 无 override 时回落到群默认 effort（defaultEffort），不能写死 high，
        // 否则 settings.json 里配的 low 会被每次 pipe 续接覆盖回去。
        // ⚠️ 4.8 只支持 adaptive thinking，无法真正关闭；控制思考深度的官方杠杆是
        //   effortLevel（low=最少思考最快）。上游传来的 thinking:'disabled' 在这里翻译成
        //   effortLevel:'low'。Settings schema 没有 thinking 字段，传了会被静默忽略。
        const pipedEffort = msg.modelOverride?.thinking
          ? effortForThinking(msg.modelOverride.thinking)
          : defaultEffort;
        if (pipedEffort) {
          try {
            await (queryRef as any).applyFlagSettings({ effortLevel: pipedEffort } as Record<string, unknown>);
            log(`[model-override] piped effortLevel ${pipedEffort}${msg.modelOverride?.thinking ? ' (override)' : ' (default)'}`);
          } catch (err: unknown) {
            log(`[model-override] piped applyFlagSettings FAILED: ${err instanceof Error ? err.message : String(err)}`);
          }
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
  // isFinalCandidate：该段缓存文本后面只跟随了收尾型工具（如 TodoWrite），
  //   被判定为「候选最终回复」——保留缓存、不降级 💬，等 result（为空时发）或
  //   finally（中断兜底）把它作为正式回复发出。
  let pendingThought: { text: string; short: string; detail: string | undefined; timer: ReturnType<typeof setTimeout>; isFinalCandidate?: boolean } | null = null;
  // 跟随在「当前缓存的 pendingThought 文本」之后出现的 tool_use 工具名，按出现顺序累积。
  // 每次缓存一段新文本时清空；tool_result 到达时喂给 isFinalizingOnly 判定是否升格。
  let followupToolsSinceText: string[] = [];
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

  // Additional directories —— 让 nanoclaw 的 CLAUDE.md 跨 cwd 加载（详见 computeExtraDirs）。
  const extraDirs = computeExtraDirs(PATHS);
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const queryStartTime = Date.now();
  const override = containerInput.modelOverride;
  log(`[query-start] sessionId=${sessionId || 'new'}, resumeAt=${resumeAt || 'latest'}, modelOverride=${override ? JSON.stringify(override) : 'none'}`);;
  // 日志：显示当前 proxy 用的 access token 前缀（用于验证 per-group 账号隔离）
  const proxyUrl = process.env.HTTPS_PROXY || '';
  const tokenMatch = proxyUrl.match(/x:([^@]{8})/);
  log(`[account] proxy_token_prefix=${tokenMatch?.[1] || '(none)'}, group=${containerInput.groupFolder}`);

  // 在 query() 创建前先算好目标模型/思考深度，把 model 作为启动参数直接传入 options，
  // 让 CLI 一启动就用正确模型。否则 CLI 先用 SDK 默认模型(sonnet)起，再靠延迟 setModel 切换，
  // 导致第一轮卡片必显示 sonnet（setModel 是 control request，被推迟到首条消息后才执行）。
  // model 是启动参数不是 control request，不受 2026-06-02 setModel 抢跑崩溃约束的影响。
  let defaultModel = 'claude-opus-4-6';
  // settings.json 可显式配置 effortLevel（'low' | 'medium' | 'high'）。
  // 某些群（如重度讨论复杂架构的）高 effort 下 adaptive thinking 容易陷入「只思考不输出」，
  // 可在群 settings.json 里配 "effortLevel": "low" 从源头降低思考深度。
  // 未配则保持 undefined —— 不主动 apply，让模型用自己的默认 effort（即升级前的行为）。
  // 注意：4.8 只支持 adaptive thinking，无法真正关闭，effortLevel 才是官方控制杠杆。
  let defaultEffort: 'low' | 'medium' | 'high' | undefined = undefined;
  const modelSettings = readGroupModelSettings({
    groupPath: PATHS.group,
    groupFolder: containerInput.groupFolder,
  });
  if (modelSettings.model) defaultModel = modelSettings.model;
  if (modelSettings.effortLevel) defaultEffort = modelSettings.effortLevel;

  const targetModel = override?.model || defaultModel;
  const targetEffort = override?.thinking ? effortForThinking(override.thinking) : defaultEffort;
  const defaultQueryCwd = PATHS.queryCwd || PATHS.group;
  const resolvedQueryCwd = resolveQueryCwdForSession({
    configDir: process.env.CLAUDE_CONFIG_DIR,
    sessionId,
    defaultCwd: defaultQueryCwd,
    candidateCwds: [
      PATHS.group,
      PATHS.project,
      PATHS.global,
      PATHS.extra,
    ],
  });
  if (resolvedQueryCwd.usedProjectCwd) {
    log(
      `[query-start] 已从 session 项目目录恢复 cwd: ${resolvedQueryCwd.projectCwd} (default=${defaultQueryCwd}, project=${resolvedQueryCwd.projectEntry}, transcriptCwd=${resolvedQueryCwd.transcriptCwd || 'none'}, transcript=${resolvedQueryCwd.transcriptPath})`,
    );
  } else if (resolvedQueryCwd.usedTranscriptCwd) {
    log(
      `[query-start] 已从 transcript 恢复 session cwd: ${resolvedQueryCwd.transcriptCwd} (default=${defaultQueryCwd}, transcript=${resolvedQueryCwd.transcriptPath})`,
    );
  } else {
    log(
      `[query-start] session cwd=${resolvedQueryCwd.cwd} (default=${defaultQueryCwd}, project=${resolvedQueryCwd.projectEntry || 'none'}, transcriptCwd=${resolvedQueryCwd.transcriptCwd || 'none'})`,
    );
  }

  const q = query({
    prompt: stream,
    options: {
      model: targetModel,
      // 0.3.x SDK 自带 native binary，不再需要 pathToClaudeCodeExecutable / executable
      // 旧版（0.2.x）需要显式传 cli.js 路径 + node，新版 SDK 自动定位内置 binary
      stderr: (data: string) => log(`[cli-stderr] ${data.trim()}`),
      cwd: resolvedQueryCwd.cwd,
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
        // SendMessage 是 SDK 内置 agent 间通讯，不经过飞书通道 → 用 disallowedTools 显式禁
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
      ],
      disallowedTools: [
        'SendMessage', // SDK 内置 agent 间通讯，绕过 allowedTools 白名单；飞书通道走 mcp__nanoclaw__send_message
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
            ...buildSendMessageToolEnv(containerInput.isScheduledTask),
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

  // model 已在 query() options 里作为启动参数传入（targetModel/targetEffort 在创建前算好）。
  // 下面的 setModel/applyFlagSettings 作为兜底：万一 options.model 未生效，或需要在 resume
  // 后再确认一次模型/思考深度。
  // setModel/applyFlagSettings 是 control request，要求 CLI 子进程已就绪。
  // resume 大 session（数十 MB）时，CLI 仍在加载 transcript，若此刻 await setModel 会抢在
  // control channel 就绪前发送 → "Query closed before response received" → 整个 query 崩溃 →
  // SDK 兜底报 "No conversation found"，导致大会话永远 resume 失败（2026-06-02 事故根因）。
  // 修复：推迟到收到第一条 stream 消息（CLI 已就绪、session 已 resume）后再应用。第一条通常是
  // system/init，仍早于任何 assistant 推理，model/effort override 照常生效；小 session 无感知差异。
  const applyModelSettings = async (): Promise<void> => {
    try {
      log(`[model-override] calling setModel(${targetModel})...`);
      await q.setModel(targetModel);
      log(`[model-override] setModel(${targetModel}) done${override?.model ? ' (override)' : ' (default)'}`);
    } catch (err) {
      log(`[model-override] setModel FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (targetEffort) {
      try {
        log(`[model-override] applying effortLevel: ${targetEffort}...`);
        await (q as any).applyFlagSettings({ effortLevel: targetEffort } as Record<string, unknown>);
        log(`[model-override] effortLevel ${targetEffort}${override?.thinking ? ' (override)' : ' (default)'}`);
      } catch (err) {
        log(`[model-override] applyFlagSettings FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      log(`[model-override] effortLevel 未配置，保持模型默认`);
    }
  };
  let modelSettingsApplied = false;

  try {
  for await (const message of q) {
    messageCount++;
    // CLI 就绪标志：收到第一条消息说明子进程已启动、session 已 resume 完成，
    // 此刻再应用 model/effort override 才安全（避免 resume 大 session 时 setModel 抢跑崩溃）。
    if (!modelSettingsApplied) {
      modelSettingsApplied = true;
      await applyModelSettings();
    }
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
            // 累积「当前缓存文本之后出现的工具名」，供 tool_result 到达时判定是否
            // 只跟随收尾型工具（见下方 user/tool_result 分流）。
            followupToolsSinceText.push(block.name);
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
              // 新缓存一段文本 → 重置「跟随工具」累积，重新开始判定
              followupToolsSinceText = [];
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
      // tool_result message 到达 → 判定前面 pending 的 text 是中间叙述还是候选最终回复：
      //   · 跟随的工具全是收尾型（白名单，如 TodoWrite）→ 标记为候选最终回复，保留缓存、
      //     不降级 💬、清掉 timer，等 result/finally 作为正式回复发出。
      //   · 含任何实质工具（Read/Bash/Edit/Grep…）→ 维持现状，主动 flush 成 💬 中间叙述
      //     （比等 30s timer 更稳健，避免 result 延迟 > 时间窗与 text 双发的 race）。
      if (pendingThought) {
        clearTimeout(pendingThought.timer);
        if (isFinalizingOnly(followupToolsSinceText)) {
          pendingThought.isFinalCandidate = true;
          log(`[text-block] tool_result arrived, only finalizing tools followed (${followupToolsSinceText.join(',')}) → mark as final candidate (hold, no 💬)`);
        } else {
          log(`[text-block] tool_result arrived (followed by real tools: ${followupToolsSinceText.join(',') || 'none'}) → flush pending text as interim narration`);
          flushPendingThought();
        }
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

      // result 到达时对 pendingThought 的处理（「发候选」与「发 result」同轮互斥）：
      //   · textResult 非空 → result 本身就是更完整的最终回复，总是发 result、丢弃 pending
      //     （含候选），与 interactive 模式 stop_reason='end_turn' 的 drop 语义对齐。
      //   · textResult 为空 + 候选最终回复 → 用候选文本作为正式回复（下方 writeOutput 取
      //     promotedFinalText），修复「结论被收尾工具吞掉、result 为空」的核心 bug。
      //   · textResult 为空 + 普通中间叙述 → flush 成 💬 让用户至少看到。
      let promotedFinalText: string | null = null;
      if (pendingThought) {
        const hasFinalText = !!textResult && textResult.trim().length > 0;
        clearTimeout(pendingThought.timer);
        if (hasFinalText) {
          log('[text-block] result arrived with text → drop pending (result is the final reply)');
          pendingThought = null;
        } else if (pendingThought.isFinalCandidate) {
          log('[text-block] result empty + final candidate → promote candidate text to formal reply');
          promotedFinalText = pendingThought.text;
          pendingThought = null;
        } else {
          log('[text-block] result is empty/null → flush pending so user sees interim narration');
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

      const hasResult = !!textResult && textResult.trim().length > 0;
      if (!hasResult && (rawUsage?.output_tokens ?? 0) > 0) {
        log(`[result] ⚠️ result 为空但有 ${rawUsage?.output_tokens} output tokens — 模型可能仅产出 thinking 无 text content`);
      }
      log(
        `[result] #${resultCount} model=${lastAssistantModel || 'unknown'} input=${rawUsage?.input_tokens ?? '?'} output=${rawUsage?.output_tokens ?? '?'} turns=${(msg.num_turns as number) ?? '?'} cost=$${((msg.total_cost_usd as number) ?? 0).toFixed(3)} hasResult=${hasResult}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || promotedFinalText || null,
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
    //
    // 中断兜底（决策4）：若此时缓存的是「候选最终回复」（后面只跟收尾工具，
    // 且 result 未到达就被 abort/异常打断），补发为正式回复而非丢弃——否则
    // agent 的结论彻底沉默。finally 同步执行、在 runQuery return 前跑完，不跨轮，
    // 先 clearTimeout 即可，无需会话标识。普通中间叙述仍按旧行为丢弃。
    ipcPolling = false;
    if (pendingThought) {
      clearTimeout(pendingThought.timer);
      if (pendingThought.isFinalCandidate) {
        log('[text-block] runQuery exiting with final candidate → emit as formal reply (interruption fallback)');
        writeOutput({
          status: 'success',
          result: pendingThought.text,
          newSessionId: undefined,
        });
      } else {
        log('[text-block] runQuery exiting → clear pending timer (avoid cross-session leak)');
      }
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
    // additionalDirectories 里目录的 CLAUDE.md 必须靠这个开关才会被加载。
    // 我们用 additionalDirectories 注入 nanoclaw 群记忆/通用指令（cwd 切到 nine 后兜底），
    // 所以强制打开，不依赖每群 settings.json 手动配。
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(PATHS.ipcInput, { recursive: true });
  const cliMode = containerInput.cliMode || 'sdk';

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(PATHS.ipcClose);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  const initialInteractiveClaims: string[] = [];
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  if (cliMode === 'interactive') {
    const recovered = recoverInflightIpcMessages();
    if (recovered > 0) {
      log(`[interactive] recovered ${recovered} inflight IPC message(s) before initial prompt`);
    }
    const pending: IpcMessage[] = [];
    while (true) {
      const claimed = claimNextIpcMessage();
      if (!claimed) break;
      pending.push(claimed);
      if (claimed.claimPath) initialInteractiveClaims.push(claimed.claimPath);
    }
    if (pending.length > 0) {
      log(`[interactive] Claiming ${pending.length} pending IPC message(s) into initial prompt`);
      // interactive 模式按真实时间顺序处理 pending：旧消息在 initial prompt 前面。
      prompt = pending.map(m => prependContext(m.text, m.context)).join('\n') + '\n' + prompt;
    }
  } else {
    const pending = drainIpcInput();
    if (pending.length > 0) {
      log(`Draining ${pending.length} pending IPC messages into initial prompt`);
      prompt += '\n' + pending.map(m => prependContext(m.text, m.context)).join('\n');
    }
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

    // 额外目录（与 SDK 模式一致：注入 nanoclaw 三目录 + cwd=nine 时跳过其子目录保懒加载）
    const extraDirs = computeExtraDirs(PATHS);

    // 累积对话记录，退出时归档到 conversations/
    const cliTranscript: ParsedMessage[] = [];

    try {
      while (true) {
        log(`[cli-mode] Starting CLI query (session: ${sessionId || 'new'})...`);

        // 记录用户消息
        cliTranscript.push({ role: 'user', content: prompt });

        const defaultModel =
          readGroupModelSettings({
            groupPath: PATHS.group,
            groupFolder: containerInput.groupFolder,
          }).model || 'claude-opus-4-6';
        const override = containerInput.modelOverride;
        const cliResult = await runCliQuery(
          {
            prompt,
            sessionId,
            model: override?.model || defaultModel,
            mcpServerPath,
            chatJid: containerInput.chatJid,
            groupFolder: containerInput.groupFolder,
            isMain: containerInput.isMain,
            ipcDir: PATHS.ipc,
            cwd: PATHS.queryCwd || PATHS.group,
            env: sdkEnv,
            additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
            systemPromptAppend,
            isScheduledTask: containerInput.isScheduledTask,
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
        if (nextMessage.senderId !== undefined) {
          containerInput.senderId = nextMessage.senderId;
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

  if (cliMode === 'codex') {
    log('[mode] codex mode — spawning codex exec per turn');

    // 加载全局上下文（SOUL.md + TOOLS.md + CLAUDE.md）拼进首轮 prompt 前缀。
    // codex 没有 --append-system-prompt，且读 AGENTS.md 不读 CLAUDE.md，
    // 故 PoC 阶段把人设/规范作为首轮前缀注入（后续轮靠 resume 保留上下文）。
    const cxGlobalDir = PATHS.global;
    const cxContextParts: string[] = [];
    const cxSoulPath = cxGlobalDir ? path.join(cxGlobalDir, 'SOUL.md') : undefined;
    if (cxSoulPath && fs.existsSync(cxSoulPath)) {
      cxContextParts.push(fs.readFileSync(cxSoulPath, 'utf-8'));
    }
    const cxToolsPath = cxGlobalDir ? path.join(cxGlobalDir, 'TOOLS.md') : undefined;
    if (cxToolsPath && fs.existsSync(cxToolsPath)) {
      cxContextParts.push(fs.readFileSync(cxToolsPath, 'utf-8'));
    }
    const cxClaudeMdPath = PATHS.globalClaudeMd;
    if (cxClaudeMdPath && fs.existsSync(cxClaudeMdPath)) {
      cxContextParts.push(fs.readFileSync(cxClaudeMdPath, 'utf-8'));
    }
    // codex 不读 CLAUDE.md、无懒加载、无 additionalDirectories，故把 Claude 模式靠 cwd 父链 +
    // additionalDirectories 加载的 CLAUDE.md（cwd=nine 根 / 群记忆 / groups 通用指令 / nanoclaw 根）
    // 手动读出来拼进首轮前缀，与其他模式行为对齐。nine 子目录的懒加载 codex 无法复刻（固有限制）。
    const cxEffectiveCwd = PATHS.queryCwd || PATHS.group;
    const cxGroupsDir = PATHS.group ? path.dirname(PATHS.group) : undefined;
    const cxNanoclawRoot = cxGroupsDir ? path.dirname(cxGroupsDir) : undefined;
    cxContextParts.push(
      ...collectClaudeMdContents([
        cxEffectiveCwd,
        PATHS.group,
        cxGroupsDir,
        cxNanoclawRoot,
      ]),
    );
    const cxSystemPrefix = cxContextParts.length > 0
      ? `[系统人设与规范，必须遵守]\n\n${cxContextParts.join('\n\n---\n\n')}\n\n[以上为系统设定，以下是用户消息]\n\n`
      : '';

    // per-group CODEX_HOME（持久，保留 session 文件供 resume）
    const codexHome = path.join(PATHS.group, '.codex-home');

    const cxTranscript: ParsedMessage[] = [];
    let cxFirstTurn = true;

    try {
      while (true) {
        log(`[codex-mode] Starting codex query (session: ${sessionId || 'new'})...`);

        const turnPrompt = cxFirstTurn ? cxSystemPrefix + prompt : prompt;
        cxFirstTurn = false;
        cxTranscript.push({ role: 'user', content: prompt });

        const override = containerInput.modelOverride;
        const cxResult = await runCodexQuery(
          {
            prompt: turnPrompt,
            sessionId,
            model: override?.model || 'gpt-5.5',
            mcpServerPath,
            chatJid: containerInput.chatJid,
            groupFolder: containerInput.groupFolder,
            isMain: containerInput.isMain,
            senderId: containerInput.senderId,
            ipcDir: PATHS.ipc,
            cwd: PATHS.queryCwd || PATHS.group,
            env: sdkEnv,
            codexHome,
            isScheduledTask: containerInput.isScheduledTask,
          },
          writeOutput,
          log,
        );

        if (cxResult.newSessionId) {
          sessionId = cxResult.newSessionId;
        }
        if (cxResult.result) {
          cxTranscript.push({ role: 'assistant', content: cxResult.result });
        }

        if (shouldClose()) {
          log('[codex-mode] Close sentinel detected, exiting');
          break;
        }

        log('[codex-mode] Query ended, waiting for next IPC message...');
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('[codex-mode] Close sentinel received, exiting');
          break;
        }
        log(`[codex-mode] Got new message (${nextMessage.text.length} chars)`);
        prompt = prependContext(nextMessage.text, nextMessage.context);
        if (nextMessage.modelOverride) {
          containerInput.modelOverride = nextMessage.modelOverride;
        } else {
          containerInput.modelOverride = undefined;
        }
        if (nextMessage.senderId !== undefined) {
          containerInput.senderId = nextMessage.senderId;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`[codex-mode] Agent error: ${errorMessage}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: errorMessage,
      });
      archiveCliTranscript(cxTranscript, containerInput.assistantName);
      process.exit(1);
    }

    archiveCliTranscript(cxTranscript, containerInput.assistantName);
    return;
  }

  if (cliMode === 'gemini') {
    log('[mode] gemini mode — spawning gemini stream-json per turn');

    // Gemini CLI 没有 Claude 的 --append-system-prompt；与 codex mode 一样，
    // 首轮把全局人设/工具说明/CLAUDE.md 作为前缀注入，后续靠 --resume 保持上下文。
    const gmGlobalDir = PATHS.global;
    const gmContextParts: string[] = [];
    const gmSoulPath = gmGlobalDir ? path.join(gmGlobalDir, 'SOUL.md') : undefined;
    if (gmSoulPath && fs.existsSync(gmSoulPath)) {
      gmContextParts.push(fs.readFileSync(gmSoulPath, 'utf-8'));
    }
    const gmToolsPath = gmGlobalDir ? path.join(gmGlobalDir, 'TOOLS.md') : undefined;
    if (gmToolsPath && fs.existsSync(gmToolsPath)) {
      gmContextParts.push(fs.readFileSync(gmToolsPath, 'utf-8'));
    }
    const gmClaudeMdPath = PATHS.globalClaudeMd;
    if (gmClaudeMdPath && fs.existsSync(gmClaudeMdPath)) {
      gmContextParts.push(fs.readFileSync(gmClaudeMdPath, 'utf-8'));
    }
    const gmEffectiveCwd = PATHS.queryCwd || PATHS.group;
    const gmGroupsDir = PATHS.group ? path.dirname(PATHS.group) : undefined;
    const gmNanoclawRoot = gmGroupsDir ? path.dirname(gmGroupsDir) : undefined;
    gmContextParts.push(
      ...collectClaudeMdContents([
        gmEffectiveCwd,
        PATHS.group,
        gmGroupsDir,
        gmNanoclawRoot,
      ]),
    );
    const gmSystemPrefix = gmContextParts.length > 0
      ? `[系统人设与规范，必须遵守]\n\n${gmContextParts.join('\n\n---\n\n')}\n\n[以上为系统设定，以下是用户消息]\n\n`
      : '';

    // per-group HOME，隔离 Gemini session/MCP 配置；OAuth 凭证由 gemini-runner 软链宿主 ~/.gemini。
    const geminiHome = path.join(PATHS.group, '.gemini-home');
    const gmExtraDirs = computeExtraDirs(PATHS);
    const gmTranscript: ParsedMessage[] = [];
    let gmFirstTurn = true;

    try {
      while (true) {
        log(`[gemini-mode] Starting gemini query (session: ${sessionId || 'new'})...`);

        const turnPrompt = gmFirstTurn ? gmSystemPrefix + prompt : prompt;
        gmFirstTurn = false;
        gmTranscript.push({ role: 'user', content: prompt });

        const override = containerInput.modelOverride;
        const gmResult = await runGeminiQuery(
          {
            prompt: turnPrompt,
            sessionId,
            model: override?.model || 'gemini-3-pro-preview',
            mcpServerPath,
            chatJid: containerInput.chatJid,
            groupFolder: containerInput.groupFolder,
            isMain: containerInput.isMain,
            senderId: containerInput.senderId,
            ipcDir: PATHS.ipc,
            cwd: gmEffectiveCwd,
            env: sdkEnv,
            geminiHome,
            additionalDirectories: gmExtraDirs.length > 0 ? gmExtraDirs : undefined,
            isScheduledTask: containerInput.isScheduledTask,
          },
          writeOutput,
          log,
        );

        if (gmResult.newSessionId) {
          sessionId = gmResult.newSessionId;
        }
        if (gmResult.result) {
          gmTranscript.push({ role: 'assistant', content: gmResult.result });
        }

        if (shouldClose()) {
          log('[gemini-mode] Close sentinel detected, exiting');
          break;
        }

        log('[gemini-mode] Query ended, waiting for next IPC message...');
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('[gemini-mode] Close sentinel received, exiting');
          break;
        }
        log(`[gemini-mode] Got new message (${nextMessage.text.length} chars)`);
        prompt = prependContext(nextMessage.text, nextMessage.context);
        if (nextMessage.modelOverride) {
          containerInput.modelOverride = nextMessage.modelOverride;
        } else {
          containerInput.modelOverride = undefined;
        }
        if (nextMessage.senderId !== undefined) {
          containerInput.senderId = nextMessage.senderId;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`[gemini-mode] Agent error: ${errorMessage}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: errorMessage,
      });
      archiveCliTranscript(gmTranscript, containerInput.assistantName);
      process.exit(1);
    }

    archiveCliTranscript(gmTranscript, containerInput.assistantName);
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

    // 额外目录（与 SDK 模式一致：注入 nanoclaw 三目录 + cwd=nine 时跳过其子目录保懒加载）
    const iExtraDirs = computeExtraDirs(PATHS);

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
    let activeClaimPaths = initialInteractiveClaims;

    try {
      while (true) {
        log(`[interactive] Starting query (session: ${sessionId || 'new'})...`);
        iTranscript.push({ role: 'user', content: prompt });

        const defaultModel =
          readGroupModelSettings({
            groupPath: PATHS.group,
            groupFolder: containerInput.groupFolder,
          }).model || 'claude-opus-4-6';
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
            model: override?.model || defaultModel,
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
            isScheduledTask: containerInput.isScheduledTask,
            onInputAccepted: () => {
              // 快路径：一旦确认 Claude 接收输入，立即 ack，避免 final 前崩溃导致重放。
              ackClaimedIpcMessages(activeClaimPaths);
              activeClaimPaths = [];
            },
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
        if (result.inputAccepted) {
          // 保险路径：如果快路径已 ack，这里 activeClaimPaths 已为空；否则补 ack。
          ackClaimedIpcMessages(activeClaimPaths);
        } else if (activeClaimPaths.length > 0) {
          requeueClaimedIpcMessages(activeClaimPaths);
        }
        activeClaimPaths = [];

        // 检查 _close 信号
        if (shouldClose()) {
          log('[interactive] Close sentinel detected, exiting');
          break;
        }

        if (shouldEmitInteractiveSessionKeepalive(sessionId, result)) {
          writeOutput({ status: 'success', result: null, newSessionId: sessionId });
        }

        log('[interactive] Query ended, waiting for next IPC message...');

        const nextMessage = await waitForInteractiveIpcMessage();
        if (nextMessage === null) {
          log('[interactive] Close sentinel received, exiting');
          break;
        }

        log(`[interactive] Got new message (${nextMessage.text.length} chars)`);
        activeClaimPaths = nextMessage.claimPath ? [nextMessage.claimPath] : [];

        // 消息驱动健康检查：发消息时才检查环境，不用定时器
        const health = await checkCliHealth(containerInput.chatJid, log);
        if (!health.healthy) {
          log(`[interactive] 环境异常，退出 runner: ${health.error}`);
          requeueClaimedIpcMessages(activeClaimPaths);
          activeClaimPaths = [];
          writeOutput({
            status: 'error',
            result: null,
            error: `CLI 环境异常 (${health.error})，正在重启...`,
          });
          break;
        }

        prompt = prependContext(nextMessage.text, nextMessage.context);
        if (nextMessage.modelOverride) {
          containerInput.modelOverride = nextMessage.modelOverride;
        } else {
          containerInput.modelOverride = undefined;
        }
        if (nextMessage.senderId !== undefined) {
          containerInput.senderId = nextMessage.senderId;
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
    // 必须显式 exit：interactive 模式持有 TapProxy(net.Server)、tmux/MCP 子进程等
    // 句柄，cleanup 停不干净 → 单纯 return 后 Node 事件循环不空、进程不退化为僵尸，
    // 主进程 group-queue 的 state.active 永远为 true → 整个群队列死锁。
    // 设计意图本就是 runner 退出后主进程拉起新 runner 重建一切（见 checkCliHealth 注释）。
    log('[interactive] runner 正常退出，主进程将按需重建');
    process.exit(0);
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
      if (nextMessage.senderId !== undefined) {
        containerInput.senderId = nextMessage.senderId;
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
