/**
 * scripts/wa-qr-browser.ts — serve WhatsApp pairing QR in the browser.
 *
 * Wraps `setup/index.ts --step whatsapp-auth -- --method qr` and renders the
 * rotating QR string as a PNG in a small local HTTP page. Avoids the unreadable
 * ASCII terminal QR. macOS / desktop-Linux only — no headless support needed.
 *
 * Usage:
 *   pnpm exec tsx scripts/wa-qr-browser.ts [--clean] [--port 8765]
 *
 * --clean   rm -rf store/auth/ before spawning the auth step.
 * --port N  bind to port N (default 8765, falls back to a free port).
 */
import { spawn, exec } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';

type Status = 'waiting' | 'ready' | 'success' | 'failed';
type State = {
  qr: string | null;
  status: Status;
  error?: string;
  version: number;
};

const state: State = { qr: null, status: 'waiting', version: 0 };

const args = process.argv.slice(2);
const clean = args.includes('--clean');
const portIdx = args.indexOf('--port');
const requestedPort = portIdx >= 0 ? Number(args[portIdx + 1]) : 8765;

if (clean) {
  fs.rmSync(path.join(process.cwd(), 'store', 'auth'), {
    recursive: true,
    force: true,
  });
  console.log('[wa-qr-browser] cleaned store/auth/');
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>WhatsApp pairing</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
           font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #0b141a; color: #e9edef; }
    .card { background: #202c33; padding: 32px 40px; border-radius: 16px;
            box-shadow: 0 12px 36px rgba(0,0,0,0.4); text-align: center;
            min-width: 420px; }
    h1 { font-size: 18px; font-weight: 500; margin: 0 0 20px; color: #aebac1; }
    .qr-wrap { background: white; padding: 16px; border-radius: 12px;
               display: inline-block; }
    #qr { width: 360px; height: 360px; display: block; image-rendering: pixelated; }
    #status { margin-top: 20px; font-size: 14px; color: #8696a0; min-height: 20px; }
    #status.ok { color: #00d26a; font-size: 18px; font-weight: 500; }
    #status.err { color: #ff6b6b; }
    ol { text-align: left; color: #aebac1; font-size: 13px; line-height: 1.8;
         margin: 20px 0 0; padding-left: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Scan with WhatsApp</h1>
    <div class="qr-wrap"><img id="qr" alt="QR code" /></div>
    <div id="status">Waiting for QR…</div>
    <ol>
      <li>Open WhatsApp on your phone</li>
      <li>Settings &rarr; Linked Devices &rarr; Link a Device</li>
      <li>Point the camera at this QR code</li>
    </ol>
  </div>
  <script>
    let lastVersion = -1;
    const qr = document.getElementById('qr');
    const status = document.getElementById('status');
    async function tick() {
      try {
        const r = await fetch('/qr.json', { cache: 'no-store' });
        const s = await r.json();
        if (s.status === 'success') {
          qr.style.display = 'none';
          status.className = 'ok';
          status.textContent = '✓ Authenticated!';
          return;
        }
        if (s.status === 'failed') {
          qr.style.display = 'none';
          status.className = 'err';
          status.textContent = '✗ ' + (s.error || 'failed');
          return;
        }
        if (s.qr && s.version !== lastVersion) {
          lastVersion = s.version;
          qr.src = '/qr.png?v=' + s.version;
          status.textContent = 'QR ready — scan within ~20s';
        }
      } catch (e) { /* server closing, ignore */ }
      setTimeout(tick, 1500);
    }
    tick();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (url === '/' || url.startsWith('/?')) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(htmlPage());
    return;
  }
  if (url === '/qr.json') {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(state));
    return;
  }
  if (url.startsWith('/qr.png')) {
    if (!state.qr) {
      res.statusCode = 404;
      res.end();
      return;
    }
    try {
      const buf = await QRCode.toBuffer(state.qr, { width: 360, margin: 1 });
      res.setHeader('content-type', 'image/png');
      res.setHeader('cache-control', 'no-store');
      res.end(buf);
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
    return;
  }
  res.statusCode = 404;
  res.end();
});

function listen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port === requestedPort) {
        server.listen(0, () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') resolve(addr.port);
          else reject(new Error('unexpected address'));
        });
      } else {
        reject(err);
      }
    });
    server.listen(port, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('unexpected address'));
    });
  });
}

const port = await listen(requestedPort);
const url = `http://localhost:${port}`;
console.log(`[wa-qr-browser] QR server on ${url}`);

const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
exec(`${opener} ${url}`, (err) => {
  if (err) console.log(`[wa-qr-browser] could not auto-open browser: ${err.message}`);
  else console.log('[wa-qr-browser] opening browser…');
});

const child = spawn(
  'pnpm',
  ['exec', 'tsx', 'setup/index.ts', '--step', 'whatsapp-auth', '--', '--method', 'qr'],
  { stdio: ['inherit', 'pipe', 'inherit'] },
);

let stdoutBuf = '';
child.stdout.on('data', (chunk: Buffer) => {
  const text = chunk.toString();
  process.stdout.write(text);
  stdoutBuf += text;

  const blockRe = /=== NANOCLAW SETUP: (\w+) ===\n([\s\S]*?)\n=== END ===/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = blockRe.exec(stdoutBuf)) !== null) {
    const [, name, body] = m;
    const fields: Record<string, string> = {};
    for (const line of body.split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) fields[kv[1]] = kv[2];
    }
    handleBlock(name, fields);
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd > 0) stdoutBuf = stdoutBuf.slice(lastEnd);
});

function handleBlock(name: string, fields: Record<string, string>): void {
  if (name === 'WHATSAPP_AUTH_QR' && fields.QR) {
    state.qr = fields.QR;
    state.status = 'ready';
    state.version++;
    return;
  }
  if (name === 'WHATSAPP_AUTH') {
    if (fields.STATUS === 'success') {
      state.status = 'success';
      console.log('[wa-qr-browser] authenticated');
      setTimeout(() => server.close(() => process.exit(0)), 3000);
    } else if (fields.STATUS === 'skipped') {
      state.status = 'success';
      state.error = `already authenticated (${fields.REASON ?? 'unknown'})`;
      console.log(`[wa-qr-browser] ${state.error}`);
      setTimeout(() => server.close(() => process.exit(0)), 3000);
    } else if (fields.STATUS === 'failed') {
      state.status = 'failed';
      state.error = fields.ERROR ?? 'unknown error';
      console.error(`[wa-qr-browser] failed: ${state.error}`);
    }
  }
}

child.on('exit', (code) => {
  if (state.status === 'success') return;
  if (state.status !== 'failed') {
    state.status = 'failed';
    state.error = `auth process exited (code=${code ?? 'null'})`;
  }
  setTimeout(() => {
    server.close(() => process.exit(1));
  }, 3000);
});

process.on('SIGINT', () => {
  console.log('\n[wa-qr-browser] aborting…');
  child.kill('SIGTERM');
  server.close(() => process.exit(130));
});
