# Remove iMessage Channel

1. Comment out `import './imessage.js'` in `src/channels/index.ts`
2. Remove iMessage env vars (`IMESSAGE_ENABLED`, `IMESSAGE_LOCAL`, `IMESSAGE_SERVER_URL`, `IMESSAGE_API_KEY`) from `.env`
3. `pnpm uninstall chat-adapter-imessage`
4. Rebuild and restart
