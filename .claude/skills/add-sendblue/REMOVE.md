# Remove Sendblue

Run from the project root. These steps are safe to repeat.

1. Remove only this deployment's receive webhook in the Sendblue dashboard and
   stop its public tunnel/route. Preserve other webhook registrations.
2. Delete `import './sendblue.js';` from `src/channels/index.ts`.
3. In the delivery-error catch in `src/delivery.ts`, remove the dynamic
   `isTerminalSendblueDeliveryError(err) ||` clause and restore the condition to
   `if (attempts !== null && attempts >= MAX_DELIVERY_ATTEMPTS)`.
   Preserve the condition's body and unrelated edits. Skip if already restored.
4. Delete the four copied files:

```bash
rm -f src/channels/sendblue.ts src/channels/sendblue-delivery.ts \
  src/channels/sendblue.test.ts src/channels/sendblue-registration.test.ts
```

5. Remove `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`,
   `SENDBLUE_SIGNING_SECRET`, and `SENDBLUE_ALLOW_FROM` from the host `.env`.
   Remove `add-sendblue` from the fork recipe skill if Apply added it there. Preserve shared
   `WEBHOOK_PORT`, the Sendblue CLI's credentials (other apps may use them),
   host identities, roles, and conversation history.
6. Run `pnpm run build`, `pnpm exec vitest run src/delivery.test.ts`, and
   `bash setup/lib/restart.sh`. Confirm Sendblue is absent from the channel
   registry. Use normal channel management to detach unwanted Sendblue wirings.
