/**
 * Shared "who's connecting this channel?" prompt used by the channel setup
 * drivers before they hand off to scripts/init-first-agent.ts.
 *
 * Default: owner. Self-hosted NanoClaw is almost always a single-operator
 * deployment, and granting the same human owner status on every channel
 * they wire up matches what you'd want 99% of the time. The prompt
 * surfaces admin/member for the edge cases (shared instance, collaborators
 * with limited access), but hitting Enter assigns owner.
 */
import { brightSelect } from './bright-select.js';
import { ensureAnswer } from './runner.js';

export type OperatorRole = 'owner' | 'admin' | 'member';

export async function askOperatorRole(channelLabel: string): Promise<OperatorRole> {
  const choice = ensureAnswer(
    await brightSelect<OperatorRole>({
      message: `How should this ${channelLabel} account be registered?`,
      initialValue: 'owner',
      options: [
        {
          value: 'owner',
          label: 'Owner',
          hint: 'full access — recommended for your own account',
        },
        {
          value: 'admin',
          label: 'Admin',
          hint: 'can manage the agent for this channel',
        },
        {
          value: 'member',
          label: 'Member',
          hint: 'can chat with the agent but nothing more',
        },
      ],
    }),
  );
  return choice;
}
