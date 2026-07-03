/**
 * PreCompact hook script — outputs custom compaction instructions to stdout.
 *
 * Claude Code captures the stdout of PreCompact shell hooks and passes it
 * as `customInstructions` to the compaction prompt. This ensures the
 * compaction summary preserves message routing context that the agent needs
 * to correctly address responses.
 *
 * Invoked by the PreCompact hook in .claude-shared/settings.json:
 *   "command": "bun /app/src/compact-instructions.ts"
 */
import { getAllDestinations } from './destinations.js';

const destinations = getAllDestinations();
const names = destinations.map((d) => d.name);

const instructions = [
  'Preserve the following in the compaction summary:',
  '',
  '1. For recent messages, keep the full XML structure including all attributes:',
  '   - <message from="..." sender="..." time="..."> for chat messages',
  '   - <task from="..." time="..." scheduled_for="..."> for scheduled tasks',
  '   - <webhook from="..." source="..." event="..."> for webhooks',
  '   The message content can be summarized if long, but the XML tags and attributes must remain.',
  '',
  '2. Preserve the chronological message/reply sequence of recent exchanges.',
  '   The agent needs to see: who said what, in what order, and from which destination.',
  '',
  '3. If the LATEST input (the message that triggered this turn) is a <task>',
  '   block, copy its full body — the "Instructions:" section — verbatim into',
  '   the summary. Without the original instructions the agent has nothing',
  '   concrete to act on after compaction and will silently end the turn.',
  '',
  '4. At the END of the compaction summary, include this verbatim reminder:',
  '   "You MUST wrap all responses in <message to="name">...</message> blocks.',
  `   Available destinations: ${names.length > 0 ? names.map((n) => `\`${n}\``).join(', ') : '(none)'}."`,
];

console.log(instructions.join('\n'));
