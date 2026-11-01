import { isProviderAuthFailureText } from './auth-failure.js';
import { getProviderRuntimeContract } from './provider-registry.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { AgentProvider, AgentQuery, ImageContentBlock, ProviderEvent, QueryInput } from './types.js';

function log(message: string): void {
  console.error(`[usage-limit-fallback] ${message}`);
}

export interface FallbackProviderConfig {
  primaryName: string;
  fallbackName: string;
  fallbackModel?: string;
  primary: AgentProvider;
  fallback: AgentProvider;
  /** Observes each primary→alternate switch (operator alerting). Must not throw. */
  onFailover?: (info: FailoverInfo) => void | Promise<void>;
  /**
   * Read-only view of what the current turn already wrote to the outbox.
   * Without it a mid-turn switch can only see streamed provider events, not
   * MCP-tool sends, and the alternate re-answers a question the user already
   * has an answer to (AI Friends, 2026-10-08).
   */
  turnLedger?: FailoverTurnLedger;
}

/** Outbound rows recorded for one turn, oldest first. */
export interface FailoverTurnLedger {
  /** Opaque cursor captured when a query starts. */
  cursor(): string;
  /** Rows written after `cursor` (chat sends and host system actions). */
  since(cursor: string): ReadonlyArray<{ kind: string; content: string }>;
}

export type FailoverReason = 'quota' | 'auth';

export interface FailoverInfo {
  reason: FailoverReason;
  from: string;
  to: string;
  /** Provider text that triggered the switch. */
  detail: string;
}

export interface UsageLimitFallbackSelection {
  providerName: 'claude' | 'codex' | 'pi_rpc';
  model?: string;
}

/**
 * Resolve Optimus-style Claude↔Codex failover from the container env.
 *
 * Pi runs both model families itself, so a Pi agent stays on Pi and switches
 * family: an OpenAI (Codex) model falls back to the Claude family default and
 * an Anthropic model to the GPT one. `primaryModel` is the Pi model
 * (`provider/model`, or a bare id) the agent runs on.
 */
export function resolveUsageLimitFallback(
  primaryName: string,
  env: Record<string, string | undefined> = process.env,
  primaryModel?: string,
): UsageLimitFallbackSelection | null {
  if (env.NANOCLAW_USAGE_LIMIT_FALLBACK !== '1') return null;
  if (primaryName === 'pi_rpc') {
    const model = (primaryModel || env.NANOCLAW_AGENT_MODEL || env.NANOCLAW_MODEL || '').trim();
    const family = model.includes('/') ? model.slice(0, model.indexOf('/')) : model;
    const claude = env.NANOCLAW_USAGE_LIMIT_CLAUDE_MODEL?.trim();
    const codex = env.NANOCLAW_USAGE_LIMIT_CODEX_MODEL?.trim();
    if (/^(openai|gpt)/i.test(family)) return claude ? { providerName: 'pi_rpc', model: `anthropic/${claude}` } : null;
    if (/^(anthropic|claude)/i.test(family) || !model) {
      return codex ? { providerName: 'pi_rpc', model: `openai-codex/${codex}` } : null;
    }
    return null;
  }
  if (primaryName === 'claude') {
    return {
      providerName: 'codex',
      model: env.NANOCLAW_USAGE_LIMIT_CODEX_MODEL?.trim() || undefined,
    };
  }
  if (primaryName === 'codex') {
    return {
      providerName: 'claude',
      model: env.NANOCLAW_USAGE_LIMIT_CLAUDE_MODEL?.trim() || undefined,
    };
  }
  return null;
}

/**
 * True only for provider events that explicitly identify an account quota or
 * usage-limit failure. Ordinary retryable transport/API errors stay on their
 * existing retry path and never cross providers.
 */
export function isUsageLimitEvent(event: ProviderEvent): boolean {
  return event.type === 'error' && event.classification === 'quota';
}

