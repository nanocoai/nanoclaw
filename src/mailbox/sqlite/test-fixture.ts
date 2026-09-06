/** Explicit backend for tests that inspect SQLite mailbox files. The installed
 * composition remains in place for the real mailbox registration/contract tests. */
import { afterEach, beforeEach } from 'vitest';

export function useSqliteMailboxFixture(): void {
  let restore = () => {};
  beforeEach(async () => {
    // Tests may reset the module graph. Resolve the registry and implementation
    // together in that graph, rather than retaining an earlier singleton.
    const { registerAgentMailbox, resetAgentMailboxForTesting } = await import('../index.js');
    const { SqliteAgentMailbox } = await import('./index.js');
    const original = resetAgentMailboxForTesting();
    registerAgentMailbox(() => new SqliteAgentMailbox());
    restore = () => {
      resetAgentMailboxForTesting();
      if (original) registerAgentMailbox(original);
    };
  });
  afterEach(() => restore());
}
