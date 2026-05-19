# Remove Resend Email Channel

1. Comment out `import './resend.js'` in `src/channels/index.ts`
2. Remove `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `RESEND_FROM_NAME`, `RESEND_WEBHOOK_SECRET` from `.env`
3. `pnpm uninstall @resend/chat-sdk-adapter`
4. Rebuild and restart
