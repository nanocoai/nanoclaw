# Remove Telegram

1. Comment out `import './telegram.js'` in `src/channels/index.ts`
2. Remove `TELEGRAM_BOT_TOKEN` from `.env`
3. `pnpm uninstall @chat-adapter/telegram`
4. Rebuild and restart
