# Remove WhatsApp Cloud API Channel

1. Comment out `import './whatsapp-cloud.js'` in `src/channels/index.ts`
2. Remove `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` from `.env`
3. `pnpm uninstall @chat-adapter/whatsapp`
4. Rebuild and restart
