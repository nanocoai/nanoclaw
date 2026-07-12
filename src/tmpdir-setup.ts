/**
 * Relocate the process temp dir off /tmp — must run before the first container spawn.
 *
 * The onecli SDK writes its proxy CA to `os.tmpdir()/onecli-proxy-ca.pem` and
 * bind-mounts it into every agent container. Under Docker Desktop/WSL2, /tmp is
 * volatile (wiped on WSL remount / Docker restart) AND sticky + root-owned, so
 * when the file vanishes mid-spawn the Docker daemon auto-creates the missing
 * bind source as a root-owned *directory* that our aburi-owned process can never
 * delete. Every later `writeFileSync` then hits EISDIR and no container spawns —
 * WhatsApp routes messages but nothing answers (the recurring "stuck" state).
 *
 * Pointing TMPDIR at a stable, aburi-owned ext4 dir removes the volatility and
 * lets the spawn-time guard in container-runner.ts self-heal any stray dir
 * (possible now because the parent is owned by us and non-sticky). os.tmpdir()
 * reads TMPDIR fresh on every call, so setting it here is sufficient. Kept on
 * ext4 (home dir), NOT drvfs, so Unix sockets under tmpdir keep working
 * (they fail with ENOTSUP on drvfs).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const NANOCLAW_TMPDIR = path.join(os.homedir(), '.cache', 'nanoclaw', 'tmp');

fs.mkdirSync(NANOCLAW_TMPDIR, { recursive: true });
process.env.TMPDIR = NANOCLAW_TMPDIR;
