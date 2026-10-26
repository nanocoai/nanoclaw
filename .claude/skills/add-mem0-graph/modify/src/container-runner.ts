/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ANTHROPIC_MODEL,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const STREAM_TEXT_MARKER = '---NANOCLAW_STREAM_TEXT---';
const STREAM_TEXT_END_MARKER = '---NANOCLAW_STREAM_TEXT_END---';
const TRACE_MARKER = '---NANOCLAW_TRACE---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  rateLimitResetAt?: string; // ISO date when rate limit resets
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export async function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): Promise<VolumeMount[]> {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    try {
      await fs.promises.stat(globalDir);
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    } catch {
      // globalDir does not exist, skip
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  await fs.promises.mkdir(groupSessionsDir, { recursive: true });
  // When running as root, the container's node user (uid 1000) needs write access
  // to create subdirectories like .claude/debug/ and .claude/projects/
  await fs.promises.chmod(groupSessionsDir, 0o777);
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  try {
    await fs.promises.stat(settingsFile);
  } catch {
    await fs.promises.writeFile(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
            ...(ANTHROPIC_MODEL ? { ANTHROPIC_MODEL } : {}),
            // mcporter: npm-global package + config mounted from host
            PATH: '/host/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            MCPORTER_CONFIG: '/workspace/nanoclaw-config/mcporter.json',
            // mcporter spawns MCP sub-processes — they need node_modules on host path
            NODE_PATH: '/host/.npm-global/lib/node_modules',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  try {
    const skillDirs = await fs.promises.readdir(skillsSrc);
    for (const skillDir of skillDirs) {
      const srcDir = path.join(skillsSrc, skillDir);
      const stat = await fs.promises.stat(srcDir);
      if (!stat.isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      await fs.promises.cp(srcDir, dstDir, { recursive: true });
    }
  } catch {
    // skillsSrc does not exist, skip
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  await fs.promises.mkdir(path.join(groupIpcDir, 'messages'), {
    recursive: true,
  });
  await fs.promises.mkdir(path.join(groupIpcDir, 'tasks'), { recursive: true });
  await fs.promises.mkdir(path.join(groupIpcDir, 'input'), { recursive: true });
  await fs.promises.mkdir(path.join(groupIpcDir, 'memory'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Always sync core agent-runner source so MCP tool updates propagate
  // to existing groups (same pattern as skills sync above).
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, {
      recursive: true,
      force: true,
    });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Per-group extensions directory for agent-added custom tools.
  // Never overwritten by core sync — agents can safely add tools here.
  const groupExtensionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-extensions',
  );
  if (!fs.existsSync(groupExtensionsDir)) {
    fs.mkdirSync(groupExtensionsDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupExtensionsDir,
    containerPath: '/app/extensions',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  // Mount mcporter + MCP server projects from host (read-only)
  // mcporter spawns MCP sub-processes that need access to their project dirs on the host.
  const homeDir = process.env.HOME || '/home/admin';
  const npmGlobal = path.join(homeDir, '.npm-global');
  if (fs.existsSync(npmGlobal)) {
    mounts.push({
      hostPath: npmGlobal,
      containerPath: '/host/.npm-global',
      readonly: true,
    });
  }
  // nanoclaw/config/ contains mcporter.json (copied, not symlinked to openclaw)
  const nanoclaConfigDir = path.join(projectRoot, 'config');
  if (fs.existsSync(nanoclaConfigDir)) {
    mounts.push({
      hostPath: nanoclaConfigDir,
      containerPath: '/workspace/nanoclaw-config',
      readonly: true,
    });
  }
  // MCP server projects (weather-mcp, ms-mcp, email-mcp, etc.) live under ~/projects
  const projectsDir = path.join(homeDir, 'projects');
  if (fs.existsSync(projectsDir)) {
    mounts.push({
      hostPath: projectsDir,
      containerPath: path.join(homeDir, 'projects'),
      readonly: true,
    });
  }

  // email-mcp config: accounts.json lives in ~/.email-mcp/ on host.
  // email-mcp subprocess (spawned by mcporter inside the container) runs as
  // the 'node' user whose home is /home/node — mount to that path so
  // Node's os.homedir() resolves the config correctly.
  const emailMcpConfig = path.join(homeDir, '.email-mcp');
  if (fs.existsSync(emailMcpConfig)) {
    mounts.push({
      hostPath: emailMcpConfig,
      containerPath: '/home/node/.email-mcp',
      readonly: true,
    });
  }

  // ms-mcp token cache: MSAL token caches live in ~/.ms-mcp/ on host.
  // ms-mcp reads TOKEN_CACHE_PATH=~/.ms-mcp/token-cache-*.json — inside
  // the container ~ resolves to /home/node.  Read-write is required because
  // MSAL silently refreshes expired tokens and writes them back.
  const msMcpCache = path.join(homeDir, '.ms-mcp');
  if (fs.existsSync(msMcpCache)) {
    mounts.push({
      hostPath: msMcpCache,
      containerPath: '/home/node/.ms-mcp',
      readonly: false,
    });
  }

  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]);
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onStreamDelta?: (text: string) => void,
  onTrace?: (event: Record<string, unknown>) => void,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = await buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets();
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;

        // Parse TRACE markers (observability events)
        if (onTrace) {
          let traceIdx: number;
          while ((traceIdx = parseBuffer.indexOf(TRACE_MARKER)) !== -1) {
            const lineEnd = parseBuffer.indexOf('\n', traceIdx);
            if (lineEnd === -1) break;
            const jsonStr = parseBuffer
              .slice(traceIdx + TRACE_MARKER.length, lineEnd)
              .trim();
            parseBuffer = parseBuffer.slice(lineEnd + 1);
            try {
              const ev = JSON.parse(jsonStr);
              onTrace(ev);
            } catch {
              // ignore malformed trace
            }
          }
        }

        // Parse STREAM_TEXT markers (real-time text deltas for draft display)
        if (onStreamDelta) {
          let stIdx: number;
          while ((stIdx = parseBuffer.indexOf(STREAM_TEXT_MARKER)) !== -1) {
            const stEnd = parseBuffer.indexOf(STREAM_TEXT_END_MARKER, stIdx);
            if (stEnd === -1) break;

            const streamText = parseBuffer
              .slice(stIdx + STREAM_TEXT_MARKER.length, stEnd)
              .trim();
            parseBuffer = parseBuffer.slice(
              stEnd + STREAM_TEXT_END_MARKER.length,
            );

            if (streamText) {
              try {
                onStreamDelta(streamText);
              } catch {
                // Best-effort — don't break the main flow
              }
            }
          }
        }

        // Parse OUTPUT markers (complete results)
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.error(
                  { group: group.name, error: err },
                  'Error in streaming output callback',
                );
              });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Clean up session media files (images downloaded during this session)
      const mediaDir = path.join(groupDir, 'media');
      if (fs.existsSync(mediaDir)) {
        try {
          fs.rmSync(mediaDir, { recursive: true, force: true });
          logger.debug({ group: group.name }, 'Session media cleaned up');
        } catch (err) {
          logger.warn(
            { group: group.name, err },
            'Failed to clean up session media',
          );
        }
      }

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
