import type { UserDm } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

export async function upsertUserDm(row: UserDm): Promise<void> {
  await getDb().run(
    `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (@user_id, @channel_type, @messaging_group_id, @resolved_at)
       ON CONFLICT(user_id, channel_type) DO UPDATE SET
         messaging_group_id = excluded.messaging_group_id,
         resolved_at = excluded.resolved_at`,
    row,
  );
}

export async function getUserDm(userId: string, channelType: string): Promise<UserDm | undefined> {
  return getDb().get<UserDm>('SELECT * FROM user_dms WHERE user_id = ? AND channel_type = ?', userId, channelType);
}

export async function getUserDmsForUser(userId: string): Promise<UserDm[]> {
  return getDb().all<UserDm>('SELECT * FROM user_dms WHERE user_id = ?', userId);
}

export async function deleteUserDm(userId: string, channelType: string): Promise<void> {
  await getDb().run('DELETE FROM user_dms WHERE user_id = ? AND channel_type = ?', userId, channelType);
}
