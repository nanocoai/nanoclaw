/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
// Module barrel — loads registration modules, including the singular mailbox slot.
import '../modules/index.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

async function main(): Promise<void> {
  const mailbox = getAgentMailbox();
  await mailbox.start(await readMailboxContext());
  try {
    await startMcpServer((action) => mailbox.run(action));
  } finally {
    await mailbox.stop();
  }
}

main().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
