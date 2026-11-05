/**
 * Regression coverage for #2560 — group @-mentions of the bot must set
 * `InboundMessage.isMention` — plus the shared-number mode split: when
 * ASSISTANT_HAS_OWN_NUMBER is not explicitly 'true' the adapter runs on the
 * operator's personal number, so NOTHING is a bot mention (DMs address the
 * human; group tags of the owner tag the human) and the bot-LID → assistant
 * name content rewrite is skipped.
 *
 * The detection logic lives in the exported pure helper `isBotMentionedInGroup`;
 * the inbound site feeds it into `computeIsMention(shared, isGroup, mentioned)`.
 * Both helpers and the mode-resolution truth table are covered below so a
 * future refactor that breaks any part fails this suite.
 */
import { describe, it, expect } from 'vitest';

import {
  appendMediaFailureNote,
  computeIsMention,
  computeWhatsappDefaults,
  formatAnswerConfirmation,
  hasMentionPills,
  isBotMentionedInGroup,
  isBotTypedMention,
  matchPendingQuestion,
  parseWhatsAppMentions,
  type PendingQuestion,
  questionDetail,
  resolveSharedMode,
  rewriteBotLidMention,
} from './whatsapp.js';

const BOT_PHONE_JID = '15550009999@s.whatsapp.net';
const BOT_LID_USER = '987654321';

describe('isBotMentionedInGroup (#2560)', () => {
  it('detects the bot phone JID in extendedTextMessage.contextInfo.mentionedJid', () => {
    const normalized = {
      extendedTextMessage: {
        text: 'hey @15550009999 take a look',
        contextInfo: { mentionedJid: [BOT_PHONE_JID] },
      },
    };
    expect(isBotMentionedInGroup(normalized, BOT_PHONE_JID, BOT_LID_USER)).toBe(true);
  });

  it('returns false when the bot is not in mentionedJid', () => {
    const normalized = {
      extendedTextMessage: {
        text: 'hey @15551112222 take a look',
        contextInfo: { mentionedJid: ['15551112222@s.whatsapp.net'] },
      },
    };
    expect(isBotMentionedInGroup(normalized, BOT_PHONE_JID, BOT_LID_USER)).toBe(false);
  });

  it('detects an LID-only mention when no phone JID is in the list', () => {
    // Modern WhatsApp clients increasingly emit the LID even when the
    // human typed a phone-number mention; the phone JID may not appear.
    const normalized = {
      extendedTextMessage: {
        contextInfo: { mentionedJid: [`${BOT_LID_USER}@lid`] },
      },
    };
    expect(isBotMentionedInGroup(normalized, BOT_PHONE_JID, BOT_LID_USER)).toBe(true);
  });

  it('detects a mention in an image caption', () => {
    const normalized = {
      imageMessage: {
        caption: 'check this @15550009999',
        contextInfo: { mentionedJid: [BOT_PHONE_JID] },
      },
    };
    expect(isBotMentionedInGroup(normalized, BOT_PHONE_JID, BOT_LID_USER)).toBe(true);
  });

  it('returns false on an empty / missing mentionedJid array', () => {
    expect(isBotMentionedInGroup({}, BOT_PHONE_JID, BOT_LID_USER)).toBe(false);
    expect(
      isBotMentionedInGroup(
        { extendedTextMessage: { contextInfo: { mentionedJid: [] } } },
        BOT_PHONE_JID,
        BOT_LID_USER,
      ),
    ).toBe(false);
  });

  it('returns false when neither bot identifier is known', () => {
    const normalized = {
      extendedTextMessage: {
        contextInfo: { mentionedJid: [BOT_PHONE_JID, `${BOT_LID_USER}@lid`] },
      },
    };
    expect(isBotMentionedInGroup(normalized, undefined, undefined)).toBe(false);
  });
});

