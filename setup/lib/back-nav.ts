/**
 * Channel-flow back-navigation sentinel.
 *
 * Each `runXxxChannel(displayName)` in `setup/channels/` may return either
 * `void` (sub-flow completed normally) or `BACK_TO_CHANNEL_SELECTION` to
 * signal "the user picked '← Back to channel selection' on my first
 * prompt; please re-run the channel chooser." `setup/auto.ts` catches
 * that signal and loops back to `askChannelChoice()`.
 *
 * Back is only offered on the *first* interactive prompt of each channel
 * sub-flow — once the user has answered something, they're committed
 * (subsequent steps may have side effects like opening browsers, hitting
 * APIs, or installing adapter packages, none of which are easily undone).
 */
import { brightSelect } from './bright-select.js';
import { ensureAnswer } from './runner.js';

export const BACK_TO_CHANNEL_SELECTION = Symbol('BACK_TO_CHANNEL_SELECTION');

export type ChannelFlowResult = void | typeof BACK_TO_CHANNEL_SELECTION;

/**
 * The shared first-prompt back gate. Rendered as the very first interactive
 * prompt of a channel sub-flow (before any side effect), it lets the operator
 * either commit to connecting `label` or bounce straight back to the channel
 * chooser. Returns the existing `BACK_TO_CHANNEL_SELECTION` sentinel on back —
 * which the `setup/auto.ts` channel loop already catches — and `'continue'`
 * otherwise. Esc / Ctrl-C unwinds through `ensureAnswer` (exit 0), the same as
 * every other setup prompt.
 */
export async function backGate(
  label: string,
): Promise<'continue' | typeof BACK_TO_CHANNEL_SELECTION> {
  const choice = ensureAnswer(
    await brightSelect<'continue' | 'back'>({
      message: `Connect ${label}?`,
      initialValue: 'continue',
      options: [
        { value: 'continue', label: `Yes, connect ${label}` },
        { value: 'back', label: '← Back to channel selection' },
      ],
    }),
  );
  return choice === 'back' ? BACK_TO_CHANNEL_SELECTION : 'continue';
}
