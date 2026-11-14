/**
 * Inbound WhatsApp content: what the router gets to decide on, before any
 * attachment bytes are fetched — the typed text (extractMessageText) and the
 * attachment metadata (detectInboundMedia).
 *
 * extractMessageText — the user-typed-text extraction for inbound WhatsApp
 * messages.
 *
 * Regression guard: a PDF captioned "@Bot ..." in a wired group produced empty text, so the wiring's
 * `@[Bb]ot` pattern never matched and the router dropped the whole
 * message (attachment included) as no_agent_engaged, while the same text
 * typed on its own routed fine. `documentMessage.caption` was missing from
 * the extraction chain.
 */
import { describe, it, expect } from 'vitest';

import { detectInboundMedia, extractMessageText } from './whatsapp.js';

describe('extractMessageText', () => {
  it('reads a plain conversation message', () => {
    expect(extractMessageText({ conversation: '@Bot hello' })).toBe('@Bot hello');
  });

  it('reads extendedTextMessage text', () => {
    expect(extractMessageText({ extendedTextMessage: { text: '@Bot hello' } })).toBe('@Bot hello');
  });

  it('reads an image caption', () => {
    expect(extractMessageText({ imageMessage: { caption: '@Bot look' } })).toBe('@Bot look');
  });

  it('reads a video caption', () => {
    expect(extractMessageText({ videoMessage: { caption: '@Bot watch' } })).toBe('@Bot watch');
  });

  it('reads a document caption (the dropped-PDF regression)', () => {
    expect(extractMessageText({ documentMessage: { caption: '@Bot read this' } })).toBe('@Bot read this');
  });

  it('returns empty string for an uncaptioned document', () => {
    expect(extractMessageText({ documentMessage: { caption: null } })).toBe('');
  });

  it('returns empty string when nothing carries text', () => {
    expect(extractMessageText({})).toBe('');
  });
});

/**
 * detectInboundMedia — names a message's attachments from the envelope
 * alone, so the router can make its engage decision (and the adapter its
 * empty-message decision) before any CDN download happens.
 */
describe('detectInboundMedia', () => {
  it('finds nothing in a plain text message', () => {
    expect(detectInboundMedia({ conversation: 'hello' })).toEqual([]);
  });

  it('keeps the sender-supplied document filename', () => {
    expect(detectInboundMedia({ documentMessage: { fileName: 'medicube_vv.pdf' } })).toEqual([
      { key: 'documentMessage', type: 'document', name: 'medicube_vv.pdf' },
    ]);
  });

  it('falls back to a generated name when none is supplied', () => {
    expect(detectInboundMedia({ imageMessage: {} }, 1787484000000)).toEqual([
      { key: 'imageMessage', type: 'image', name: 'image-1787484000000.jpg' },
    ]);
  });

  it('refuses a traversing filename — it would escape the attachments dir', () => {
    const [ref] = detectInboundMedia({ documentMessage: { fileName: '../../etc/passwd' } }, 1787484000000);
    expect(ref.name).toBe('document-1787484000000');
  });

  it('detects every media type a message carries', () => {
    const refs = detectInboundMedia({
      imageMessage: {},
      videoMessage: {},
      audioMessage: {},
      documentMessage: { fileName: 'a.pdf' },
    });
    expect(refs.map((r) => r.type)).toEqual(['image', 'video', 'audio', 'document']);
  });
});