describe('typed @-mention fallback (#3085)', () => {
  describe('isBotTypedMention', () => {
    it('matches a typed @-mention of the assistant name, case-insensitively', () => {
      expect(isBotTypedMention('@sprout are you there?', 'Sprout', BOT_PHONE_JID)).toBe(true);
      expect(isBotTypedMention('hey @SPROUT look at this', 'Sprout', BOT_PHONE_JID)).toBe(true);
    });

    it('matches a typed @-mention of the bot phone number', () => {
      expect(isBotTypedMention('@15550009999 ping', 'Sprout', BOT_PHONE_JID)).toBe(true);
    });

    it('requires a word boundary after the name', () => {
      expect(isBotTypedMention('@Sprouted a new plan', 'Sprout', BOT_PHONE_JID)).toBe(false);
    });

    it('requires the @ prefix', () => {
      expect(isBotTypedMention('Sprout are you there?', 'Sprout', BOT_PHONE_JID)).toBe(false);
    });

    it('does not match other @-names', () => {
      expect(isBotTypedMention('@Maria can you check?', 'Sprout', BOT_PHONE_JID)).toBe(false);
    });

    it('escapes regex specials in the assistant name', () => {
      expect(isBotTypedMention('@R2.D2 status?', 'R2.D2', BOT_PHONE_JID)).toBe(true);
      expect(isBotTypedMention('@R2xD2 status?', 'R2.D2', BOT_PHONE_JID)).toBe(false);
    });

    it('matches names ending in non-ASCII letters (ASCII \\b never would)', () => {
      expect(isBotTypedMention('@José hola', 'José', BOT_PHONE_JID)).toBe(true);
      expect(isBotTypedMention('@小助手 status', '小助手', BOT_PHONE_JID)).toBe(true);
    });

    it('does not fire on emails or URL paths containing the name', () => {
      expect(isBotTypedMention('write to ethan@sprout.com please', 'Sprout', BOT_PHONE_JID)).toBe(false);
      expect(isBotTypedMention('https://x.com/@sprout/status/1', 'Sprout', BOT_PHONE_JID)).toBe(false);
    });

    it('still matches after punctuation openers', () => {
      expect(isBotTypedMention('(@Sprout can you look?)', 'Sprout', BOT_PHONE_JID)).toBe(true);
      expect(isBotTypedMention('¿@Sprout puedes?', 'Sprout', BOT_PHONE_JID)).toBe(true);
    });

    it('does not match a multi-word name by its first word alone', () => {
      expect(isBotTypedMention('@Autónomos can you check', 'Autónomos Expert', BOT_PHONE_JID)).toBe(false);
      expect(isBotTypedMention('@Autónomos Expert can you check', 'Autónomos Expert', BOT_PHONE_JID)).toBe(true);
    });

    it('matches on the name alone when the bot phone JID is unknown', () => {
      expect(isBotTypedMention('@Sprout hi', 'Sprout', undefined)).toBe(true);
    });
  });

  describe('hasMentionPills', () => {
    it('is false for a message with no contextInfo or an empty mentionedJid', () => {
      expect(hasMentionPills({})).toBe(false);
      expect(hasMentionPills({ extendedTextMessage: { contextInfo: { mentionedJid: [] } } })).toBe(false);
    });

    it('is true when anyone at all is pilled, not just the bot', () => {
      expect(
        hasMentionPills({
          extendedTextMessage: { contextInfo: { mentionedJid: ['15551112222@s.whatsapp.net'] } },
        }),
      ).toBe(true);
    });
  });
});