/**
 * True for a terminal error result that says the provider rejected our
 * credential (e.g. `401 OAuth access token has been revoked`). Like a quota
 * failure it is account-level and deterministic — retrying the same provider
 * cannot succeed until an operator rotates the token — so it is failover
 * eligible. Danielle DM, 2026-09-24: the revoked Claude token left a
 * time-sensitive question unanswered while Codex was healthy.
 */
export function isAuthFailureEvent(event: ProviderEvent): boolean {
  return (
    event.type === 'result' &&
    event.isError === true &&
    isProviderAuthFailureText([event.text, event.error].filter(Boolean).join('\n'))
  );
}

function failoverReason(event: ProviderEvent): FailoverReason | null {
  if (isUsageLimitEvent(event)) return 'quota';
  if (isAuthFailureEvent(event)) return 'auth';
  return null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const HANDOFF_MESSAGE_CHARS = 1500;
const HANDOFF_TOTAL_CHARS = 6000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

/** What the abandoned primary visibly completed before the switch. */
export interface PrimaryTurnWork {
  /** Chat texts already written to the outbox this turn, oldest first. */
  delivered: string[];
  /** Host system actions requested this turn (name → count). */
  actions: Map<string, number>;
}

export function summarizeTurnLedger(rows: ReadonlyArray<{ kind: string; content: string }>): PrimaryTurnWork {
  const delivered: string[] = [];
  const actions = new Map<string, number>();
  for (const row of rows) {
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(row.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      // Malformed rows are not evidence of completed work.
    }
    if (!payload) continue;
    if (row.kind === 'chat') {
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      const files = Array.isArray(payload.files) ? payload.files.length : 0;
      if (text) delivered.push(text);
      else if (files > 0) delivered.push(`[${files} file attachment(s)]`);
    } else if (row.kind === 'system' && typeof payload.action === 'string') {
      actions.set(payload.action, (actions.get(payload.action) ?? 0) + 1);
    }
  }
  return { delivered, actions };
}

/**
 * Prompt preamble for an alternate provider taking over a turn the primary had
 * already acted on. The alternate starts on a fresh ephemeral thread, so
 * without this it sees only the original request and answers it again.
 */
export function buildFailoverHandoff(options: {
  from: string;
  reason: FailoverReason;
  work: PrimaryTurnWork;
  producedOutput: boolean;
}): string | null {
  const { from, reason, work, producedOutput } = options;
  if (work.delivered.length === 0 && work.actions.size === 0 && !producedOutput) return null;
  const why = reason === 'auth' ? 'a credential failure' : 'a usage/rate limit';
  const lines = [
    '[Runtime failover handoff — read before acting]',
    `This turn started on ${from}, which stopped mid-turn because of ${why} after it had already begun working. ` +
      'You are continuing that SAME turn, not starting a new one.',
  ];
  if (work.delivered.length > 0) {
    lines.push('', 'Already delivered to the chat in this turn (the recipients have seen these, verbatim):');
    let budget = HANDOFF_TOTAL_CHARS;
    work.delivered.forEach((text, index) => {
      if (budget <= 0) return;
      const shown = clip(text, Math.min(HANDOFF_MESSAGE_CHARS, budget));
      budget -= shown.length;
      lines.push(`${index + 1}. <<<${shown}>>>`);
    });
  } else {
    lines.push('', 'Nothing has been delivered to the chat yet in this turn.');
  }
  if (work.actions.size > 0) {
    const actions = [...work.actions].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');
    lines.push(`Host actions ${from} already requested in this turn: ${actions}.`);
  }
  lines.push('', 'Rules for the rest of this turn:');
  if (work.delivered.length > 0) {
    lines.push(
      '- Do not resend, restate, rephrase, correct-by-repetition or re-acknowledge anything delivered above.',
      '- If the delivered messages already answer the request, end the turn now with exactly ' +
        '`<internal>silent turn</internal>` and no `<message>` block. The "never silent when addressed" rule is ' +
        'already satisfied by the reply above.',
      '- Otherwise send only what is still missing (for example, the answer an acknowledgement promised).',
    );
  }
  lines.push(
    `- ${from} may also have run tools that left no chat trace. Check current state before repeating any ` +
      'side-effecting action (sends, bookings, schedules, file or memory writes).',
    '',
  );
  return lines.join('\n');
}

/**
 * Wrap two providers so an account usage-limit from the standing provider is
 * swallowed and the same turn is retried once on the alternate provider.
 *
 * The fallback continuation is deliberately ephemeral. The poll-loop stores
 * continuations under the standing provider name; allowing the alternate
 * provider's init event through would persist an incompatible thread id under
 * that key. Suppressing fallback init events keeps the standing provider's
 * session intact while the alternate harness completes the user's turn.
 */
export class UsageLimitFallbackProvider implements AgentProvider {
  readonly supportsNativeSlashCommands: boolean;

  private readonly primaryName: string;
  private readonly fallbackName: string;
  private readonly fallbackModel?: string;
  private readonly primary: AgentProvider;
  private readonly fallback: AgentProvider;
  private readonly onFailover?: (info: FailoverInfo) => void | Promise<void>;
  private readonly turnLedger?: FailoverTurnLedger;
  private preferFallback = false;
  private fallbackCause: { reason: FailoverReason; detail: string } | null = null;

  constructor(config: FallbackProviderConfig) {
    this.primaryName = config.primaryName;
    this.fallbackName = config.fallbackName;
    this.fallbackModel = config.fallbackModel;
    this.primary = config.primary;
    this.fallback = config.fallback;
    this.onFailover = config.onFailover;
    this.turnLedger = config.turnLedger;
    const contract = getProviderRuntimeContract(config.primaryName);
    this.supportsNativeSlashCommands = contract
      ? contract.commands.formatting === 'native'
      : (config.primary as AgentProvider & { supportsNativeSlashCommands?: boolean }).supportsNativeSlashCommands ===
        true;
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.primary.registerMemorySessionHook(hook);
    this.fallback.registerMemorySessionHook(hook);
  }

  query(input: QueryInput): AgentQuery {
    const ledger = this.turnLedger;
    let ledgerCursor: string | null = null;
    try {
      ledgerCursor = ledger?.cursor() ?? null;
    } catch (err) {
      log(`turn ledger cursor unavailable: ${errorText(err)}`);
    }
    const primaryWork = (): PrimaryTurnWork => {
      if (!ledger || ledgerCursor === null) return { delivered: [], actions: new Map() };
      try {
        return summarizeTurnLedger(ledger.since(ledgerCursor));
      } catch (err) {
        log(`turn ledger read failed: ${errorText(err)}`);
        return { delivered: [], actions: new Map() };
      }
    };
    const fallbackInput = (
      handoff: string | null = null,
      first: { message: string; imageBlocks?: ImageContentBlock[] } = {
        message: input.prompt,
        imageBlocks: input.imageBlocks,
      },
    ): QueryInput => ({
      ...input,
      prompt: handoff ? `${handoff}\n${first.message}` : first.message,
      imageBlocks: first.imageBlocks,
      continuation: undefined,
      systemContext: {
        ...input.systemContext,
        instructions:
          `${input.systemContext?.instructions ?? ''}\n\n` +
          `[Runtime failover: this turn is running on provider ${this.fallbackName}` +
          `${this.fallbackModel ? ` with model ${this.fallbackModel}` : ''}.]`,
      },
    });
    let activeProvider = this.preferFallback ? this.fallback : this.primary;
    let activeQuery = activeProvider.query(activeProvider === this.fallback ? fallbackInput() : input);
    const fallbackProvider = this.fallback;
    const primaryName = this.primaryName;
    const fallbackName = this.fallbackName;
    const dualLimitText =
      (this.primaryName === this.fallbackName
        ? 'Both model providers have reached their usage limits. '
        : `Both ${this.primaryName} and ${this.fallbackName} have reached their usage limits. `) +
      'Please try again after one of the limits resets.';
    const notifyFailover = async (info: FailoverInfo): Promise<void> => {
      try {
        await this.onFailover?.(info);
      } catch (err) {
        log(`onFailover observer threw: ${errorText(err)}`);
      }
    };
    // Why the primary was abandoned this turn. A primary auth failure followed
    // by an alternate quota failure is not "both limits reached"; surface the
    // primary's credential error so the poll-loop's auth handling applies.
    let primaryFailure = this.fallbackCause;
    // Replaying the initial prompt after an earlier result/output can duplicate
    // completed work. Auth failover is only safe before observable work.
    let primaryProducedWork = false;
    const resetPreference = (): void => {
      this.preferFallback = false;
      this.fallbackCause = null;
    };
    const followups: Array<{ message: string; imageBlocks?: ImageContentBlock[] }> = [];
    // Results the primary already returned. Codex and Pi answer one input per
    // result, so those inputs are done and must not be replayed on the
    // alternate. (Claude may merge inputs into one result; counting results
    // then under-counts, which only replays an input it already answered,
    // never skips one.)
    let primaryResults = 0;
    let ended = false;
    let aborted = false;

    // Tool sends (e.g. MCP send_message) never surface as provider events, so
    // the outbox is the only complete record of what the user already has.
    const primaryHasDelivered = (): boolean => primaryProducedWork || primaryWork().delivered.length > 0;

    const switchToFallback = async (reason: FailoverReason, detail: string): Promise<boolean> => {
      if (activeProvider === this.fallback) return false;
      const unanswered = [{ message: input.prompt, imageBlocks: input.imageBlocks }, ...followups].slice(
        primaryResults,
      );
      if (unanswered.length === 0) return false;
      const work = primaryWork();
      const handoff = buildFailoverHandoff({
        from: this.primaryName,
        reason,
        work,
        producedOutput: primaryProducedWork,
      });
      if (handoff) {
        log(
          `handing ${this.fallbackName} the partial turn: ${work.delivered.length} delivered message(s), ` +
            `${[...work.actions.values()].reduce((a, b) => a + b, 0)} host action(s)`,
        );
      }
      log(
        reason === 'auth'
          ? `${this.primaryName} authentication failed — retrying transparently with ${this.fallbackName}`
          : `${this.primaryName} usage limit reached — retrying transparently with ${this.fallbackName}`,
      );
      primaryFailure = this.fallbackCause = { reason, detail };
      await notifyFailover({ reason, from: this.primaryName, to: this.fallbackName, detail });
      activeQuery.abort();
      this.preferFallback = true;
      activeProvider = this.fallback;
      activeQuery = this.fallback.query(fallbackInput(handoff, unanswered[0]));
      for (const followup of unanswered.slice(1)) {
        activeQuery.push(followup.message, followup.imageBlocks);
      }
      if (aborted) activeQuery.abort();
      else if (ended) activeQuery.end();
      return true;
    };

    async function* events(): AsyncGenerator<ProviderEvent> {
      while (true) {
        const iterator = activeQuery.events[Symbol.asyncIterator]();
        let switched = false;
        while (true) {
          let next: IteratorResult<ProviderEvent>;
          try {
            next = await iterator.next();
          } catch (err) {
            // Some SDK versions throw the credential failure instead of (or
            // after) yielding it as an error result. Treat that the same way.
            if (
              !aborted &&
              activeProvider !== fallbackProvider &&
              isProviderAuthFailureText(errorText(err)) &&
              !primaryHasDelivered() &&
              (await switchToFallback('auth', errorText(err)))
            ) {
              switched = true;
              break;
            }
            throw err;
          }
          if (next.done) break;
          const event = next.value;
          const reason = activeProvider !== fallbackProvider ? failoverReason(event) : null;
          if (
            !aborted &&
            reason &&
            (reason !== 'auth' || !primaryHasDelivered()) &&
            // Do not await iterator.return(): a provider stream can be parked
            // in its SDK even after abort. The alternate attempt must start
            // immediately rather than inheriting that hang.
            (await switchToFallback(
              reason,
              event.type === 'result' ? (event.error ?? event.text ?? '') : event.type === 'error' ? event.message : '',
            ))
          ) {
            switched = true;
            break;
          }
          // Never leak the alternate provider's continuation into the
          // standing provider's continuation slot.
          if (activeProvider === fallbackProvider && event.type === 'init') continue;
          if (activeProvider === fallbackProvider && isUsageLimitEvent(event)) {
            // The first limit was invisible; the alternate is now limited too.
            // Convert the second quota event into a terminal result so chat
            // turns receive one clear notice instead of remaining pending
            // forever with no response. The poll-loop suppresses error results
            // for task-only turns, preserving silent maintenance semantics.
            resetPreference();
            activeQuery.abort();
            const failure = primaryFailure as { reason: FailoverReason; detail: string } | null;
            yield {
              type: 'result',
              text: failure?.reason === 'auth' ? failure.detail : dualLimitText,
              error: failure?.reason === 'auth' ? undefined : dualLimitText,
              isError: true,
            };
            return;
          }
          if (
            activeProvider !== fallbackProvider &&
            (event.type === 'result' ||
              event.type === 'text' ||
              event.type === 'file' ||
              event.type === 'generated_image')
          ) {
            primaryProducedWork = true;
          }
          const primaryResult = activeProvider !== fallbackProvider && event.type === 'result';
          if (primaryResult) primaryResults++;
          yield event;
          if (primaryResult) {
            // The consumer resumes this generator only after it dispatched
            // that result, so the answer is already in the outbox. A later
            // failover hands over only the work for inputs still open.
            primaryProducedWork = false;
            try {
              ledgerCursor = ledger?.cursor() ?? ledgerCursor;
            } catch (err) {
              log(`turn ledger cursor unavailable: ${errorText(err)}`);
            }
          }
        }
        if (!switched) return;
      }
    }

    return {
      // A static capability on the wrapper loses one side of Claude↔Codex:
      // Claude must stream pre-tool replies, while Codex's text events must
      // remain inert until its final result. Forward the active query's
      // contract (including nested wrappers) without leaking its continuation.
      get delivery() {
        const name = activeProvider === fallbackProvider ? fallbackName : primaryName;
        const contract = getProviderRuntimeContract(name);
        return (
          activeQuery.delivery ?? {
            providerName: name,
            emitsMidTurnText: contract
              ? contract.textDelivery === 'mid-turn-complete'
              : (activeProvider as AgentProvider & { emitsMidTurnText?: boolean }).emitsMidTurnText === true,
          }
        );
      },
      get mergesPushedInputs() {
        return activeQuery.mergesPushedInputs;
      },
      get pushWaitsFor() {
        const q = activeQuery;
        return q.pushWaitsFor ? (message: string) => q.pushWaitsFor!(message) : undefined;
      },
      push: (message, imageBlocks) => {
        followups.push({ message, imageBlocks });
        activeQuery.push(message, imageBlocks);
      },
      end: () => {
        ended = true;
        activeQuery.end();
      },
      abort: () => {
        aborted = true;
        activeQuery.abort();
      },
      events: events(),
    };
  }

  isSessionInvalid(err: unknown): boolean {
    return this.primary.isSessionInvalid(err) || this.fallback.isSessionInvalid(err);
  }

  maybeRotateContinuation(continuation: string, cwd: string): string | null {
    return this.primary.maybeRotateContinuation?.(continuation, cwd) ?? null;
  }

  pressureRotationTokens(): number | null {
    const provider = this.preferFallback ? this.fallback : this.primary;
    return provider.pressureRotationTokens?.() ?? null;
  }

  onExchangeComplete(exchange: Parameters<NonNullable<AgentProvider['onExchangeComplete']>>[0]): void {
    const provider = this.preferFallback ? this.fallback : this.primary;
    provider.onExchangeComplete?.(exchange);
  }
}
