/**
 * Signal-detector: two-pass ambient brain capture.
 *
 * Pattern adapted from gbrain v0.32.x signal-detector skill. Fires on every
 * text-bearing inbound envelope from the signal channel (and, in a follow-up,
 * Plaud/Gmail/Telegram/Slack ingestion paths).
 *
 * Two passes:
 *   1. Haiku 4.5 (cheap, fires on every message) — extracts entities, topics,
 *      and whether the message is the user speaking first-person content.
 *   2. Opus 4.7 (premium, fires only when the structural filter says
 *      "Bogdan was the speaker") — judges whether the content is original
 *      thinking worth filing, with quality grade and verbatim quote.
 *
 * Async + non-blocking — never delays the main signal channel handler. All
 * errors are isolated to this module; a detector failure does not break
 * message reception.
 *
 * Output: append-only JSONL at /Users/Shared/nanoclaw/data/signal-detector-candidates.jsonl
 * Bogdan reviews via `scripts/signal-detector-review.sh` (or directly in
 * Obsidian once the drainer ports it to the vault).
 */
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

import { getEffectiveMode } from './auth-state.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const HAIKU_MODEL =
  process.env.SIGNAL_DETECTOR_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
const OPUS_MODEL = process.env.SIGNAL_DETECTOR_OPUS_MODEL || 'claude-opus-4-8';

const CANDIDATES_PATH =
  process.env.SIGNAL_DETECTOR_CANDIDATES_PATH ||
  '/Users/Shared/nanoclaw/data/signal-detector-candidates.jsonl';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Beta header required when authenticating /v1/messages with a Claude Code
// OAuth token (Authorization: Bearer) instead of an API key.
const OAUTH_BETA = 'oauth-2025-04-20';

// Anthropic credential: either a Claude Code OAuth token (subscription) or a
// raw API key. The detector follows the shared auth posture (auth-state):
// subscription (OAuth) is primary, the API key is the failover. The credential
// proxy drives failover/recovery from agent traffic; the detector reads the
// same effective mode so ambient capture stays consistent with the main agent.
interface AnthropicCreds {
  mode: 'oauth' | 'api-key';
  token: string;
}

// Lazy-load the env tokens. Re-read while BOTH are missing so a credential
// added mid-process is picked up (failure mode observed 2026-05-12 14:46); once
// at least one token is present the env read is cached. The effective MODE is
// re-evaluated every call via getEffectiveMode() so failover/recovery is
// followed live. The miss-warning is rate-limited via `warnedMissing`.
let envCache: Record<string, string> | null = null;
let warnedMissing = false;
function getAnthropicCreds(): AnthropicCreds | null {
  if (
    !envCache ||
    (!envCache.CLAUDE_CODE_OAUTH_TOKEN && !envCache.ANTHROPIC_API_KEY)
  ) {
    envCache = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  }
  const oauth = envCache.CLAUDE_CODE_OAUTH_TOKEN;
  const apiKey = envCache.ANTHROPIC_API_KEY;
  // Subscription-primary: use OAuth unless the shared posture has failed over.
  if (getEffectiveMode() === 'oauth' && oauth) {
    warnedMissing = false;
    return { mode: 'oauth', token: oauth };
  }
  if (apiKey) {
    warnedMissing = false;
    return { mode: 'api-key', token: apiKey };
  }
  if (oauth) {
    warnedMissing = false;
    return { mode: 'oauth', token: oauth };
  }
  if (!warnedMissing) {
    logger.warn(
      'Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set in .env — signal-detector will skip until one is added (no restart needed; .env is re-checked on every call until found)',
    );
    warnedMissing = true;
  }
  return null;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: 'text'; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

async function callAnthropic(
  creds: AnthropicCreds,
  model: string,
  system: string,
  messages: AnthropicMessage[],
  maxTokens: number,
): Promise<AnthropicResponse | null> {
  const headers: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
  if (creds.mode === 'oauth') {
    headers['authorization'] = `Bearer ${creds.token}`;
    headers['anthropic-beta'] = OAUTH_BETA;
  } else {
    headers['x-api-key'] = creds.token;
  }
  try {
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      logger.warn(
        { status: resp.status, model, body: errText.slice(0, 200) },
        'signal-detector Anthropic API error',
      );
      return null;
    }
    return (await resp.json()) as AnthropicResponse;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), model },
      'signal-detector Anthropic API fetch failed',
    );
    return null;
  }
}

function textFromResponse(resp: AnthropicResponse | null): string {
  if (!resp) return '';
  return resp.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

/**
 * Best-effort JSON parser for LLM output. Handles fenced code blocks
 * (```json … ```) and stray prose around the JSON object.
 */
function parseJsonLoose<T>(text: string): T | null {
  if (!text) return null;
  let candidate = text.trim();
  // Strip ```json … ``` fences
  const fence = candidate.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) candidate = fence[1].trim();
  // Find the outermost { ... } if there's wrapping prose
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    candidate = candidate.slice(first, last + 1);
  }
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pass 1: Haiku — entity extraction
// ---------------------------------------------------------------------------

