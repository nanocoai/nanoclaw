---
name: learn-from-clawhub
description: "Learn how to do things by finding and installing skills from ClawHub. Use when user says 'learn how to', 'learn to', 'learn X', or wants to find/install skills. Triggers on: learn, learn how to, clawhub, find skill, install skill."
---

# Learn Skills from ClawHub

Search, explore, and install agent skills from the ClawHub registry using the `clawhub` CLI.

## Prerequisites

### Installing the ClawHub CLI

Check if `clawhub` is installed:

```bash
clawhub --help
```

If not installed, you have two options:

**Option 1: Run without installing (recommended for one-off use)**

```bash
# Using bun
bunx clawhub@latest --help

# Using npm
npx clawhub@latest --help
```

**Option 2: Install globally**

```bash
# Using bun
bun install -g clawhub@latest

# Using npm
npm install -g clawhub@latest
```

All commands in this skill assume `clawhub` is installed globally. If using `bunx`/`npx`, prefix commands accordingly (e.g., `bunx clawhub@latest search "notion"`).

## Commands Reference

| Command | Purpose |
|---------|---------|
| `clawhub search <query>` | Vector search for skills by description or functionality |
| `clawhub explore` | Browse latest/trending skills |
| `clawhub inspect <slug>` | View skill metadata before installing |
| `clawhub install <slug>` | Install a skill to the local skills directory |
| `clawhub list` | Show currently installed skills (from lockfile) |
| `clawhub update [slug]` | Update installed skills |
| `rm -rf .claude/skills/<slug>` | Uninstall a skill (manual removal) |

## Workflow

### 1. Understanding the User's Need

When the user asks to learn a skill, first clarify:
- What capability do they want? (e.g., "I want to interact with Notion")
- Are they looking for a specific skill or exploring options?

### 2. Search for Skills

Use vector search to find relevant skills:

```bash
clawhub search "notion integration" --limit 10
```

The search returns skills with relevance scores. Present the top results to the user with:
- Skill name and version
- Short description
- Relevance score

### 3. Inspect Before Installing

Before installing, show the user what they're getting:

```bash
# View metadata
clawhub inspect <slug>

# List files included
clawhub inspect <slug> --files

# View the SKILL.md content
clawhub inspect <slug> --file SKILL.md
```

This helps the user understand:
- What the skill does
- What tools or APIs it requires
- Any prerequisites or configuration needed

### 4. Install the Skill

Install to the project's skills directory:

```bash
clawhub install <slug> --dir .claude/skills
```

For updates or reinstalls:

```bash
clawhub install <slug> --dir .claude/skills --force
```

### 5. Post-Install

After installation:

1. Read the installed skill's SKILL.md to understand its requirements
2. Inform the user of any setup steps (API keys, dependencies, configuration)
3. The skill will be available immediately via `/skill-name`

## Examples

### User wants a skill for web scraping

```bash
# Search
clawhub search "web scraping browser automation" --limit 5

# Inspect the best match
clawhub inspect web-scraper --files
clawhub inspect web-scraper --file SKILL.md

# Install
clawhub install web-scraper --dir .claude/skills
```

### User wants to explore available skills

```bash
# Browse trending skills
clawhub explore --sort trending --limit 10

# Browse newest skills
clawhub explore --sort newest --limit 10

# Browse most downloaded
clawhub explore --sort downloads --limit 10
```

### User wants to see installed skills

```bash
# List from clawhub lockfile
clawhub list --dir .claude/skills

# Or list skill directories directly
ls -la .claude/skills/
```

### User wants to update installed skills

```bash
# Update all
clawhub update --dir .claude/skills

# Update specific skill
clawhub update <slug> --dir .claude/skills
```

### User wants to uninstall a skill

The `clawhub` CLI doesn't have an uninstall command. Remove manually:

```bash
# Remove the skill directory
rm -rf .claude/skills/<slug>

# Example: uninstall web-scraper
rm -rf .claude/skills/web-scraper
```

After removal, the skill will no longer be available. If it was installed via `clawhub install`, also clean the lockfile entry:

```bash
# Check if there's a lockfile
cat .claude/skills/clawhub.lock 2>/dev/null || echo "No lockfile"
```

## Troubleshooting

### "Skill not found"

- Double-check the slug spelling
- Try a broader search query
- The skill may have been deleted or hidden

### "Permission denied" or auth errors

```bash
clawhub login
clawhub whoami  # Verify login
```

### Skill conflicts with existing files

Use `--force` to overwrite:

```bash
clawhub install <slug> --dir .claude/skills --force
```

### Skill requires dependencies

After installing, read the skill's SKILL.md for setup instructions. Common requirements:
- NPM packages: `npm install <package>`
- API keys: Add to config files or environment
- MCP servers: May start automatically if skill bundles `mcp.json`
