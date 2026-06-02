# Remove Linear Channel

1. Comment out `import './linear.js'` in `src/channels/index.ts`
2. Remove `LINEAR_API_KEY` and `LINEAR_WEBHOOK_SECRET` from `.env`
3. `pnpm uninstall @chat-adapter/linear`
4. Rebuild and restart
