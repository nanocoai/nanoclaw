/**
 * Lean task runs — host half.
 *
 * Registers two task content fields: `--lean` marks a task whose turn runs
 * with minimal context, and `--render` names a command the final text is
 * piped through before delivery. The agent-runner half reads both from the
 * task envelope.
 */
import { registerTaskField } from '../scheduling/task-fields.js';

registerTaskField({
  flag: 'lean',
  contentKey: 'lean',
  type: 'boolean',
  description:
    'Run each fire with minimal context (no skills, memory, tools, MCP servers or resume); delivery through <message> and <card> blocks in the final text.',
});

registerTaskField({
  flag: 'render',
  contentKey: 'render',
  description:
    'Lean tasks only: shell command that receives the final text on stdin; its stdout is delivered instead. "none" clears it.',
  parse: (raw) => {
    const command = String(raw).trim();
    return command === '' || command === 'none' || command === 'null' ? null : command;
  },
});
