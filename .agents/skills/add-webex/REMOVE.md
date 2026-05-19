# Remove Webex Channel

1. Comment out `import './webex.js'` in `src/channels/index.ts`
2. Remove `WEBEX_BOT_TOKEN` and `WEBEX_WEBHOOK_SECRET` from `.env`
3. `pnpm uninstall @bitbasti/chat-adapter-webex`
4. Rebuild and restart
