# Remove the Omarchy (Waybar) status indicator

1. **Edit `~/.config/waybar/config.jsonc`** (back it up first):
   - Delete every `"image#nanoclaw-<slug>": { ... }` module object.
   - Remove each `"image#nanoclaw-<slug>"` entry from its modules array
     (`modules-right`, `modules-left`, or inside `group/tray-expander`).

   ```bash
   cp ~/.config/waybar/config.jsonc ~/.config/waybar/config.jsonc.bak.$(date +%s)
   ```

2. **Edit `~/.config/waybar/style.css`** — remove the
   `#nanoclaw-<slug>` spacing rule(s) and the NanoClaw comment.

3. **Remove the scripts:**

   ```bash
   rm -rf ~/.config/waybar/scripts/nanoclaw
   ```

4. **Restart Waybar:**

   ```bash
   omarchy restart waybar
   ```

The NanoClaw systemd services themselves are untouched — this only removes the
Waybar indicator.
