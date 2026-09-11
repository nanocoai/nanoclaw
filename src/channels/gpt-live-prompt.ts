/**
 * Voice-side prompt for the voice channel.
 *
 * Two prompts exist on a call. The voice model's `instructions` (composed
 * here) say how to talk and *when to delegate*; the backend prompt is the
 * agent group's own CLAUDE.md, untouched. The composer reads the agent group
 * wired to the voice line — its display name and, when present, the persona
 * staged in `instructions.prepend.md` — so the voice model introduces itself
 * as the same assistant the user knows from chat.
 */
import path from 'node:path';

import { GROUPS_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { readGroupPersona } from '../group-persona.js';
import { log } from '../log.js';

export const GPT_LIVE_MODEL = 'gpt-live-1';

/** Live instructions are capped at 16,384 tokens; a persona is a fraction of that. */
const MAX_PERSONA_CHARS = 4000;

export interface VoiceAgent {
  name: string;
  personality?: string | null;
}

/** The fixed part of the voice prompt: talk style and the delegation policy. */
export function voiceInstructions(agent: VoiceAgent): string {
  const persona = (agent.personality ?? '').trim().slice(0, MAX_PERSONA_CHARS);
  return [
    `You are ${agent.name}, taking a live voice call for your user.`,
    persona ? `About you: ${persona}` : '',
    'How to talk: short natural sentences, one idea at a time, no markdown or symbols, no lists read aloud.',
    'When the call connects, greet the caller briefly and ask how you can help.',
    'You have a backend assistant that holds the user’s memory, files, calendar, tools and the ability to take actions.',
    'Delegate to the backend whenever the caller asks for anything about their world, anything that needs a lookup, a calculation, a schedule change, a message sent, or any other action. Never invent those answers.',
    'While the backend works, keep the caller company with a brief acknowledgement, then wait; do not fill the silence with guesses.',
    'Small talk, clarifying questions, and repeating what the backend already told you do not need delegation.',
    'When a backend result arrives, say it in your own words, briefly, and check whether the caller needs more.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Session config for a new call: client delegation, the composed voice prompt, one voice. */
export function sessionConfig(agent: VoiceAgent, voice: string): Record<string, unknown> {
  return {
    model: GPT_LIVE_MODEL,
    instructions: voiceInstructions(agent),
    audio: { output: { voice } },
    delegation: { type: 'client' },
  };
}

/**
 * The agent group wired to a voice line, read through core DB helpers: the
 * messaging group for this platform id, its first wiring, that agent group's
 * name and staged persona. `null` when nothing is wired yet — the caller
 * falls back to a generic name and the first delegation is what makes the
 * router escalate the unwired line to the owner.
 */
export async function resolveWiredAgent(platformId: string, instance?: string): Promise<VoiceAgent | null> {
  try {
    const mg = await getMessagingGroupByPlatform('voice', platformId, instance);
    if (!mg) return null;
    const wirings = await getMessagingGroupAgents(mg.id);
    const first = wirings[0];
    if (!first) return null;
    const group = await getAgentGroup(first.agent_group_id);
    if (!group) return null;
    const personality = readGroupPersona(path.join(GROUPS_DIR, group.folder));
    return { name: group.name, personality };
  } catch (err) {
    log.warn('gpt-live: could not resolve the wired agent; using the fallback name', { platformId, err });
    return null;
  }
}
