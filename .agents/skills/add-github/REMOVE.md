# Remove GitHub Channel

1. Comment out `import './github.js'` in `src/channels/index.ts`
2. Remove `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET` from `.env`
3. `pnpm uninstall @chat-adapter/github`
4. Rebuild and restart
