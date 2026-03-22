/**
 * Step: whatsapp-auth — WhatsApp interactive auth (QR code / pairing code).
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { openBrowser, isHeadless } from './platform.js';
import { emitStatus } from './status.js';

const QR_AUTH_TEMPLATE = `<!DOCTYPE html>
<html><head><title>NanoClaw - WhatsApp Auth</title>
<meta http-equiv="refresh" content="3">
<style>
  body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h2 { margin: 0 0 8px; }
  .timer { font-size: 18px; color: #666; margin: 12px 0; }
  .timer.urgent { color: #e74c3c; font-weight: bold; }
  .instructions { color: #666; font-size: 14px; margin-top: 16px; }
  svg { width: 280px; height: 280px; }
</style></head><body>
<div class="card">
  <h2>Scan with WhatsApp</h2>
  <div class="timer" id="timer">Expires in <span id="countdown">60</span>s</div>
  <div id="qr">{{QR_SVG}}</div>
  <div class="instructions">Settings \\u2192 Linked Devices \\u2192 Link a Device</div>
</div>
<script>
  var startKey = 'nanoclaw_qr_start';
  var start = localStorage.getItem(startKey);
  if (!start) { start = Date.now().toString(); localStorage.setItem(startKey, start); }
  var elapsed = Math.floor((Date.now() - parseInt(start)) / 1000);
  var remaining = Math.max(0, 60 - elapsed);
  var countdown = document.getElementById('countdown');
  var timer = document.getElementById('timer');
  countdown.textContent = remaining;
  if (remaining <= 10) timer.classList.add('urgent');
  if (remaining <= 0) {
    timer.textContent = 'QR code expired \\u2014 a new one will appear shortly';
    timer.classList.add('urgent');
    localStorage.removeItem(startKey);
  }
</script></body></html>`;

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>NanoClaw - Connected!</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
  h2 { color: #27ae60; margin: 0 0 8px; }
  p { color: #666; }
  .check { font-size: 64px; margin-bottom: 16px; }
</style></head><body>
<div class="card">
  <div class="check">&#10003;</div>
  <h2>Connected to WhatsApp</h2>
  <p>You can close this tab.</p>
</div>
<script>localStorage.removeItem('nanoclaw_qr_start');</script>
</body></html>`;

function parseArgs(args: string[]): { method: string; phone: string } {
  let method = '';
  let phone = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--method' && args[i + 1]) {
      method = args[i + 1];
      i++;
    }
    if (args[i] === '--phone' && args[i + 1]) {
      phone = args[i + 1];
      i++;
    }
  }
  return { method, phone };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function getPhoneNumber(projectRoot: string): string {
  try {
    const creds = JSON.parse(
      fs.readFileSync(
        path.join(projectRoot, 'store', 'auth', 'creds.json'),
        'utf-8',
      ),
    );
    if (creds.me?.id) {
      return creds.me.id.split(':')[0].split('@')[0];
    }
  } catch {
    // Not available yet
  }
  return '';
}

function emitAuthStatus(
  method: string,
  authStatus: string,
  status: string,
  extra: Record<string, string> = {},
): void {
  const fields: Record<string, string> = {
    AUTH_METHOD: method,
    AUTH_STATUS: authStatus,
    ...extra,
    STATUS: status,
    LOG: 'logs/setup.log',
  };
  emitStatus('AUTH_WHATSAPP', fields);
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  const { method, phone } = parseArgs(args);
  const statusFile = path.join(projectRoot, 'store', 'auth-status.txt');
  const qrFile = path.join(projectRoot, 'store', 'qr-data.txt');

  if (!method) {
    emitAuthStatus('unknown', 'failed', 'failed', {
      ERROR: 'missing_method_flag',
    });
    process.exit(4);
  }

  // qr-terminal is a manual flow
  if (method === 'qr-terminal') {
    emitAuthStatus('qr-terminal', 'manual', 'manual', {
      PROJECT_PATH: projectRoot,
    });
    return;
  }

  if (method === 'pairing-code' && !phone) {
    emitAuthStatus('pairing-code', 'failed', 'failed', {
      ERROR: 'missing_phone_number',
    });
    process.exit(4);
  }

  if (!['qr-browser', 'pairing-code'].includes(method)) {
    emitAuthStatus(method, 'failed', 'failed', { ERROR: 'unknown_method' });
    process.exit(4);
  }

  // Clean stale state
  logger.info({ method }, 'Starting channel authentication');
  try {
    fs.rmSync(path.join(projectRoot, 'store', 'auth'), {
      recursive: true,
      force: true,
    });
  } catch {
    /* ok */
  }
  try {
    fs.unlinkSync(qrFile);
  } catch {
    /* ok */
  }
  try {
    fs.unlinkSync(statusFile);
  } catch {
    /* ok */
  }

  // Start auth process in background
  const authArgs =
    method === 'pairing-code'
      ? ['src/whatsapp-auth.ts', '--pairing-code', '--phone', phone]
      : ['src/whatsapp-auth.ts'];

  const authProc = spawn('npx', ['tsx', ...authArgs], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const logFile = path.join(projectRoot, 'logs', 'setup.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  authProc.stdout?.pipe(logStream);
  authProc.stderr?.pipe(logStream);

  // Cleanup on exit
  const cleanup = () => {
    try {
      authProc.kill();
    } catch {
      /* ok */
    }
  };
  process.on('exit', cleanup);

  try {
    if (method === 'qr-browser') {
      await handleQrBrowser(projectRoot, statusFile, qrFile);
    } else {
      await handlePairingCode(projectRoot, statusFile, phone);
    }
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
  }
}

async function handleQrBrowser(
  projectRoot: string,
  statusFile: string,
  qrFile: string,
): Promise<void> {
  // Poll for QR data (15s)
  let qrReady = false;
  for (let i = 0; i < 15; i++) {
    const statusContent = readFileSafe(statusFile);
    if (statusContent === 'already_authenticated') {
      emitAuthStatus('qr-browser', 'already_authenticated', 'success');
      return;
    }
    if (fs.existsSync(qrFile)) {
      qrReady = true;
      break;
    }
    await sleep(1000);
  }

  if (!qrReady) {
    emitAuthStatus('qr-browser', 'failed', 'failed', { ERROR: 'qr_timeout' });
    process.exit(3);
  }

  // Generate QR SVG and HTML
  const qrData = fs.readFileSync(qrFile, 'utf-8');
  try {
    const svg = execSync(
      `node -e "const QR=require('qrcode');const data='${qrData}';QR.toString(data,{type:'svg'},(e,s)=>{if(e)process.exit(1);process.stdout.write(s)})"`,
      { cwd: projectRoot, encoding: 'utf-8' },
    );
    const html = QR_AUTH_TEMPLATE.replace('{{QR_SVG}}', svg);
    const htmlPath = path.join(projectRoot, 'store', 'qr-auth.html');
    fs.writeFileSync(htmlPath, html);

    // Open in browser (cross-platform)
    if (!isHeadless()) {
      const opened = openBrowser(htmlPath);
      if (!opened) {
        logger.warn(
          'Could not open browser — display QR in terminal as fallback',
        );
      }
    } else {
      logger.info(
        'Headless environment — QR HTML saved but browser not opened',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to generate QR HTML');
  }

  // Poll for completion (120s)
  await pollAuthCompletion('qr-browser', statusFile, projectRoot);
}

async function handlePairingCode(
  projectRoot: string,
  statusFile: string,
  phone: string,
): Promise<void> {
  // Poll for pairing code (15s)
  let pairingCode = '';
  for (let i = 0; i < 15; i++) {
    const statusContent = readFileSafe(statusFile);
    if (statusContent === 'already_authenticated') {
      emitAuthStatus('pairing-code', 'already_authenticated', 'success');
      return;
    }
    if (statusContent.startsWith('pairing_code:')) {
      pairingCode = statusContent.replace('pairing_code:', '');
      break;
    }
    if (statusContent.startsWith('failed:')) {
      emitAuthStatus('pairing-code', 'failed', 'failed', {
        ERROR: statusContent.replace('failed:', ''),
      });
      process.exit(1);
    }
    await sleep(1000);
  }

  if (!pairingCode) {
    emitAuthStatus('pairing-code', 'failed', 'failed', {
      ERROR: 'pairing_code_timeout',
    });
    process.exit(3);
  }

  // Write to file immediately so callers can read it without waiting for stdout
  try {
    fs.writeFileSync(
      path.join(projectRoot, 'store', 'pairing-code.txt'),
      pairingCode,
    );
  } catch {
    /* non-fatal */
  }

  // Emit pairing code immediately so the caller can display it to the user
  emitAuthStatus('pairing-code', 'pairing_code_ready', 'waiting', {
    PAIRING_CODE: pairingCode,
  });

  // Poll for completion (120s)
  await pollAuthCompletion(
    'pairing-code',
    statusFile,
    projectRoot,
    pairingCode,
  );
}

async function pollAuthCompletion(
  method: string,
  statusFile: string,
  projectRoot: string,
  pairingCode?: string,
): Promise<void> {
  const extra: Record<string, string> = {};
  if (pairingCode) extra.PAIRING_CODE = pairingCode;

  for (let i = 0; i < 60; i++) {
    const content = readFileSafe(statusFile);

    if (content === 'authenticated' || content === 'already_authenticated') {
      // Write success page if qr-auth.html exists
      const htmlPath = path.join(projectRoot, 'store', 'qr-auth.html');
      if (fs.existsSync(htmlPath)) {
        fs.writeFileSync(htmlPath, SUCCESS_HTML);
      }
      const phoneNumber = getPhoneNumber(projectRoot);
      if (phoneNumber) extra.PHONE_NUMBER = phoneNumber;
      emitAuthStatus(method, content, 'success', extra);
      return;
    }

    if (content.startsWith('failed:')) {
      const error = content.replace('failed:', '');
      emitAuthStatus(method, 'failed', 'failed', { ERROR: error, ...extra });
      process.exit(1);
    }

    await sleep(2000);
  }

  emitAuthStatus(method, 'failed', 'failed', { ERROR: 'timeout', ...extra });
  process.exit(3);
}
