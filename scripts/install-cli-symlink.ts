/**
 * scripts/install-cli-symlink.ts — (re)install the ~/.local/bin/ncl symlink.
 *
 * Usage:
 *   pnpm exec tsx scripts/install-cli-symlink.ts
 *
 * Fresh installs get this via the `service` setup step. Upgrade paths
 * (/update-nanoclaw, /migrate-from-v1) don't run that step, so they call
 * this script directly after validation to keep `ncl` on PATH across
 * upgrades. Best-effort and non-fatal — same as installCliSymlink itself.
 */
import os from 'os';

import { installCliSymlink } from '../setup/service.js';

installCliSymlink(process.cwd(), os.homedir());
