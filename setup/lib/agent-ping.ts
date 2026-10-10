/**
 * Round-trip check against the CLI Unix socket.
 *
 * Used by `setup/auto.ts` to confirm the freshly-wired agent actually
 * responds before prompting the user to chat with it.
 *
 * Exit-code contract follows `scripts/chat.ts`:
 *   0  → got a reply on stdout
 *   2  → socket unreachable (service not running or wrong checkout)
 *   3  → no reply before chat.ts's own 120s hard stop
 *   4  → the reply was the runner's failure notice (the agent run failed)
 * This wrapper also guards with its own timeout in case chat.ts hangs.
 */
import { spawn } from 'child_process';

import { getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import * as setupLog from '../logs.js';
import { wrapForGutter } from './theme.js';

export const PING_AGENT_FOLDER = 'ping_test';

export type PingResult = 'ok' | 'no_reply' | 'socket_error' | 'auth_error' | 'agent_failure';

export interface PingOutcome {
  result: PingResult;
  /** The agent's own error line, when its failed run sent one. */
  detail?: string;
}

// The runner's notice when it has no error of its own to report; it tells the
// user nothing, so it is not shown. src/channels/cli.test.ts pins it to the runner.
export const GENERIC_FAILURE_NOTICE =
  "Sorry, something went wrong and I couldn't answer. Whoever runs this NanoClaw can look into it using the logs: https://docs.nanoclaw.dev/operate/troubleshooting#start-here";
const DETAIL_MAX_CHARS = 160;
const TROUBLESHOOTING_URL = 'https://docs.nanoclaw.dev/operate/troubleshooting#start-here';
const LOG_FILES = '`logs/nanoclaw.log` and `logs/nanoclaw.error.log`';

const PING_HINTS: Record<Exclude<PingResult, 'ok'>, string> = {
  no_reply: 'no reply in time; check logs/nanoclaw.log',
  socket_error: 'service not listening on data/cli.sock; restart it',
  auth_error: 'model credentials rejected; check them',
  agent_failure: 'agent run failed; check the model credentials (a common cause)',
};

// The only setup check that goes through the container, gateway and model.
// Log it so a failed reply isn't hidden behind earlier successes. The agent's
// error text stays on screen only, since setup.log gets shared in bug reports.
export function logFirstChat({ result }: PingOutcome, durationMs: number): void {
  if (result === 'ok') {
    setupLog.step('first-chat', 'success', durationMs, { RESULT: result });
    return;
  }
  setupLog.step('first-chat', 'failed', durationMs, { RESULT: result, HINT: PING_HINTS[result] });
}

const AUTH_ERROR_PATTERNS = [
  /Invalid bearer token/i,
  /authentication[_ ]error/i,
  /Failed to authenticate/i,
  /Please run \/login/i,
  /Not logged in/i,
  /Invalid API key/i,
];

export function classifyPingResult(exitCode: number | null, stdout: string, stderr = ''): PingResult {
  const output = `${stdout}\n${stderr}`;
  if (AUTH_ERROR_PATTERNS.some((re) => re.test(output))) return 'auth_error';
  if (exitCode === 2) return 'socket_error';
  if (exitCode === 4) return 'agent_failure';
  if (exitCode === 0 && stdout.trim().length > 0) return 'ok';
  return 'no_reply';
}

const TERMINAL_ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|[\x00-\x1f\x7f-\x9f]/g;

/**
 * Make an agent error line safe to print: no terminal escapes, one short line.
 * Not redacted: it is the same text the runner sends to every chat channel.
 */
export function sanitizeDetail(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.replace(/\t/g, ' ').replace(TERMINAL_ESCAPES, '').trim())
    .find((l) => l.length > 0);
  if (!line || line === GENERIC_FAILURE_NOTICE) return undefined;
  const chars = Array.from(line);
  return chars.length > DETAIL_MAX_CHARS ? `${chars.slice(0, DETAIL_MAX_CHARS - 1).join('')}…` : line;
}

interface PingReply {
  text: string;
  failureNotice: boolean;
}

