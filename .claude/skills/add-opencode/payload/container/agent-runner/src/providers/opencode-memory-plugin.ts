import {
  readOpenCodeMemory,
  runMemorySessionHook,
  writeOpenCodeMemory,
  openCodeMemoryDirectory,
} from './opencode-memory.js';

/** Local native plugin: these hooks are awaited before OpenCode continues its loop. */
export default async function nanoclawMemoryPlugin(
  plugin: {
    client?: {
      session: {
        get(params: {
          path: { id: string };
          signal?: AbortSignal;
        }): Promise<{ data?: { parentID?: string }; error?: unknown }>;
      };
    };
  },
  options?: { directory?: string },
) {
  const directory = options?.directory ?? openCodeMemoryDirectory();
  const snapshotFor = async (sessionId: string) => {
    let id: string | undefined = sessionId;
    for (let depth = 0; id && depth < 32; depth++) {
      const snapshot = readOpenCodeMemory(id, directory);
      if (snapshot) return snapshot;
      // Task subagents inherit only their actual ancestor's context. Native
      // title/summary helpers also call the transform with a scoped session ID.
      if (!plugin.client) return undefined;
      const response = await plugin.client.session.get({ path: { id }, signal: AbortSignal.timeout(5000) });
      if (response.error) throw new Error('OpenCode could not resolve inherited NanoClaw memory');
      id = response.data?.parentID;
    }
    return undefined;
  };
  return {
    'experimental.chat.system.transform': async (input: { sessionID?: string }, output: { system: string[] }) => {
      if (!input.sessionID) return;
      const snapshot = await snapshotFor(input.sessionID);
      if (!snapshot) return;
      const context = [snapshot.memory, snapshot.instructions, snapshot.reminder].filter(Boolean).join('\n\n');
      if (context) output.system.push(context);
    },
    'experimental.session.compacting': async (
      input: { sessionID: string },
      _output: { context: string[]; prompt?: string },
    ) => {
      const snapshot = await snapshotFor(input.sessionID);
      if (!snapshot) return;
      const memory = runMemorySessionHook(snapshot.hook, 'compact');
      // A failed renderer keeps the last verified snapshot. Successful empty output
      // clears it, so removing memory files cannot resurrect stale instructions.
      writeOpenCodeMemory(input.sessionID, { ...snapshot, memory: memory ?? snapshot.memory }, directory);
    },
  };
}
