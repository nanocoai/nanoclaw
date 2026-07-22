---
name: add-omarchy-statusbar
description: Add a Waybar status indicator for NanoClaw on Omarchy (Linux/Hyprland). Shows the NanoClaw logo per install (teal when running, greyed when stopped), with left-click toggle, right-click restart, and middle-click logs. Omarchy/Waybar only.
---

# Add Omarchy (Waybar) Status Indicator

Adds a persistent Waybar module — one NanoClaw logo per install — that shows
whether the service is running and lets the user control it, the Linux
counterpart to `/add-macos-statusbar`.

- **Teal logo** — install is running
- **Greyed logo** — install is stopped
- **Left-click** — toggle (start if stopped, stop if running)
- **Right-click** — restart
- **Middle-click** — tail logs in a floating terminal
- **Tooltip** — friendly label, live status, and uptime

**Omarchy / Waybar only.** NanoClaw must run as systemd **user** services
named `nanoclaw*.service` (the default on Linux installs). The skill discovers
every such install automatically and adds one icon each — nothing is hardcoded.
No extra tooling required — the icon PNGs ship with the skill.

Whenever you edit `~/.config/waybar/`, the **omarchy** skill's rules apply:
edit only under `~/.config/`, back up before changing, and restart Waybar
explicitly (it does not auto-reload).

## Phase 1: Pre-flight

### Check platform

```bash
command -v waybar >/dev/null && test -f ~/.config/waybar/config.jsonc && echo OK
```

If this does not print `OK`, stop and tell the user this skill is Omarchy
(Waybar) only and Waybar / `~/.config/waybar/config.jsonc` wasn't found.

### Discover NanoClaw installs

```bash
systemctl --user list-unit-files 'nanoclaw*.service' --no-legend | awk '{print $1}' | sed 's/\.service$//'
```

Each line is a unit to add an icon for (e.g. `nanoclaw-v2-46060b32`). If the
list is empty, stop and tell the user no NanoClaw systemd **user** service was
found — they should finish `/setup` (service step) first.

### Check if already installed

```bash
grep -q 'nanoclaw-' ~/.config/waybar/config.jsonc && echo INSTALLED
```

If it prints `INSTALLED`, re-run the steps below to **re-sync** — add icons for
any new installs, refresh the scripts, and skip modules already present. Then
go to Phase 3.

## Phase 2: Install

### Copy the scripts and icons

The scripts are generic (they take a unit name as an argument) and the two
icon PNGs (`nanoclaw-running.png` = teal, `nanoclaw-stopped.png` = grey) ship
with the skill. Copy the whole set into the user's Waybar config tree so it
survives the repo moving:

```bash
DEST=~/.config/waybar/scripts/nanoclaw
mkdir -p "$DEST"
cp "${CLAUDE_SKILL_DIR}"/add/bin/* "$DEST/"
chmod +x "$DEST"/nanoclaw-waybar-*
```

The image script resolves the PNGs from its own directory, so no paths need
editing.

### Back up the Waybar config

```bash
cp ~/.config/waybar/config.jsonc ~/.config/waybar/config.jsonc.bak.$(date +%s)
cp ~/.config/waybar/style.css    ~/.config/waybar/style.css.bak.$(date +%s)
```

### Add one module per install

For **each** discovered unit `<unit>` (derive `<slug>` as the last
`-`-separated segment, or any short unique token), use the **Edit tool** to:

1. Add an `image` module to `config.jsonc` (alongside the other module
   objects). Use `$HOME` — Waybar runs `exec`/`on-click` through a shell:

   ```jsonc
   "image#nanoclaw-<slug>": {
     "exec": "$HOME/.config/waybar/scripts/nanoclaw/nanoclaw-waybar-image <unit>",
     "size": 18,
     "interval": 5,
     "signal": 11,
     "tooltip": true,
     "on-click": "$HOME/.config/waybar/scripts/nanoclaw/nanoclaw-waybar-action toggle <unit>",
     "on-click-right": "$HOME/.config/waybar/scripts/nanoclaw/nanoclaw-waybar-action restart <unit>",
     "on-click-middle": "$HOME/.config/waybar/scripts/nanoclaw/nanoclaw-waybar-action logs <unit>"
   }
   ```

2. Add `"image#nanoclaw-<slug>"` to a modules array so it renders. Good spots:
   inside `group/tray-expander`'s `modules` (tucked behind the tray arrow),
   the start of `modules-right`, or after `custom/omarchy` in `modules-left`.
   Ask the user if unsure.

**Signal note:** the scripts refresh Waybar with `RTMIN+11`. If signal `11` is
already used, pick a free number, update the `"signal"` field(s), and change
`RTMIN+11` in `nanoclaw-waybar-action` to match. All NanoClaw modules can
safely share one signal.

### Add spacing (optional)

Append to `~/.config/waybar/style.css` (one rule per slug, or a shared list):

```css
/* NanoClaw status indicator (image module: teal=running, grey=stopped) */
#nanoclaw-<slug> { margin: 0 5px; }
```

### Restart Waybar

Waybar does not auto-reload:

```bash
omarchy restart waybar
```

## Phase 3: Verify

```bash
pgrep -x waybar >/dev/null && echo "waybar up"
~/.config/waybar/scripts/nanoclaw/nanoclaw-waybar-image <unit>   # prints path + tooltip
```

Tell the user the NanoClaw logo now appears in their Waybar for each install
(if placed inside the tray-expander, they must expand the arrow to see it):

> - **Teal** — running · **Grey** — stopped
> - **Left-click** — start/stop · **Right-click** — restart · **Middle-click** — logs
> - Hover for the install name + uptime. Polls every 5s; updates instantly after a click.

To uninstall, follow [REMOVE.md](REMOVE.md).
