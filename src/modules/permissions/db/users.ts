import type { User } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

export async function createUser(user: User): Promise<void> {
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, created_at)
     VALUES (@id, @kind, @display_name, @created_at)`,
    user,
  );
}

export async function upsertUser(user: User): Promise<void> {
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (@id, @kind, @display_name, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name)`,
    user,
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
