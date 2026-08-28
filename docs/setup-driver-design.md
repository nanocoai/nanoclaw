# Structured setup driver: design

## Outcome

A desktop client or a future process proxy can drive NanoClaw setup and
uninstall without parsing terminal prose or copying NanoClaw policy. NanoClaw
still decides what happens and validates what actually happened. The client
renders structured events and returns structured answers.

The terminal stays the default. Machine mode is explicit and versioned:

```text
bash nanoclaw.sh --protocol nanoclaw.driver.v1
bash nanoclaw.sh --uninstall --protocol nanoclaw.driver.v1
```

The exact contract is in
[setup-driver-protocol.md](setup-driver-protocol.md).

## Ownership boundary

```text
desktop / proxy
  │  NDJSON events and commands
  ▼
SetupDriver adapter
  │  same prompts, policy, ordering, and checks
  ├──────── setup orchestration ─────── service + structured health
  └──────── uninstall planner ───────── identity checks + exact receipt
```

| NanoClaw owns | Client owns |
|---|---|
| Step order and conditional branches | Layout and controls |
| Prompt definitions and validation | Secure answer collection |
| Side effects and postcondition checks | Declarative external-action attempts |
| Health and service identity | Acquisition provenance |
| Artifact discovery and uninstall safety | Deleting the checkout only when permitted |

The client never predicts the next step, branches on a label, supplies an
executable, or decides that an action succeeded. Only one item awaits input at a
time, so NanoClaw remains the state machine.

## Setup flow

The shell recognizes the protocol before normal output or mutation. It can emit
structured preflight and bootstrap progress before Node exists, then hands the
same stream to the TypeScript driver. Unsupported provisioning or a provider
without a machine adapter returns a typed error with safe recovery instead of
a command for the client to execute.

The TypeScript adapter exposes progress, prompts, displays, declarative external
actions, errors, cancellation, and completion. External actions are limited to
opening an HTTPS URL, starting a named application, or presenting system
permission instructions. `attempted` is not trusted; NanoClaw rechecks the real
postcondition.

Completion means healthy, not merely finished. NanoClaw proves that the running
service belongs to this checkout, queries the same structured host-health model
used by `ncl health --json`, and reports groups, policies, and skills as loaded
or explicitly empty. Only that receipt plus exit code `0` is success.

## Secret boundary

Machine secrets arrive only through protocol stdin. They do not enter the
driver's arguments or environment. OneCLI receives a path to a no-follow,
private temporary file. Secret-bearing curl effects receive a private curl
configuration file, so the secret is absent from curl arguments and environment.
Temporary files are removed in `finally`. Child output stays captured and
redacted. Terminal setup keeps its existing credential path.

Interactive provider CLIs use inherited stdio only in terminal mode. In machine
mode a bounded private process seam pipes their bytes to the provider adapter;
the adapter emits semantic URL, code, prompt, progress, and external-action
events. Raw provider output never becomes protocol output.

Teams device login follows the same boundary. Machine mode emits the Microsoft
URL as an external action and the device code as sensitive display content,
then clears both displays when the login process ends.

Registry sign-in is not an interactive-provider child. Both renderers call one
RFC 8628 implementation directly. It presents the verification URL, pairing
code, progress, and cancellation through the selected driver.

Sensitive display content, such as a pairing code, is allowed only in the
marked display event. A client renders it without logging or persistence and
clears it when instructed or when the process ends.

## Uninstall flow

Uninstall remains plan-first:

```text
scan (read only) → emit plan → receive category choices → rescan ownership
→ execute approved actions → emit each result → emit receipt
```

Callers approve categories, not paths or process IDs. Exact files have
`lstat`-based snapshots; checkout-owned directories use scoped root identity.
Every exact target is revalidated before its action. A changed service blocks
dependent deletion. A changed `.env`, symlink replacement, or uninspectable
identity stays untouched, while unrelated approved work may continue.

Credential backups live in a private NanoClaw state directory outside the
checkout and are returned as external artifacts. Plan artifacts, action results,
and remaining artifacts stream one item per event. The terminal receipt says
whether the caller may safely delete the checkout:

```ts
checkoutRemoval: { safe: boolean; blockers: string[] }
```

NanoClaw never deletes the checkout.

## Cancellation and compatibility

Commands and presentation data are bounded. Closing stdin is disconnection, not
success. Cancellation reaches the current bootstrap/setup child process tree;
uninstall finishes the current atomic action and starts no new one. Exit codes
remain `0` complete, `1` error or incomplete uninstall, and `2` cancelled.

No protocol flag means the established terminal setup and uninstall behavior.
V1 intentionally adds no daemon, HTTP or WebSocket transport, remote auth,
persisted session, resume token, second setup engine, or new dependency.