export interface HaikuResult {
  entities: string[];
  topics: string[];
  has_user_speaker_content: boolean;
}

const HAIKU_SYSTEM = `You extract structured information from a single message.
Return ONLY valid JSON, no commentary, no markdown fences.

Bogdan is a BD consultant at AppThrive.Ai. His clients are CleanerDNS / Quad9
(John Todd) and AppEsteem (Dennis Batchelder). Recognized entity types include
people, companies, projects, deals, topics.`;

async function runHaikuExtract(
  creds: AnthropicCreds,
  envelope: { text: string; source: string; noteToSelf: boolean },
): Promise<HaikuResult | null> {
  const userPrompt = `Extract from this Signal message:

Message text: """${envelope.text}"""
Sender phone: ${envelope.source}
Note-to-self (Bogdan to himself): ${envelope.noteToSelf}

Return JSON with these fields:
- entities: array of strings — distinct people, companies, projects, products explicitly mentioned. Use natural names (e.g., "John Todd", "CleanerDNS", "Brightspeed"), not phone numbers or @handles.
- topics: array of strings — subject topics in lowercase (e.g., "pricing", "compliance", "hiring", "partnership").
- has_user_speaker_content: boolean — true if the message text appears to be Bogdan speaking/writing his own reflections, thoughts, observations (vs. forwarded content, quoted email, logistics).

Return ONLY the JSON object.`;

  const resp = await callAnthropic(
    creds,
    HAIKU_MODEL,
    HAIKU_SYSTEM,
    [{ role: 'user', content: userPrompt }],
    400,
  );
  const text = textFromResponse(resp);
  const parsed = parseJsonLoose<HaikuResult>(text);
  if (!parsed) {
    logger.warn(
      { rawPreview: text.slice(0, 200) },
      'signal-detector Haiku response did not parse as JSON',
    );
    return null;
  }
  // Defensive normalization
  return {
    entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
    topics: Array.isArray(parsed.topics) ? parsed.topics.map(String) : [],
    has_user_speaker_content: !!parsed.has_user_speaker_content,
  };
}

// ---------------------------------------------------------------------------
// Pass 2: Opus — original-thinking judgment
// ---------------------------------------------------------------------------

export interface OpusResult {
  is_original_thinking: boolean;
  insight_quality: 'high' | 'medium' | 'low' | 'none';
  summary: string;
  exact_quote: string;
  suggested_filing: 'originals' | 'concepts' | 'ideas' | 'skip';
}

const OPUS_SYSTEM = `You evaluate whether a message contains original thinking
worth preserving in Bogdan's knowledge base. Bogdan is a BD consultant at
AppThrive.Ai working with CleanerDNS/Quad9 and AppEsteem.

ORIGINAL THINKING is:
- Bogdan's own theses, frameworks, strategic observations, novel arguments
- His judgment calls about deals, people, partnerships
- His distillation of a pattern across multiple conversations
- Strong opinions or unique angles

NOT ORIGINAL THINKING:
- Repeating known facts ("X is a DNS provider")
- Asking questions
- Logistics ("meeting at 3pm")
- Forwarded content
- One-line reactions ("interesting", "agreed")

Return ONLY valid JSON, no commentary, no markdown fences.`;

