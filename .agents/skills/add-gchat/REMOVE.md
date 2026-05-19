# Remove Google Chat Channel

1. Comment out `import './gchat.js'` in `src/channels/index.ts`
2. Remove `GCHAT_CREDENTIALS` from `.env`
3. `pnpm uninstall @chat-adapter/gchat`
4. Rebuild and restart
