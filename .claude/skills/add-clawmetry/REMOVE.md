# Remove /add-clawmetry

ClawMetry is installed as a Python package outside this repo. It made no edits
to NanoClaw source, added no dependency, and wired into nothing, so removal is
one command:

```bash
pip uninstall clawmetry
```

If you enabled cloud sync at some point, delete the local sync state too:

```bash
rm -rf ~/.clawmetry
```

Nothing in the NanoClaw checkout needs reverting.
