# Remove Signal

1. Comment out `import './signal.js'` in `src/channels/index.ts`
2. Remove `SIGNAL_ACCOUNT` (and any other `SIGNAL_*` vars) from `.env`
3. Rebuild and restart

If you also want to unlink the Signal account from `signal-cli`:

```bash
signal-cli -a +1YOURNUMBER removeDevice --deviceId <id>
```

(Find the device id with `signal-cli -a +1YOURNUMBER listDevices`.)
