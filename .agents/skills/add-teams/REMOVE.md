# Remove Microsoft Teams Channel

1. Comment out `import './teams.js'` in `src/channels/index.ts`
2. Remove `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD` from `.env`
3. `pnpm uninstall @chat-adapter/teams`
4. Rebuild and restart
