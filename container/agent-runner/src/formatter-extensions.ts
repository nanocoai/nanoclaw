// Generic formatter extension seam. INERT by default: with
// no registrant, applyChatSenderResolver returns null and formatSingleChat uses
// its default sender derivation + no extra attributes, so the rendered <message>
// is byte-identical to upstream. An overlay may register a resolver that, for
// certain message content, overrides the sender label and injects extra
// <message> attributes (e.g. a non-authoritative external-participant marker).
// First non-null wins.
export interface ChatSenderRender {
  /** Replaces the derived sender label (escaped by the caller like any text). */
  sender: string;
  /** Extra attributes spliced into the `<message ...>` open tag — MUST include a
   *  leading space, e.g. ' actor_type="external_contact"'. Empty string = none. */
  attrs: string;
}

// `content` is the parsed message content (parseContent returns `any`), passed
// opaquely so the core seam stays decoupled from any downstream content fields.
export type ChatSenderResolver = (content: unknown) => ChatSenderRender | null;

const resolvers: ChatSenderResolver[] = [];

export function registerChatSenderResolver(fn: ChatSenderResolver): void {
  resolvers.push(fn);
}

/** First non-null resolver wins. No registrant ⇒ null (caller uses its default). */
export function applyChatSenderResolver(content: unknown): ChatSenderRender | null {
  for (const fn of resolvers) {
    const r = fn(content);
    if (r !== null) return r;
  }
  return null;
}

export function __resetChatSenderResolverForTest(): void {
  resolvers.length = 0;
}
