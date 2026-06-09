## 1. Configuration and Commands

- [x] 1.1 Extend `ContainerConfig` with per-group voice notification settings.
- [x] 1.2 Add `/voice on|off|status` command for the current group.
- [x] 1.3 Add command tests for enabling, disabling, and reading status.

## 2. Voice Notification Core

- [x] 2.1 Refactor `voice-notify.ts` to accept a context object instead of only `groupFolder`.
- [x] 2.2 Extract pure functions for Pushover voice eligibility, group label resolution, and spoken text formatting.
- [x] 2.3 Use Pushover sink for all enabled groups.
- [x] 2.4 Keep Pushover delivery fire-and-forget with bounded error handling.
- [x] 2.5 Remove main-group default notification behavior.

## 3. Feishu Integration

- [x] 3.1 Pass `chatJid`, `groupFolder`, group name, config, and alias lookup into `notifyVoice`.
- [x] 3.2 Trigger voice push only from final reply text after media markers are stripped.
- [x] 3.3 Ensure progress/toolcard paths never trigger voice push.

## 4. Tests and Verification

- [x] 4.1 Add pure function tests for eligibility, alias fallback, and spoken text.
- [x] 4.2 Add Pushover push tests for enabled groups, missing tokens, and legacy config compatibility.
- [x] 4.3 Add Feishu integration tests for enabled and disabled groups.
- [x] 4.4 Run targeted tests and `npm run build`.
