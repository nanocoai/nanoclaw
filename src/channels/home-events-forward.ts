/**
 * Forward Slack home-surface events to the governance service, which owns
 * rendering + publishing of the App Home (the host keeps the single Socket
 * Mode connection; Web API publishes are safe from either process).
 *
 * Enabled by HOME_EVENTS_URL; while unset every forward is a no-op and no
 * App Home is published anywhere — the host has no in-process publisher.
 * Fire-and-forget + fail-soft: the home is presentation, never a gate.
 */
import type { Chat } from 'chat';

import { HOME_EVENTS_SECRET, HOME_EVENTS_URL } from '../config.js';
import { log } from '../log.js';

const FORWARD_TIMEOUT_MS = 5_000;

export interface HomeSurfaceEvent {
  type: 'home_opened' | 'action';
  slackUserId: string;
  actionId?: string;
  /** First plain_text_input value from the view state, when the clicked view
   *  had one (the Memory tab's in-view editor). */
  value?: string;
  /** All input/select values from the view state, keyed by action_id (the
   *  Quick-provision tab reads its two selects from here on the Go click). */
  state?: Record<string, string>;
}

const MAX_FORWARD_VALUE_BYTES = 60 * 1024;

type SlackStateValues = Record<string, Record<string, unknown>>;

/** Slack sends block action input state at top-level `state.values`. Keep the
 * nested view state as a fallback for adapters/SDK payloads that only expose
 * it there. When top-level state is present it is authoritative, even empty. */
function extractStateValues(raw: unknown): SlackStateValues | undefined {
  const payload = raw as
    | {
        state?: { values?: SlackStateValues };
        view?: { state?: { values?: SlackStateValues } };
      }
    | undefined;
  const topLevel = payload?.state?.values;
  if (topLevel && typeof topLevel === 'object') return topLevel;
  const nested = payload?.view?.state?.values;
  return nested && typeof nested === 'object' ? nested : undefined;
}

/** Dig the first plain_text_input value out of a raw Slack block_actions
 *  payload (`state.values[blockId][actionId].value`, with nested view-state
 *  fallback). Home-tab buttons submit no form, so the sibling input's value
 *  only travels via action state. */
export function extractInputValue(raw: unknown): string | undefined {
  const values = extractStateValues(raw);
  if (!values) return undefined;
  for (const block of Object.values(values)) {
    if (!block || typeof block !== 'object') continue;
    for (const el of Object.values(block)) {
      const input = el as { type?: string; value?: unknown };
      if (input?.type === 'plain_text_input' && typeof input.value === 'string') {
        if (Buffer.byteLength(input.value, 'utf8') > MAX_FORWARD_VALUE_BYTES) {
          log.warn('home-forward: input value too large — dropped', { bytes: Buffer.byteLength(input.value, 'utf8') });
          return undefined;
        }
        return input.value;
      }
    }
  }
  return undefined;
}

/** Every input/select value in the view state, keyed by action_id — bounded;
 *  an oversized map is dropped loudly rather than truncated silently. */
export function extractViewState(raw: unknown): Record<string, string> | undefined {
  const values = extractStateValues(raw);
  if (!values) return undefined;
  const out: Record<string, string> = {};
  let total = 0;
  for (const block of Object.values(values)) {
    if (!block || typeof block !== 'object') continue;
    for (const [actionId, el] of Object.entries(block)) {
      const input = el as { type?: string; value?: unknown; selected_option?: { value?: unknown } };
      let v: string | undefined;
      if (input?.type === 'plain_text_input' && typeof input.value === 'string') v = input.value;
      else if (
        (input?.type === 'static_select' || input?.type === 'radio_buttons') &&
        typeof input.selected_option?.value === 'string'
      ) {
        v = input.selected_option.value;
      }
      if (v === undefined) continue;
      total += Buffer.byteLength(actionId, 'utf8') + Buffer.byteLength(v, 'utf8');
      if (total > MAX_FORWARD_VALUE_BYTES) {
        log.warn('home-forward: view state too large — dropped', { bytes: total });
        return undefined;
      }
      out[actionId] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function homeForwardingEnabled(): boolean {
  return Boolean(HOME_EVENTS_URL);
}

export function forwardHomeEvent(evt: HomeSurfaceEvent): void {
  if (!HOME_EVENTS_URL) return;
  void fetch(HOME_EVENTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-home-events-secret': HOME_EVENTS_SECRET },
    body: JSON.stringify({ v: 1, ...evt }),
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  })
    .then((res) => {
      if (!res.ok) log.warn('home-forward: service rejected event', { status: res.status, type: evt.type });
    })
    .catch((err) => {
      log.warn('home-forward: could not reach governance service', {
        type: evt.type,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Register the home-surface forwarders on a Chat instance: `app_home_opened`
 * events, plus home-surface block_actions — `home:*` (tab-bar buttons) and
 * `connect-*` (URL buttons: the link opens in the browser, but the click
 * still emits an action). The Chat SDK runs every registered onAction
 * handler whose filter matches, and the bridge's own handlers ignore these
 * action ids, so a separate handler adds forwarding without touching the
 * existing dispatch. Everything funnels into {@link forwardHomeEvent}, which
 * no-ops while HOME_EVENTS_URL is unset.
 */
export function registerHomeSurfaceForwarding(chat: Pick<Chat, 'onAppHomeOpened' | 'onAction'>): void {
  chat.onAppHomeOpened((event) => {
    forwardHomeEvent({ type: 'home_opened', slackUserId: event.userId });
  });
  chat.onAction((event) => {
    if (!event.actionId.startsWith('connect-') && !event.actionId.startsWith('home:')) return;
    const userId = event.user?.userId;
    if (!userId) return;
    forwardHomeEvent({
      type: 'action',
      slackUserId: userId,
      actionId: event.actionId,
      value: extractInputValue(event.raw),
      state: extractViewState(event.raw),
    });
  });
}
