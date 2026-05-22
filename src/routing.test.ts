import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getAllChats, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });

  it('Telegram JID: starts with tg:', () => {
    const jid = 'tg:123456789';
    expect(jid.startsWith('tg:')).toBe(true);
  });

  it('Telegram group JID: starts with tg: and has negative ID', () => {
    const jid = 'tg:-1001234567890';
    expect(jid.startsWith('tg:')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:01.000Z', 'Group 1', 'whatsapp', true);
    storeChatMetadata('user@s.whatsapp.net', '2024-01-01T00:00:02.000Z', 'User DM', 'whatsapp', false);
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:03.000Z', 'Group 2', 'whatsapp', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Group', 'whatsapp', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata('reg@g.us', '2024-01-01T00:00:01.000Z', 'Registered', 'whatsapp', true);
    storeChatMetadata('unreg@g.us', '2024-01-01T00:00:02.000Z', 'Unregistered', 'whatsapp', true);

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata('old@g.us', '2024-01-01T00:00:01.000Z', 'Old', 'whatsapp', true);
    storeChatMetadata('new@g.us', '2024-01-01T00:00:05.000Z', 'New', 'whatsapp', true);
    storeChatMetadata('mid@g.us', '2024-01-01T00:00:03.000Z', 'Mid', 'whatsapp', true);

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata('unknown-format-123', '2024-01-01T00:00:01.000Z', 'Unknown');
    // Explicitly non-group with unusual JID
    storeChatMetadata('custom:abc', '2024-01-01T00:00:02.000Z', 'Custom DM', 'custom', false);
    // A real group for contrast
    storeChatMetadata('group@g.us', '2024-01-01T00:00:03.000Z', 'Group', 'whatsapp', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });

  it('includes Telegram chat JIDs', () => {
    storeChatMetadata('tg:100200300', '2024-01-01T00:00:01.000Z', 'Telegram Chat', 'telegram', true);
    storeChatMetadata('user@s.whatsapp.net', '2024-01-01T00:00:02.000Z', 'User DM', 'whatsapp', false);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('tg:100200300');
  });

  it('returns Telegram group JIDs with negative IDs', () => {
    storeChatMetadata('tg:-1001234567890', '2024-01-01T00:00:01.000Z', 'TG Group', 'telegram', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('tg:-1001234567890');
    expect(groups[0].name).toBe('TG Group');
  });

  it('marks registered Telegram chats correctly', () => {
    storeChatMetadata('tg:100200300', '2024-01-01T00:00:01.000Z', 'TG Registered', 'telegram', true);
    storeChatMetadata('tg:999999', '2024-01-01T00:00:02.000Z', 'TG Unregistered', 'telegram', true);

    _setRegisteredGroups({
      'tg:100200300': {
        name: 'TG Registered',
        folder: 'tg-registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const tgReg = groups.find((g) => g.jid === 'tg:100200300');
    const tgUnreg = groups.find((g) => g.jid === 'tg:999999');

    expect(tgReg?.isRegistered).toBe(true);
    expect(tgUnreg?.isRegistered).toBe(false);
  });

  it('mixes WhatsApp and Telegram chats ordered by activity', () => {
    storeChatMetadata('wa@g.us', '2024-01-01T00:00:01.000Z', 'WhatsApp', 'whatsapp', true);
    storeChatMetadata('tg:100', '2024-01-01T00:00:03.000Z', 'Telegram', 'telegram', true);
    storeChatMetadata('wa2@g.us', '2024-01-01T00:00:02.000Z', 'WhatsApp 2', 'whatsapp', true);

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(3);
    expect(groups[0].jid).toBe('tg:100');
    expect(groups[1].jid).toBe('wa2@g.us');
    expect(groups[2].jid).toBe('wa@g.us');
  });
});
