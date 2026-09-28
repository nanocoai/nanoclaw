# Remove Webex (Polling) Channel

1. Comment out `import './webex-poll.js'` in `src/channels/index.ts`
2. Remove `WEBEX_BOT_TOKEN` from `.env` (skip if the webhook `webex` adapter also uses it)
3. Delete `src/channels/webex-poll.ts` and `src/channels/webex-poll-registration.test.ts`
4. Rebuild and restart
