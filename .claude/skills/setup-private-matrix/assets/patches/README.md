# matrix-bot-sdk cross-signing patch

`matrix-bot-sdk@0.8.0.patch` is the cross-signing/UIA patch (Step 5b installs it).

**It's safe to apply on any setup** — idempotent and non-fatal. But it only turns the
Element shield **green** when the runtime gate is met:

- Requires `@matrix-org/matrix-sdk-crypto-nodejs` **≥ 0.5.0** (0.4.0 discards the
  cross-signing upload requests, so keys can't be published).
- `@matrix-org/matrix-sdk-crypto-nodejs ≥ 0.5.0` requires **Node ≥ 24** (NanoClaw often
  runs Node 22).

Without that gate (default Node 22 / binding 0.4.0): the bot logs a WARN and no-ops on
bootstrap — messages are still fully end-to-end encrypted; the device just shows the red
"unverified" shield. That's a supported, working state. Upgrading Node + the binding is a
separate human supply-chain decision (0.6.x also carries a crypto-lib CVE fix).
