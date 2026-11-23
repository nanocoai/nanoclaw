/**
 * Chromium on Linux ignores NODE_EXTRA_CA_CERTS and SSL_CERT_FILE and trusts only
 * the system roots plus ~/.pki/nssdb, so a TLS-inspecting gateway's CA must be
 * imported there or every agent-browser page fails. HOME is per-container (--rm),
 * so the database is fresh on every spawn and always matches the mounted CA.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

type Run = (cmd: string, args: string[]) => void;

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

const defaultRun: Run = (cmd, args) => {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
};

export function trustGatewayCaForChromium(
  opts: {
    caPath?: string;
    home?: string;
    run?: Run;
    log?: (msg: string) => void;
  } = {},
): number {
  const caPath = opts.caPath ?? process.env.NODE_EXTRA_CA_CERTS;
  const home = opts.home ?? process.env.HOME ?? os.homedir();
  const run = opts.run ?? defaultRun;
  const log = opts.log ?? (() => {});
  if (!caPath || !fs.existsSync(caPath)) return 0;

  const nssDir = path.join(home, '.pki', 'nssdb');
  const db = `sql:${nssDir}`;
  try {
    const certs = fs.readFileSync(caPath, 'utf8').match(PEM_BLOCK) ?? [];
    if (certs.length === 0) return 0;
    fs.mkdirSync(nssDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(nssDir, 'cert9.db'))) {
      run('certutil', ['-N', '-d', db, '--empty-password']);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ca-'));
    try {
      certs.forEach((pem, i) => {
        const file = path.join(tmp, `${i}.pem`);
        fs.writeFileSync(file, pem + '\n');
        run('certutil', ['-A', '-d', db, '-n', `nanoclaw-gateway-ca-${i}`, '-t', 'C,,', '-i', file]);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    log(`Trusted ${certs.length} gateway CA certificate(s) for Chromium`);
    return certs.length;
  } catch (err) {
    // Never fatal: the agent still runs, only browser HTTPS through the gateway fails.
    log(`Could not add gateway CA to Chromium trust: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
