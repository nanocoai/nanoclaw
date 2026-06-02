# Remove Slack

1. Comment out `import './slack.js'` in `src/channels/index.ts`
2. Remove `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` from `.env`
3. `pnpm uninstall @chat-adapter/slack`
4. Rebuild and restart
