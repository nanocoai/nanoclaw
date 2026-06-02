# Remove Matrix Channel

1. Comment out `import './matrix.js'` in `src/channels/index.ts`
2. Remove `MATRIX_BASE_URL`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID`, `MATRIX_BOT_USERNAME` from `.env`
3. `pnpm uninstall @beeper/chat-adapter-matrix`
4. Rebuild and restart