describe('InboundMessage.isMention semantics (#2560 + shared mode)', () => {
  describe('dedicated mode (bot has its own number)', () => {
    it('is undefined for a group message with no bot mention', () => {
      expect(computeIsMention(false, true, false)).toBeUndefined();
    });

    it('is true for a group message where the bot is mentioned', () => {
      expect(computeIsMention(false, true, true)).toBe(true);
    });

    it('is true for a DM regardless of mention state', () => {
      // DMs are unconditionally mentions — the helper isn't consulted there.
      expect(computeIsMention(false, false, false)).toBe(true);
      expect(computeIsMention(false, false, true)).toBe(true);
    });
  });

  describe('shared mode (operator personal number)', () => {
    it('is undefined for EVERYTHING — DMs address the human, tags tag the human', () => {
      expect(computeIsMention(true, false, false)).toBeUndefined();
      expect(computeIsMention(true, false, true)).toBeUndefined();
      expect(computeIsMention(true, true, false)).toBeUndefined();
      expect(computeIsMention(true, true, true)).toBeUndefined();
    });
  });
});

describe('resolveSharedMode env truth table', () => {
  it('explicit "true" → dedicated (not shared)', () => {
    expect(resolveSharedMode('true')).toBe(false);
  });

  it('absent or any other value → shared', () => {
    expect(resolveSharedMode(undefined)).toBe(true);
    expect(resolveSharedMode('')).toBe(true);
    expect(resolveSharedMode('false')).toBe(true);
    expect(resolveSharedMode('TRUE')).toBe(true);
    expect(resolveSharedMode('1')).toBe(true);
    expect(resolveSharedMode('yes')).toBe(true);
  });
});

describe('rewriteBotLidMention', () => {
  const ASSISTANT = 'Andy';

  it('dedicated mode rewrites a bot-LID tag into @<assistant name>', () => {
    expect(rewriteBotLidMention(`hey @${BOT_LID_USER} status?`, false, BOT_LID_USER, ASSISTANT)).toBe(
      'hey @Andy status?',
    );
  });

  it('shared mode skips the rewrite — a tag of the owner must not become name-pattern bait', () => {
    const content = `hey @${BOT_LID_USER} status?`;
    expect(rewriteBotLidMention(content, true, BOT_LID_USER, ASSISTANT)).toBe(content);
  });

  it('passes content through when the bot LID is unknown', () => {
    expect(rewriteBotLidMention(`hey @${BOT_LID_USER}`, false, undefined, ASSISTANT)).toBe(`hey @${BOT_LID_USER}`);
  });

  it('passes content through when there is no tag of the bot LID', () => {
    expect(rewriteBotLidMention('no tags here', false, BOT_LID_USER, ASSISTANT)).toBe('no tags here');
  });
});

describe('computeWhatsappDefaults', () => {
  it('shared mode declares strict name-pattern defaults with no platform mentions', () => {
    expect(computeWhatsappDefaults(true)).toEqual({
      dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
      group: {
        engageMode: 'pattern',
        engagePattern: '\\b{name}\\b',
        threads: false,
        unknownSenderPolicy: 'strict',
      },
      mentions: 'never',
    });
  });

  it('dedicated mode declares platform mentions with group engage on mention (never sticky)', () => {
    expect(computeWhatsappDefaults(false)).toEqual({
      dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
      group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
      mentions: 'platform',
    });
  });
});

