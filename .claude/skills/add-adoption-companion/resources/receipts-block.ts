/**
 * Pure, install-time block-mutation helper for the Memory Receipts companion tip
 * (Adoption Companion pack).
 *
 * String in, string out — no I/O, no core imports, never runs on the agent's
 * turn. The `/add-adoption-companion` SKILL reads a group's instructions.prepend.md,
 * calls these, and writes the result back. Block template + helper contract are
 * defined in the Memory Receipts design spec.
 */

/** Version of the shipped block template. Marker `v=N` must equal this. */
export const RECEIPTS_VERSION = 1;

type State = 'ON' | 'OFF';

/**
 * State a fresh install ships with. ON: installing the pack IS the opt-in —
 * an operator ran `/add-adoption-companion` for this tip, so landing OFF would
 * mean the feature they asked for does nothing until they discover a phrase to
 * turn it on. Also the fallback when an existing block's state line is
 * unreadable: unknown resolves to the shipped default, never to silence.
 */
const DEFAULT_STATE: State = 'ON';

const OPEN_RE = /<!-- adoption:receipts v=\d+ -->/g;
const CLOSE_RE = /<!-- \/adoption:receipts -->/g;
const BLOCK_RE = /<!-- adoption:receipts v=\d+ -->[\s\S]*?<!-- \/adoption:receipts -->/g;

/** Render the managed block for a given version and ON/OFF state. */
export function renderReceiptsBlock(version: number, state: State): string {
  return `<!-- adoption:receipts v=${version} -->
## Memory receipts

**Receipts: ${state}.**  (Flip this to ON when the user wants it, OFF when they ask to stop.)

Applies only when \`memory/index.md\` is your active memory store.

When **Receipts is ON** and you have just saved a NEW, meaningful durable fact
about the user to Core Memory (their identity, a hard preference, a key person
or project), tell them in one glanceable message using \`send_card\`:

- title: "📝 Noted"; description: the fact in plain, everyday language.
- Several new facts in one turn → ONE card with a short bullet list, not many.
- Provide \`fallbackText\` (e.g. "📝 Noted: <fact>. Tell me if that's wrong.").
- Display only. Do not block, do not use \`ask_user_question\`, do not rely on
  buttons. If the user later corrects it, update memory per your memory
  definition (prune/replace) — no receipt needed for the correction itself.

Do NOT receipt: routine or low-signal notes, facts the user just stated this
turn, or updates to already-confirmed facts. Never mention files, folders, or
"memory" internals — this is a sticky note, not a log.

This works on any turn, including the FIRST message of a session: your Core
Memory and this state line are loaded every time, so you never need prior
conversation to save a fact or receipt it. When a message carries a durable
fact, address the message and persist the fact — do not open with a generic
greeting instead of engaging with what the user said.

When the user asks to turn it on or off ("stop telling me what you learned" /
"tell me when you learn about me"), honor it THIS session immediately — you are
reading the live state right now, so no restart is needed and never say one is.
Also edit the **Receipts:** line above to ON or OFF so the choice persists into
future sessions.
<!-- /adoption:receipts -->`;
}

function assertBalanced(text: string): void {
  const opens = (text.match(OPEN_RE) || []).length;
  const closes = (text.match(CLOSE_RE) || []).length;
  if (opens !== closes) {
    throw new Error('Malformed adoption:receipts block: unbalanced markers (leaving file untouched)');
  }
}

/** Read the current ON/OFF value from the first block; no readable value → DEFAULT_STATE. */
function extractState(text: string): State {
  const block = text.match(/<!-- adoption:receipts v=\d+ -->[\s\S]*?<!-- \/adoption:receipts -->/)?.[0];
  if (!block) return DEFAULT_STATE;
  const m = block.match(/\*\*Receipts:\s*(ON|OFF)\b/i);
  return m ? (m[1].toUpperCase() as State) : DEFAULT_STATE;
}

/**
 * Install or refresh the receipts block. Idempotent: existing block(s) are
 * removed and one fresh block is appended, preserving the current ON/OFF state.
 * A fresh install (no prior block) ships DEFAULT_STATE.
 */
export function applyReceiptsBlock(text: string, opts?: { version?: number }): string {
  assertBalanced(text);
  const version = opts?.version ?? RECEIPTS_VERSION;
  const state = extractState(text);
  const base = text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  const block = renderReceiptsBlock(version, state);
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/** Remove every receipts block; leave all other content (incl. sibling adoption:* blocks) intact. */
export function removeReceiptsBlock(text: string): string {
  assertBalanced(text);
  if (!/<!-- adoption:receipts v=\d+ -->/.test(text)) return text;
  const stripped = text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n');
  return stripped.trim() ? `${stripped.trimEnd()}\n` : '';
}
