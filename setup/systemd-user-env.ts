export interface SystemdUserEnvDeps {
  uid: number | undefined;
  user: string | undefined;
  env: { XDG_RUNTIME_DIR?: string };
  exists: (path: string) => boolean;
}

export type SystemdUserEnvReason =
  | 'already_set'
  | 'no_user'
  | 'no_uid'
  | 'no_linger'
  | 'no_runtime_dir'
  | 'populated';

export interface SystemdUserEnvResult {
  reason: SystemdUserEnvReason;
  XDG_RUNTIME_DIR?: string;
  DBUS_SESSION_BUS_ADDRESS?: string;
}

export function computeUserSystemdEnv(
  deps: SystemdUserEnvDeps,
): SystemdUserEnvResult {
  if (deps.env.XDG_RUNTIME_DIR) return { reason: 'already_set' };
  if (!deps.user) return { reason: 'no_user' };
  if (typeof deps.uid !== 'number') return { reason: 'no_uid' };
  if (!deps.exists(`/var/lib/systemd/linger/${deps.user}`)) {
    return { reason: 'no_linger' };
  }
  const runtimeDir = `/run/user/${deps.uid}`;
  if (!deps.exists(runtimeDir)) return { reason: 'no_runtime_dir' };
  return {
    reason: 'populated',
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
  };
}
