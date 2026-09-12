/**
 * A session tells its chat surface where a terminal reaches it.
 *
 * On a host with remote access enabled every sandbox has an address of its
 * own (remote/sandboxes.ts), and the service keeps that address on the
 * channel's member row so a `/terminal` typed in the channel is answered
 * from it without a host round trip. The address rides the create when the
 * channel is opened (binding.ts); a channel that already existed when
 * `remote enable` ran, or a re-bind, learns it through the member update
 * route. Everything here is best effort: the address is a convenience for
 * the channel, never a condition of the binding, so nothing throws and a
 * service that refuses is a log line.
 */
import { log } from '../../log.js';
import type { ChannelRecord, MemberFields, SessionChannelClient } from './client.js';
import type { SessionChannelRow } from './db.js';

/** Both member fields, as the address helper yields them together. */
export type TerminalAddressFields = Required<MemberFields>;

/** The owner's bot user on a channel record: the top-level field, else the owner member. */
export function ownerBotUserId(record: Pick<ChannelRecord, 'botUserId' | 'members'>): string | undefined {
  if (record.botUserId) return record.botUserId;
  return record.members?.find((member) => member.role === 'owner')?.botUserId ?? undefined;
}

export interface AnnounceTerminalAddressInput {
  client: Pick<SessionChannelClient, 'updateMember' | 'get'>;
  row: Pick<SessionChannelRow, 'agent_group_id' | 'channel_id'>;
  fields: TerminalAddressFields;
  /** This host's bot user id when known (bot-identity.ts); otherwise the channel record names it. */
  botUserId?: string | null;
}

/**
 * Report the sandbox's address on its existing channel. Resolves true when
 * the service recorded it; false — with a log line — when the member could
 * not be named or the service refused. Never throws.
 */
export async function announceTerminalAddress(input: AnnounceTerminalAddressInput): Promise<boolean> {
  const { client, row, fields } = input;
  const context = {
    agentGroupId: row.agent_group_id,
    channelId: row.channel_id,
    terminalAddress: fields.terminalAddress,
  };
  try {
    const botUserId = input.botUserId || ownerBotUserId(await client.get(row.channel_id));
    if (!botUserId) {
      log.warn('Session channel: terminal address not announced — the channel names no bot for this host', context);
      return false;
    }
    await client.updateMember(row.channel_id, botUserId, fields);
    log.info('Session channel learned its terminal address', context);
    return true;
  } catch (err) {
    log.warn('Session channel: terminal address not announced', { ...context, err });
    return false;
  }
}

export interface AnnounceSweepDeps {
  listBindings(): Promise<SessionChannelRow[]>;
  /** The sandbox's name (its group folder), or undefined when the group is gone. */
  sandboxNameOf(agentGroupId: string): Promise<string | undefined>;
  /** The address for a sandbox on this host, or undefined when it has none. */
  fieldsOf(sandbox: string): TerminalAddressFields | undefined;
  /** A client for the row's service, or null when this host holds no bearer for it. */
  clientFor(row: SessionChannelRow): Pick<SessionChannelClient, 'updateMember' | 'get'> | null;
  botUserId?: string | null;
}

export interface AnnounceSweepOutcome {
  /** Channels that now carry an address. */
  announced: number;
  /** Bindings without an address to report (no sandbox, or a name that takes no address). */
  skipped: number;
  /** Announcements the service or the network refused. */
  failed: number;
}

/**
 * Every open binding on this host reports its sandbox's address — what
 * `remote enable` runs once the door is up, so channels opened before it
 * catch up. Sequential: one host, a handful of channels, no hurry.
 */
export async function announceTerminalAddresses(deps: AnnounceSweepDeps): Promise<AnnounceSweepOutcome> {
  const outcome: AnnounceSweepOutcome = { announced: 0, skipped: 0, failed: 0 };
  for (const row of await deps.listBindings()) {
    const client = deps.clientFor(row);
    const sandbox = await deps.sandboxNameOf(row.agent_group_id);
    const fields = client && sandbox ? deps.fieldsOf(sandbox) : undefined;
    if (!client || !fields) {
      outcome.skipped += 1;
      continue;
    }
    const done = await announceTerminalAddress({ client, row, fields, botUserId: deps.botUserId });
    if (done) outcome.announced += 1;
    else outcome.failed += 1;
  }
  return outcome;
}