async function runOpusJudge(
  creds: AnthropicCreds,
  envelope: { text: string },
  haiku: HaikuResult,
): Promise<OpusResult | null> {
  const userPrompt = `Evaluate this Note-to-Self message from Bogdan:

"""${envelope.text}"""

Entities mentioned (Haiku pass): ${JSON.stringify(haiku.entities)}
Topics: ${JSON.stringify(haiku.topics)}

Return JSON:
{
  "is_original_thinking": true|false,
  "insight_quality": "high" | "medium" | "low" | "none",
  "summary": "one sentence summary of the insight, or empty string",
  "exact_quote": "the verbatim words from Bogdan that capture the insight, or empty",
  "suggested_filing": "originals" | "concepts" | "ideas" | "skip"
}

Filing rules:
- "originals" — Bogdan's own theses or strategic frameworks
- "concepts" — a reusable mental model or definition he's articulating
- "ideas" — a specific product/business idea
- "skip" — not worth filing

Quality grade: "high" only for ideas that genuinely add to his knowledge base. "medium" for solid observations. "low" for borderline. "none" if not original thinking.`;

  const resp = await callAnthropic(
    creds,
    OPUS_MODEL,
    OPUS_SYSTEM,
    [{ role: 'user', content: userPrompt }],
    600,
  );
  const text = textFromResponse(resp);
  const parsed = parseJsonLoose<OpusResult>(text);
  if (!parsed) {
    logger.warn(
      { rawPreview: text.slice(0, 200) },
      'signal-detector Opus response did not parse as JSON',
    );
    return null;
  }
  return {
    is_original_thinking: !!parsed.is_original_thinking,
    insight_quality: (parsed.insight_quality ||
      'none') as OpusResult['insight_quality'],
    summary: String(parsed.summary || ''),
    exact_quote: String(parsed.exact_quote || ''),
    suggested_filing: (parsed.suggested_filing ||
      'skip') as OpusResult['suggested_filing'],
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface CandidateRecord {
  detected_at: string;
  channel: string;
  envelope_timestamp: number | null;
  source: string;
  note_to_self: boolean;
  text: string;
  haiku: HaikuResult | null;
  opus: OpusResult | null;
  escalated_to_opus: boolean;
  escalation_reason: string | null;
}

export interface DetectorInput {
  channel: string;
  source: string;
  text: string;
  noteToSelf: boolean;
  envelopeTimestamp?: number;
  ownerPhone: string;
}

function appendCandidate(record: CandidateRecord): void {
  try {
    const dir = path.dirname(CANDIDATES_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(CANDIDATES_PATH, JSON.stringify(record) + '\n');
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        path: CANDIDATES_PATH,
      },
      'signal-detector failed to write candidate',
    );
  }
}

/**
 * Run both passes (or just Haiku if structural filter says not Bogdan-as-speaker).
 * Fully async; returns void. Errors are isolated — never throws.
 */
export async function runSignalDetector(input: DetectorInput): Promise<void> {
  const creds = getAnthropicCreds();
  if (!creds) return; // already logged once on first miss

  const text = input.text.trim();
  if (!text) return;

  // Pass 1: Haiku always.
  const haiku = await runHaikuExtract(creds, {
    text,
    source: input.source,
    noteToSelf: input.noteToSelf,
  });

  // Structural filter — decide whether to escalate to Opus.
  //
  // Three independent paths to escalation; ANY ONE suffices:
  //   (a) Note-to-Self envelope AND source matches owner (the Signal
  //       Note-to-Self pattern — verifiable from envelope properties).
  //   (b) Channel is in USER_VOICE_CHANNELS — the caller has pre-filtered
  //       to outbound (Bogdan-sent) messages. We trust the caller here
  //       since each sync script's filter is more specific than what
  //       signal-detector could re-derive (e.g., msg.out=True in Telegram,
  //       account match in Gmail).
  //   (c) Haiku independently flagged user-speaker content AND source
  //       matches owner — fallback for ambient inbound channels (Signal
  //       DMs from others, future inbound Gmail) where the caller hasn't
  //       pre-filtered.
  //
  // The structural filter is the routing decision; the Opus prompt itself
  // is what actually judges insight quality. False-positive escalations
  // just produce a "skip" verdict from Opus — wasted ~$0.01 but no
  // pollution of the candidates queue.
  const USER_VOICE_CHANNELS = new Set([
    'plaud',
    'gmail_outbound',
    'telegram_outbound',
    'slack_outbound',
  ]);
  const bogdanIsSpeaker = input.source === input.ownerPhone;
  const haikuSpeakerSignal = haiku?.has_user_speaker_content === true;
  const userVoiceChannel = USER_VOICE_CHANNELS.has(input.channel);
  const escalate =
    (bogdanIsSpeaker && input.noteToSelf) ||
    userVoiceChannel ||
    (bogdanIsSpeaker && haikuSpeakerSignal);

  let opus: OpusResult | null = null;
  let escalationReason: string | null = null;
  if (escalate) {
    escalationReason = input.noteToSelf
      ? 'note_to_self'
      : userVoiceChannel
        ? `user_voice_channel:${input.channel}`
        : 'bogdan_speaker_in_haiku';
    if (haiku) {
      opus = await runOpusJudge(creds, { text }, haiku);
    }
  }

  const record: CandidateRecord = {
    detected_at: new Date().toISOString(),
    channel: input.channel,
    envelope_timestamp: input.envelopeTimestamp ?? null,
    source: input.source,
    note_to_self: input.noteToSelf,
    text,
    haiku,
    opus,
    escalated_to_opus: escalate,
    escalation_reason: escalationReason,
  };
  appendCandidate(record);

  // One-line summary log so the loop is observable.
  if (opus) {
    logger.info(
      {
        channel: input.channel,
        entities: haiku?.entities.length ?? 0,
        topics: haiku?.topics.length ?? 0,
        insight: opus.insight_quality,
        filing: opus.suggested_filing,
      },
      'signal-detector candidate',
    );
  } else {
    logger.info(
      {
        channel: input.channel,
        entities: haiku?.entities.length ?? 0,
        topics: haiku?.topics.length ?? 0,
        escalated: false,
      },
      'signal-detector candidate (Haiku-only)',
    );
  }
}
