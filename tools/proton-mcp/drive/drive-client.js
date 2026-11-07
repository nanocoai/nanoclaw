/**
 * Proton Drive client — wraps rclone's protondrive backend.
 * Uses execFile (not exec) to prevent shell injection.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const RCLONE_BIN = process.env.RCLONE_BIN || 'rclone';
const REMOTE = process.env.PROTON_DRIVE_REMOTE || 'protondrive:';

async function runRclone(args, { timeout = 60000 } = {}) {
  const { stdout } = await execFileAsync(RCLONE_BIN, args, {
    timeout,
    env: { ...process.env },
  });
  return stdout.trim();
}

export async function listFiles(remotePath = '') {
  const fullPath = `${REMOTE}${remotePath}`;
  const output = await runRclone(['lsjson', fullPath]);
  if (!output) return [];
  return JSON.parse(output);
}

export async function upload(localPath, remotePath) {
  await runRclone(['copy', localPath, `${REMOTE}${remotePath}`], { timeout: 300000 });
  return { success: true, remote_path: remotePath };
}

export async function uploadFolder(localPath, remotePath) {
  await runRclone(['copy', localPath, `${REMOTE}${remotePath}`], { timeout: 300000 });
  return { success: true, remote_path: remotePath };
}

export async function download(remotePath, localPath) {
  await runRclone(['copy', `${REMOTE}${remotePath}`, localPath], { timeout: 300000 });
  return { success: true, local_path: localPath };
}

export async function deleteRemote(remotePath) {
  // Determine if path is a file or directory
  try {
    await runRclone(['deletefile', `${REMOTE}${remotePath}`]);
  } catch {
    // If deletefile fails, try purge (for directories)
    await runRclone(['purge', `${REMOTE}${remotePath}`]);
  }
  return { success: true, deleted: remotePath };
}

export async function mkdir(remotePath) {
  await runRclone(['mkdir', `${REMOTE}${remotePath}`]);
  return { success: true, path: remotePath };
}
