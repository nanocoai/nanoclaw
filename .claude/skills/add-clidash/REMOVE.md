# Remove /add-clidash

clidash is fully self-contained, so removal is a single directory delete. It
made no edits to NanoClaw `src/`, added no dependency, and wired into nothing.

```bash
# Stop the service first if you set one up:
systemctl --user disable --now clidash 2>/dev/null || true
rm -f ~/.config/systemd/user/clidash.service

# Remove the tool:
rm -rf tools/clidash
```

If you added the config to `.gitignore` in step 2 of the install, remove that
line too:

```
tools/clidash/clidash.config.json
```

Nothing else needs reverting.
