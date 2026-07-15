# Next-session status — 2026-07-15 (end of quota sprint)

## Where things stand

**ATS auto-apply system: LIVE IN PRODUCTION** (droplet 147.182.136.60 + elia-apply-view.vercel.app).
Code lives in `groups/dm-with-shellanoo/cv-system/` + `apply-view/` (gitignored — deployed, not in this repo).
Full context in auto-memory: `ats-job-sourcing-design` entry in MEMORY.md.

- Two-phase gate proven end-to-end: queue → fill+screenshot → Elia approves → submit → positive verification.
- **Comeet = only cloud-auto-submittable platform** (Kaltura "Thank you Elia!" confirmed 2026-07-15).
- **Greenhouse / Ashby / Lever = desktop-tier** (datacenter-IP blocked: GH emails 8-char verify code, Ashby flags spam, Lever hCaptcha). Blue "open & submit yourself" cards shipped; applied.json auto-logs on `sent`.
- Awaiting Elia: click-through of the 2 staged desktop cards (AppsFlyer PPM, monday.com CPM).

## What's left (in order)

1. **PR to nanocoai/nanoclaw** — BLOCKED: `elia-ben-cnaan` has no write access (403), and a public
   fork would expose private code. Branch `feat/quota-fallback` (HEAD `04df28fb`) is committed locally;
   delta bundle at `transfer/quota-fallback.bundle` (+ fresh one from 07-14 in /tmp, regenerate if gone:
   `git bundle create x.bundle origin/main..feat/quota-fallback`). Message for Daniel drafted (ask Elia).
   Private backup repo `elia-ben-cnaan/nanoclaw-backup` exists but push needs `gh auth refresh -s workflow`
   run by Elia himself (OAuth workflow scope + exfil guard).
2. **Next ATS platform** — Personio/Recruitee/Workable fetchers already in `ats-lib.mjs` (resolver
   detects them → desktop-tier links). No fill handlers yet; build only if board data shows volume.
3. **Board composition** — open board is Drushim-heavy; bias scanner toward GH/Comeet tech companies
   to raise the auto-submittable share (3/18 measured 2026-07-14).
4. **Dedupe check** — fixed queue.mjs deployed 07-14; verify next nightly merged the Kaltura dup pair.

## Gotchas for next session

- Deploys run from HOST (not container): `cv-system/deploy-droplet-host.mjs` (ssh2, key at
  `groups/dm-with-shellanoo/.ssh/do_brain`) and `apply-view/deploy-host.mjs` (VERCEL_TOKEN via env
  from CLAUDE.local.md — read from file, never on the CLI).
- Ashby forms are React-controlled: label-clicks only, `check({force})` silently no-ops the submit.
- Comeet rejects .txt cover letters — letter goes in the personal-note field.
- 'sent' verdict requires POSITIVE confirmation (thank-you / form gone); spam/verify-code/validation
  are detected distinctly. Never regress to absence-of-error.