describe('parseWhatsAppMentions', () => {
  it('returns empty mentions for plain text', () => {
    const { text, mentions } = parseWhatsAppMentions('hello there');
    expect(text).toBe('hello there');
    expect(mentions).toEqual([]);
  });

  it('extracts a single @<digits> mention into a JID', () => {
    const { text, mentions } = parseWhatsAppMentions('hey @15551234567 you around?');
    expect(text).toBe('hey @15551234567 you around?');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });

  it('strips a leading + so the literal text matches the JID digits', () => {
    const { text, mentions } = parseWhatsAppMentions('ping @+15551234567 please');
    expect(text).toBe('ping @15551234567 please');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });

  it('matches a mention at the start of the string', () => {
    const { text, mentions } = parseWhatsAppMentions('@15551234567 hi');
    expect(text).toBe('@15551234567 hi');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });

  it('extracts multiple distinct mentions', () => {
    const { text, mentions } = parseWhatsAppMentions('cc @15551234567 and @17775556666');
    expect(text).toBe('cc @15551234567 and @17775556666');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net', '17775556666@s.whatsapp.net']);
  });

  it('deduplicates repeated mentions of the same number', () => {
    const { mentions } = parseWhatsAppMentions('@15551234567 ping @15551234567 again');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });

  it('does not tag email-like patterns', () => {
    const { text, mentions } = parseWhatsAppMentions('write to test@1234567890.com');
    expect(text).toBe('write to test@1234567890.com');
    expect(mentions).toEqual([]);
  });

  it('does not tag sequences shorter than 5 digits', () => {
    const { text, mentions } = parseWhatsAppMentions('see issue @123 for details');
    expect(text).toBe('see issue @123 for details');
    expect(mentions).toEqual([]);
  });

  it('handles punctuation directly after the digits', () => {
    const { text, mentions } = parseWhatsAppMentions('thanks @15551234567!');
    expect(text).toBe('thanks @15551234567!');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });

  it('handles parenthesized mentions', () => {
    const { text, mentions } = parseWhatsAppMentions('(@15551234567) wrote this');
    expect(text).toBe('(@15551234567) wrote this');
    expect(mentions).toEqual(['15551234567@s.whatsapp.net']);
  });
});

describe('appendMediaFailureNote', () => {
  it('returns content unchanged when nothing failed', () => {
    expect(appendMediaFailureNote('hello', [])).toBe('hello');
  });

  it('appends the note on its own line when a captioned message has a failed download', () => {
    expect(appendMediaFailureNote('check this out', ['image'])).toBe('check this out\n[image could not be downloaded]');
  });

  it('uses the note as the content when an uncaptioned media message fails (would otherwise be dropped)', () => {
    // Regression guard: an uncaptioned image whose download fails must still
    // produce a non-empty message, or the empty-message guard skips it and the
    // agent never learns media was sent.
    expect(appendMediaFailureNote('', ['image'])).toBe('[image could not be downloaded]');
  });

  it('lists each failed media type when several fail together', () => {
    expect(appendMediaFailureNote('', ['image', 'document'])).toBe(
      '[image could not be downloaded] [document could not be downloaded]',
    );
  });
});

// Mirrors APPROVAL_OPTIONS in src/modules/approvals/primitive.ts — every
// module approval card offers these three, with the same values on every card.
const APPROVAL_OPTIONS = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: 'reject_with_reason' },
];
const installCard = (questionId: string, pkg: string): PendingQuestion => ({
  questionId,
  title: 'Install Packages Request',
  detail: questionDetail(`Agent "main" is attempting to install a package + rebuild container:\napt: ${pkg}`),
  options: APPROVAL_OPTIONS,
});
// An agent ask_user_question card: plain string options, value = label.
const askCard = (questionId: string, labels: string[]): PendingQuestion => ({
  questionId,
  title: 'Deploy target',
  detail: questionDetail('Where should I deploy this build?'),
  options: labels.map((label) => ({ label, selectedLabel: label, value: label })),
});

