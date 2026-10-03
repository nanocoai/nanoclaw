/**
 * Claude Code Service — Host HTTP daemon
 *
 * Lightweight HTTP server that spawns the Claude Code CLI on behalf of
 * container agents. Agents call this via the claude-code-proxy MCP bridge.
 *
 * - POST /invoke — run a Claude Code task
 * - GET  /health — health check
 *
 * Security: CWD allowlist prevents agents from accessing arbitrary directories.
 * Concurrency: one active invocation at a time (queued requests are rejected).
 */
import http from 'http';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

const CLAUDE_CODE_PORT = 8282;

// Directories Claude Code is allowed to work in.
// Configurable — add paths here as needed.
const CWD_ALLOWLIST = [
  process.env.HOME || '/Users/nanoclaw',
];

let server: http.Server | null = null;
let activeInvocation = false;

interface InvokeRequest {
  prompt: string;
  cwd: string;
  model?: string;
  sessionId?: string;
}

interface InvokeResponse {
  status: 'success' | 'error';
  result: string | null;
  sessionId?: string;
  costUsd?: number;
  durationMs: number;
  error?: string;
}

/**
 * Find the claude CLI binary.
 * Checks common locations since launchd has a minimal PATH.
 */
function claudeBin(): string {
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback to PATH lookup
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code');
  }
}

/**
 * Validate that the requested CWD is within the allowlist.
 */
function isAllowedCwd(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  return CWD_ALLOWLIST.some(allowed => {
    const resolvedAllowed = path.resolve(allowed);
    return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + path.sep);
  });
}

/**
 * Handle POST /invoke — spawn claude CLI and return the result.
 */
async function handleInvoke(body: string): Promise<InvokeResponse> {
  const startTime = Date.now();

  let req: InvokeRequest;
  try {
    req = JSON.parse(body);
  } catch {
    return { status: 'error', result: null, durationMs: 0, error: 'Invalid JSON body' };
  }

  if (!req.prompt || !req.cwd) {
    return { status: 'error', result: null, durationMs: 0, error: 'Missing required fields: prompt, cwd' };
  }

  if (!isAllowedCwd(req.cwd)) {
    return {
      status: 'error',
      result: null,
      durationMs: 0,
      error: `CWD "${req.cwd}" is not in the allowlist. Allowed: ${CWD_ALLOWLIST.join(', ')}`,
    };
  }

  if (activeInvocation) {
    return { status: 'error', result: null, durationMs: 0, error: 'Another invocation is already in progress' };
  }

  activeInvocation = true;

  try {
    const bin = claudeBin();
    // -p (print mode) runs non-interactively and exits.
    // --dangerously-skip-permissions prevents interactive permission prompts
    // that would hang in headless mode. CWD is set via execFile's cwd option.
    const args = [
      '-p', req.prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ];

    if (req.model) {
      args.push('--model', req.model);
    }
    if (req.sessionId) {
      args.push('--resume', req.sessionId);
    }

    logger.info({ prompt: req.prompt.slice(0, 200), cwd: req.cwd, model: req.model }, 'Claude Code invocation starting');

    // Build env: read auth tokens from .env since launchd has a minimal environment.
    const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...secrets,
    };
    // Strip CLAUDECODE to prevent "nested session" detection.
    delete env.CLAUDECODE;

    // Use spawn with stdin set to 'ignore' — execFile leaves stdin open as a
    // pipe which causes the CLI to hang waiting for input in non-TTY contexts.
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: req.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });

      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Claude Code invocation timed out after 5 minutes'));
      }, 300_000);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Claude Code exited with code ${code}. stderr: ${stderr.slice(0, 500)}`));
        } else {
          resolve({ stdout, stderr });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    if (stderr) {
      logger.debug({ stderr: stderr.slice(0, 500) }, 'Claude Code stderr');
    }

    const durationMs = Date.now() - startTime;

    // Try to parse JSON output for structured result
    let result: string | null = null;
    let sessionId: string | undefined;
    let costUsd: number | undefined;

    try {
      const parsed = JSON.parse(stdout);
      result = parsed.result || stdout;
      sessionId = parsed.session_id;
      costUsd = parsed.cost_usd;
    } catch {
      // Not JSON — return raw output
      result = stdout.trim();
    }

    logger.info({ durationMs, resultLength: result?.length }, 'Claude Code invocation complete');

    return { status: 'success', result, sessionId, costUsd, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, durationMs }, 'Claude Code invocation failed');
    return { status: 'error', result: null, durationMs, error: errorMsg };
  } finally {
    activeInvocation = false;
  }
}

/**
 * Start the Claude Code HTTP service.
 */
export function startClaudeCodeService(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server) {
      logger.warn('Claude Code service already running');
      resolve();
      return;
    }

    // Verify CLI is installed before starting
    try {
      claudeBin();
    } catch (err) {
      logger.error({ err }, 'Claude Code CLI not available, service will not start');
      resolve(); // Don't block startup
      return;
    }

    server = http.createServer(async (req, res) => {
      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', active: activeInvocation }));
        return;
      }

      // Invoke
      if (req.method === 'POST' && req.url === '/invoke') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const result = await handleInvoke(body);
            res.writeHead(result.status === 'success' ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', result: null, error: 'Internal server error' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(CLAUDE_CODE_PORT, '0.0.0.0', () => {
      logger.info({ port: CLAUDE_CODE_PORT }, 'Claude Code service started');
      resolve();
    });

    server.on('error', (err) => {
      logger.error({ err }, 'Claude Code service error');
      server = null;
      reject(err);
    });
  });
}

/**
 * Stop the Claude Code HTTP service.
 */
export function stopClaudeCodeService(): void {
  if (server) {
    server.close();
    server = null;
    logger.info('Claude Code service stopped');
  }
}

export const CLAUDE_CODE_HTTP_PORT = CLAUDE_CODE_PORT;
