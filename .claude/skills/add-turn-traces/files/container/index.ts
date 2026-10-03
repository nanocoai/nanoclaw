/**
 * Turn traces — registers the recorder with the poll loop's turn hooks.
 * Imported for its side effect from the capability barrel (modules/index.ts).
 */
import { registerTurnHook } from '../../turn-hooks.js';
import { beginTurn, failOpenTurns, recordProviderEvent } from './recorder.js';

registerTurnHook({
  name: 'turn-traces',
  beforeTurn: (ctx) => beginTurn(ctx.messages, ctx.routing, ctx.followUp),
  onProviderEvent: (event, routing) => recordProviderEvent(event, routing),
  onError: (err) => failOpenTurns(err),
});