describe('matchPendingQuestion', () => {
  it('keeps an earlier question answerable after a second one arrives', () => {
    // The real failure: pendingQuestions was keyed by chat and held one entry,
    // so a second card silently overwrote the first and no reply could ever
    // reach it — the card stayed on screen and its row stayed pending forever.
    const pendings = [askCard('q1', ['Staging', 'Production']), installCard('q2', 'ffmpeg')];
    expect(matchPendingQuestion(pendings, '/staging')?.pending.questionId).toBe('q1');
  });

  it('resolves the newest card when two cards share an option label', () => {
    // Unavoidable ambiguity: WhatsApp replies are plain text, so nothing ties
    // "/approve" to the card it came from. Newest wins — that is the card the
    // user was just shown.
    const pendings = [installCard('q1', 'ffmpeg'), installCard('q2', 'imagemagick')];
    const hit = matchPendingQuestion(pendings, '/approve');
    expect(hit?.pending.questionId).toBe('q2');
    expect(hit?.option.value).toBe('approve');
  });

  it('reports the index so only the answered card is dropped and a second bare reply lands on the next', () => {
    const pendings = [installCard('q1', 'ffmpeg'), installCard('q2', 'imagemagick')];
    const hit = matchPendingQuestion(pendings, '/approve')!;
    expect(hit.index).toBe(1);
    pendings.splice(hit.index, 1);
    // The other card survives and is still answerable — by the same command.
    expect(matchPendingQuestion(pendings, '/approve')?.pending.questionId).toBe('q1');
  });

  it('returns undefined when no pending question offers the command', () => {
    expect(matchPendingQuestion([installCard('q1', 'ffmpeg')], '/nope')).toBeUndefined();
  });

  it('returns undefined when nothing is pending', () => {
    expect(matchPendingQuestion([], '/approve')).toBeUndefined();
  });

  it('matches regardless of case and surrounding whitespace', () => {
    expect(matchPendingQuestion([installCard('q1', 'ffmpeg')], '  /APPROVE  ')?.option.value).toBe('approve');
  });

  it('matches a multi-word label through its slash command form', () => {
    expect(matchPendingQuestion([installCard('q1', 'ffmpeg')], '/reject-with-reason…')?.option.value).toBe(
      'reject_with_reason',
    );
  });
});

describe('questionDetail', () => {
  it('keeps the line after the first, so two install requests read differently', () => {
    expect(questionDetail('Agent "main" is attempting to install a package + rebuild container:\napt: ffmpeg')).toBe(
      'Agent "main" is attempting to install a package + rebuild container: apt: ffmpeg',
    );
  });

  it('clips a long question to one short line', () => {
    const detail = questionDetail('x'.repeat(500));
    expect(detail.length).toBe(120);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('is empty for a missing or blank question', () => {
    expect(questionDetail(undefined)).toBe('');
    expect(questionDetail('  \n ')).toBe('');
  });
});

describe('formatAnswerConfirmation', () => {
  const approve = APPROVAL_OPTIONS[0];

  it('names the card that was answered', () => {
    expect(formatAnswerConfirmation(installCard('q1', 'ffmpeg'), approve, 'Jason', [])).toBe(
      '✅ Approved by Jason: Install Packages Request (Agent "main" is attempting to install a package + rebuild container: apt: ffmpeg)',
    );
  });

  it('lists the cards still open, newest first — the order a bare reply resolves them', () => {
    const stillOpen = [installCard('q1', 'ffmpeg'), askCard('q2', ['Staging', 'Production'])];
    const lines = formatAnswerConfirmation(installCard('q3', 'imagemagick'), approve, 'Jason', stillOpen).split('\n');
    expect(lines.slice(1)).toEqual([
      '2 more waiting in this chat:',
      '• Deploy target (Where should I deploy this build?)',
      '• Install Packages Request (Agent "main" is attempting to install a package + rebuild container: apt: ffmpeg)',
    ]);
  });

  it('summarises beyond the first few open cards', () => {
    const stillOpen = ['a', 'b', 'c', 'd', 'e'].map((pkg, i) => installCard(`q${i}`, pkg));
    const lines = formatAnswerConfirmation(installCard('q9', 'z'), approve, 'Jason', stillOpen).split('\n');
    expect(lines[1]).toBe('5 more waiting in this chat:');
    expect(lines).toHaveLength(6);
    expect(lines[2]).toContain('apt: e');
    expect(lines[5]).toBe('• …and 2 more');
  });

  it('falls back to the title when the card has no question body', () => {
    const card = { ...askCard('q1', ['Yes']), detail: '' };
    expect(formatAnswerConfirmation(card, card.options[0], 'Jason', [])).toBe('Yes by Jason: Deploy target');
  });
});
