/**
 * extractMessageText — the user-typed-text extraction for inbound WhatsApp
 * messages.
 *
 * Regression guard: a PDF captioned "@Bot ..." in a wired group produced empty
 * text, so the wiring's `@[Bb]ot` pattern never matched and the router dropped
 * the whole message (attachment included) as no_agent_engaged, while the same
 * text typed on its own routed fine. `documentMessage.caption` was missing from
 * the extraction chain.
 */
import { describe, it, expect } from 'vitest';

import { extractMessageText } from './whatsapp.js';

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
