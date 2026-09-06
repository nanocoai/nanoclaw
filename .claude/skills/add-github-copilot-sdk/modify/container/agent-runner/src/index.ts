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
import {
  CopilotClient,
  CopilotSession,
  SessionConfig,
  ResumeSessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';
import type { PermissionRequest, PermissionRequestResult } from '@github/copilot-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  model?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
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

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
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

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch {
    // Ignore errors reading session index
  }

  return null;
}

/**
 * Archive the conversation transcript to conversations/ directory.
 */
function archiveConversation(events: SessionEvent[], sessionId: string): void {
  if (events.length === 0) {
    log('No events to archive');
    return;
  }

  try {
    const parsedMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const event of events) {
      // Type narrowing based on discriminant
      if (event.type === 'user.message') {
        const content = event.data.content;
        if (content) {
          parsedMessages.push({ role: 'user', content });
        }
      } else if (event.type === 'assistant.message') {
        const content = event.data.content;
        if (content) {
          parsedMessages.push({ role: 'assistant', content });
        }
      }
    }

    if (parsedMessages.length === 0) {
      log('No user/assistant messages to archive');
      return;
    }

    // Try to get summary from sessions index
    const transcriptPath = `/home/node/.copilot/sessions/${sessionId}.jsonl`;
    const summary = getSessionSummary(sessionId, transcriptPath);
    const name = summary ? sanitizeFilename(summary) : generateFallbackName();

    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(parsedMessages, summary);
    fs.writeFileSync(filePath, markdown);

    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
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
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
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
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// COPILOT_SDK_AUTH_TOKEN is always injected by the SDK into the CLI's env.
// Additional secret names are computed dynamically from containerInput.secrets keys
// so that newly added secrets are automatically stripped from Bash commands.
const ALWAYS_STRIP_VARS = ['COPILOT_SDK_AUTH_TOKEN'];

/**
 * Build session configuration.
 */
function buildSessionConfig(
  mcpServerPath: string,
  containerInput: ContainerInput,
  globalClaudeMd: string | undefined,
  archiveFn: (sessionId: string) => Promise<void>,
): SessionConfig {
  // Compute full list of env vars to strip: SDK-injected token + all secret keys
  const secretEnvVars = [
    ...ALWAYS_STRIP_VARS,
    ...Object.keys(containerInput.secrets || {}),
  ];

  // Paths that should never be readable by the agent — they may contain secrets.
  const SENSITIVE_PATH_PATTERNS = [
    /\/proc\/.*\/environ/,   // Process environment (contains COPILOT_SDK_AUTH_TOKEN)
    /\/proc\/self\/environ/,
    /\/tmp\/input\.json/,     // Legacy: stdin temp file (eliminated, but block defensively)
  ];

  const hooks: SessionConfig['hooks'] = {
    // Sanitize tool invocations to prevent secret leakage.
    onPreToolUse: async (input) => {
      const toolName = input.toolName;

      // --- Bash commands: strip secret env vars + block /proc/environ reads ---
      if (toolName === 'Bash' || toolName === 'bash') {
        const args = input.toolArgs as { command?: string };
        if (!args?.command) return;

        // Block commands that try to read /proc/*/environ
        if (/\/proc\/[^/]+\/environ/.test(args.command)) {
          return {
            permissionDecision: 'deny' as const,
            permissionDecisionReason: 'Reading /proc/*/environ is blocked to protect secrets',
          };
        }

        const unsetPrefix = `unset ${secretEnvVars.join(' ')} 2>/dev/null; `;
        return { modifiedArgs: { ...args, command: unsetPrefix + args.command } };
      }

      // --- File read tools: block reads of sensitive paths ---
      if (toolName === 'Read' || toolName === 'read' ||
          toolName === 'ReadFile' || toolName === 'read_file') {
        const args = input.toolArgs as { file_path?: string; path?: string };
        const filePath = args?.file_path || args?.path || '';
        for (const pattern of SENSITIVE_PATH_PATTERNS) {
          if (pattern.test(filePath)) {
            return {
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Reading ${filePath} is blocked to protect secrets`,
            };
          }
        }
      }

      return;
    },

    // Archive conversation when session ends (crash, timeout, normal exit).
    // This is the safety net — main() also archives before destroy().
    onSessionEnd: async (_input, invocation) => {
      await archiveFn(invocation.sessionId);
    },
  };

  // Discover skill directories mounted at /workspace/skills/
  const skillDirectories: string[] = [];
  const skillsBase = '/workspace/skills';
  if (fs.existsSync(skillsBase)) {
    for (const entry of fs.readdirSync(skillsBase)) {
      const fullPath = path.join(skillsBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        skillDirectories.push(fullPath);
      }
    }
  }

  return {
    workingDirectory: '/workspace/group',
    // Use the mounted .copilot directory for session persistence across container runs
    configDir: '/home/node/.copilot',
    model: containerInput.model || undefined,
    systemMessage: globalClaudeMd
      ? { mode: 'append', content: globalClaudeMd }
      : undefined,
    onPermissionRequest: async (_request: PermissionRequest): Promise<PermissionRequestResult> => ({ kind: 'approved' }),
    hooks,
    skillDirectories: skillDirectories.length > 0 ? skillDirectories : undefined,
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
        tools: ['*'],
      },
    },
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Extract GitHub token from secrets WITHOUT setting them on process.env.
  // The original code kept secrets isolated so Bash subprocesses can't see them.
  const secrets = containerInput.secrets || {};
  const githubToken = secrets.GITHUB_TOKEN || secrets.GH_TOKEN;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Load global instructions
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // Read their CLAUDE.md files and append to system context.
  // (Original SDK had additionalDirectories; Copilot SDK doesn't, so we inline them.)
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        const extraClaudeMd = path.join(fullPath, 'CLAUDE.md');
        if (fs.existsSync(extraClaudeMd)) {
          const content = fs.readFileSync(extraClaudeMd, 'utf-8');
          globalClaudeMd = (globalClaudeMd || '') + `\n\n# ${entry}\n\n${content}`;
          log(`Loaded CLAUDE.md from extra dir: ${entry}`);
        }
      }
    }
  }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Initialize client — pass GitHub token explicitly since the container
  // has no gh CLI config or stored OAuth tokens.
  if (!githubToken) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'GITHUB_TOKEN or GH_TOKEN must be set for Copilot SDK authentication'
    });
    process.exit(1);
  }

  // Pass a minimal environment to the CLI subprocess so it does NOT inherit
  // process.env. The SDK adds COPILOT_SDK_AUTH_TOKEN automatically.
  // This limits what the CLI child process (and its /proc/<pid>/environ) exposes.
  const minimalEnv: Record<string, string> = {
    HOME: '/home/node',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    NODE_OPTIONS: '--dns-result-order=ipv4first',
    LANG: 'C.UTF-8',
  };

  const client = new CopilotClient({
    logLevel: 'info',
    cwd: '/workspace/group',
    githubToken,
    env: minimalEnv,
  });

  let session: CopilotSession | null = null;
  let closeRequested = false;

  try {
    log('Starting Copilot client...');
    await client.start();
    log('Copilot client started');

    // Log available models so we can see what IDs are valid
    try {
      const models = await client.listModels();
      const modelIds = models.map(m => m.id);
      log(`Available models: ${modelIds.join(', ')}`);
    } catch (err) {
      log(`Failed to list models: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Scrub secrets from this process's memory and environment.
    // The SDK has already passed the token to the CLI subprocess — we no
    // longer need it in the agent-runner Node process.
    delete containerInput.secrets;
    delete (containerInput as any).githubToken;
    // Remove any env vars the SDK may have leaked into our process.env
    delete process.env.COPILOT_SDK_AUTH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    // Build session config — pass archive function for the onSessionEnd hook
    const doArchive = async (sid: string) => {
      if (!session) return;
      try {
        const events = await session.getMessages();
        if (events.length > 0) {
          archiveConversation(events, sid);
        }
      } catch (err) {
        log(`Archive error in hook: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const sessionConfig = buildSessionConfig(mcpServerPath, containerInput, globalClaudeMd, doArchive);

    // Create or resume session ONCE - keep it alive for entire conversation
    log(`Requested model: ${containerInput.model || '(default)'}`);
    if (containerInput.sessionId) {
      log(`Resuming session: ${containerInput.sessionId}`);
      session = await client.resumeSession(containerInput.sessionId, sessionConfig as ResumeSessionConfig);
    } else {
      log('Creating new session');
      session = await client.createSession(sessionConfig);
    }

    const sessionId = session.sessionId;

    // Log the model the SDK actually resolved to
    try {
      const currentModel = await session.rpc.model.getCurrent();
      log(`Session ready: ${sessionId} (model: ${currentModel.modelId || 'unknown'})`);
    } catch {
      log(`Session ready: ${sessionId} (could not query resolved model)`);
    }

    // Set up error logging
    session.on('session.error', (event) => {
      log(`Session error: ${event.data.message}`);
    });

    // Archive before compaction — mirrors the original PreCompact hook.
    // When infinite sessions compact the context, we save the full transcript first.
    session.on('session.compaction_start', () => {
      log('Compaction starting, archiving conversation');
      doArchive(sessionId).catch(err => {
        log(`Pre-compaction archive error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    // IPC polling during active processing
    let ipcPolling = false;
    const pollIpc = () => {
      if (!ipcPolling || !session) return;

      if (shouldClose()) {
        log('Close sentinel detected');
        closeRequested = true;
        ipcPolling = false;
        return;
      }

      const messages = drainIpcInput();
      for (const text of messages) {
        log(`Sending IPC message (${text.length} chars)`);
        session.send({ prompt: text }).catch(err => {
          log(`IPC send error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      setTimeout(pollIpc, IPC_POLL_MS);
    };

    // Main conversation loop - use SAME session for all messages
    while (!closeRequested) {
      // Start IPC polling
      ipcPolling = true;
      setTimeout(pollIpc, IPC_POLL_MS);

      try {
        log(`Sending prompt (${prompt.length} chars)`);
        // 10 minute timeout — agent tasks involve tool use, web search, etc.
        const response = await session.sendAndWait({ prompt }, 600_000);
        ipcPolling = false;

        const result = response?.data?.content || null;
        if (result) {
          log(`Response received (${result.length} chars)`);
        }

        writeOutput({
          status: 'success',
          result,
          newSessionId: sessionId
        });

        // Check if close was requested during processing
        if (closeRequested) {
          log('Close requested during processing');
          break;
        }

        log('Waiting for next message...');
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received');
          break;
        }

        log(`Got new message (${nextMessage.length} chars)`);
        prompt = nextMessage;

      } catch (err) {
        ipcPolling = false;
        const errorMessage = err instanceof Error ? err.message : String(err);
        log(`Error: ${errorMessage}`);

        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: errorMessage
        });

        // Continue waiting for messages on error
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          break;
        }
        prompt = nextMessage;
      }
    }

    // Archive conversation
    try {
      const events = await session.getMessages();
      if (events.length > 0) {
        archiveConversation(events, sessionId);
      }
    } catch (err) {
      log(`Archive error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Cleanup — client.stop() destroys all sessions (with retries) then kills CLI
    const stopErrors = await client.stop();
    if (stopErrors.length > 0) {
      for (const err of stopErrors) {
        log(`Shutdown warning: ${err.message}`);
      }
    }
    log('Client stopped');

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Fatal error: ${errorMessage}`);

    writeOutput({
      status: 'error',
      result: null,
      newSessionId: session?.sessionId,
      error: errorMessage
    });

    // Graceful stop with timeout — fall back to forceStop if CLI is unresponsive
    try {
      await Promise.race([
        client.stop(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('stop timeout')), 5_000)),
      ]);
    } catch {
      log('Graceful stop timed out, force-killing CLI process');
      await client.forceStop();
    }

    process.exit(1);
  }
}

main();
