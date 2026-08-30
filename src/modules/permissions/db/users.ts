import type { User } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

export async function createUser(user: User): Promise<void> {
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, email, created_at)
     VALUES (@id, @kind, @display_name, @email, @created_at)`,
    {
      id: user.id,
      kind: user.kind,
      display_name: user.display_name ?? null,
      email: user.email ?? null,
      created_at: user.created_at,
    },
  );
}

export async function upsertUser(user: User): Promise<void> {
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, email, created_at)
       VALUES (@id, @kind, @display_name, @email, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name),
         email = COALESCE(excluded.email, users.email)`,
    {
      id: user.id,
      kind: user.kind,
      display_name: user.display_name ?? null,
      email: user.email ?? null,
      created_at: user.created_at,
    },
  );
}

export async function getUser(id: string): Promise<User | undefined> {
  return getDb().get<User>('SELECT * FROM users WHERE id = ?', id);
}

export async function getAllUsers(): Promise<User[]> {
  return getDb().all<User>('SELECT * FROM users ORDER BY created_at');
}

export async function updateDisplayName(id: string, displayName: string): Promise<void> {
  await getDb().run('UPDATE users SET display_name = ? WHERE id = ?', displayName, id);
}

export async function deleteUser(id: string): Promise<void> {
  await getDb().run('DELETE FROM users WHERE id = ?', id);
}
/** Persist the user's provisioned OneCLI project id (per-user credential isolation). */
export async function setUserProjectId(userId: string, projectId: string): Promise<void> {
await getDb().run('UPDATE users SET onecli_project_id = ? WHERE id = ?', projectId, userId);
}
/** The user whose DM this messaging group is, via the user_dms cache — used at
*  container spawn to resolve a DM session's OneCLI project. Undefined when the
*  messaging group isn't a known user DM. */
export async function getUserByDmMessagingGroup(messagingGroupId: string): Promise<User | undefined> {
return getDb().get<User>(
`SELECT u.* FROM users u
JOIN user_dms ud ON ud.user_id = u.id
WHERE ud.messaging_group_id = ?
LIMIT 1`,
messagingGroupId,
);
}