// The chat client runs in raw-lines mode for the ping: one socket JSON line per stdout line.
function parseReplies(stdout: string): PingReply[] {
  const replies: PingReply[] = [];
  for (const line of stdout.split('\n')) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg && typeof msg === 'object' && typeof (msg as { text?: unknown }).text === 'string') {
      const m = msg as { text: string; failureNotice?: unknown };
      replies.push({ text: m.text, failureNotice: m.failureNotice === true });
    }
  }
  return replies;
}

/** Classify the chat client's raw-lines output and pick the reason to show, if any. */
export function pingOutcome(exitCode: number | null, stdout: string, stderr: string): PingOutcome {
  const replies = parseReplies(stdout);
  const text = replies.map((r) => r.text).join('\n');
  const result = classifyPingResult(exitCode, text, stderr);
  let detail: string | undefined;
  if (result === 'agent_failure') {
    detail = sanitizeDetail(replies.find((r) => r.failureNotice)?.text ?? '');
  } else if (result === 'auth_error') {
    const hit = `${text}\n${stderr}`.split('\n').find((l) => AUTH_ERROR_PATTERNS.some((re) => re.test(l)));
    detail = sanitizeDetail(hit ?? '');
  }
  return detail ? { result, detail } : { result };
}

export function pingCliAgent(timeoutMs = 30_000): Promise<PingOutcome> {
  return new Promise((resolve) => {
    // --silent keeps pnpm's banner out of stdout, which holds only replies.
    const child = spawn('pnpm', ['--silent', 'run', 'chat', 'ping'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NANOCLAW_CHAT_RAW_LINES: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ result: 'no_reply' });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(pingOutcome(code, stdout, stderr));
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ result: 'socket_error' });
    });
  });
}

export interface PingFailureCopy {
  spinner: string;
  note: string;
  assistMsg: string;
  assistHint: string;
}

/** Wizard text for a failed ping; shows the agent's own error when it sent one. */
export function pingFailureCopy({ result, detail }: PingOutcome): PingFailureCopy {
  if (result === 'socket_error') {
    return {
      spinner: "Couldn't reach the NanoClaw service.",
      note: [
        wrapForGutter(
          "The NanoClaw service isn't listening on its local socket. Try restarting it, then chat with `pnpm run chat hi`:",
          6,
        ),
        '',
        `  macOS:  launchctl kickstart -k gui/$(id -u)/${getLaunchdLabel()}`,
        `  Linux:  systemctl --user restart ${getSystemdUnit()}`,
      ].join('\n'),
      assistMsg: "NanoClaw service isn't listening on its CLI socket.",
      assistHint: 'Socket at data/cli.sock did not accept a connection.',
    };
  }
  if (result === 'agent_failure' || result === 'auth_error') {
    const reason = detail ? `It said: "${detail}".` : 'It sent no reason.';
    return {
      spinner: 'Your assistant started, but its run failed.',
      note: wrapForGutter(
        `Your assistant's run failed. ${reason} Wrong or expired model credentials are a common cause. To dig in, check ${LOG_FILES}, then try \`pnpm run chat hi\`. Guide: ${TROUBLESHOOTING_URL}`,
        6,
      ),
      assistMsg: 'The assistant replied with a failure notice instead of an answer.',
      assistHint: detail
        ? `The agent's error: ${detail}. Logs: logs/nanoclaw.log, logs/nanoclaw.error.log.`
        : 'The agent run failed without a reason. Check logs/nanoclaw.log and logs/nanoclaw.error.log; wrong or expired model credentials are a common cause.',
    };
  }
  return {
    spinner: "Your assistant didn't reply in time.",
    note: wrapForGutter(
      `No reply from your assistant within 30 seconds. Check ${LOG_FILES} for clues, then try \`pnpm run chat hi\`. Guide: ${TROUBLESHOOTING_URL}`,
      6,
    ),
    assistMsg: 'No reply from the assistant within 30 seconds.',
    assistHint: 'Agent container may be failing to start or authenticate.',
  };
}
