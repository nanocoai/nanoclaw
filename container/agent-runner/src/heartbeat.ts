import fs from 'fs';

const HEARTBEAT_PATH = '/workspace/.heartbeat';

export function touchHeartbeat(): void {
  const now = new Date();
  try {
    fs.utimesSync(HEARTBEAT_PATH, now, now);
  } catch {
    try {
      fs.writeFileSync(HEARTBEAT_PATH, '');
    } catch {
      // Parent may not exist in tests.
    }
  }
}
