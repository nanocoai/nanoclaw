/**
 * The host's one setting for session surfaces: whether a new sandbox gets
 * a chat surface opened for it automatically. On by default; `ncl sandboxes
 * surface disable` turns it off for this host and keeps it off across
 * restarts, `surface enable` turns it back on. Existing surfaces are not
 * touched either way — the setting only decides what `sandboxes new` does.
 * Journaled at `data/session-surface.json` (mode 0600); a missing file is
 * the default.
 */
import path from 'node:path';

import { readJson, writePrivate } from '../../../community-portal/private-file.js';
import { DATA_DIR } from '../../../config.js';

export interface SurfaceSetting {
  version: 1;
  /** Open a surface for every new sandbox the service offers one for. */
  autoOpen: boolean;
  updatedAt: string;
}

export const SURFACE_SETTING_FILE = path.join(DATA_DIR, 'session-surface.json');

export async function readSurfaceSetting(file = SURFACE_SETTING_FILE): Promise<SurfaceSetting> {
  const saved = await readJson<SurfaceSetting>(file);
  if (saved && saved.version === 1 && typeof saved.autoOpen === 'boolean') return saved;
  return { version: 1, autoOpen: true, updatedAt: '' };
}

/** Whether `sandboxes new` opens a surface on this host. */
export async function surfaceAutoOpen(file = SURFACE_SETTING_FILE): Promise<boolean> {
  return (await readSurfaceSetting(file)).autoOpen;
}

export async function setSurfaceAutoOpen(autoOpen: boolean, file = SURFACE_SETTING_FILE): Promise<SurfaceSetting> {
  const setting: SurfaceSetting = { version: 1, autoOpen, updatedAt: new Date().toISOString() };
  await writePrivate(file, setting);
  return setting;
}
