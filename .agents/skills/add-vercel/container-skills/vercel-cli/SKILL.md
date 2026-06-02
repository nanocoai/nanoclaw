---
name: vercel-cli
description: Deploy apps to Vercel. Use when asked to deploy, ship, or publish a web application, or manage Vercel projects, domains, and environment variables.
---

# Vercel CLI

You can deploy web applications to Vercel using the `vercel` CLI.

## Auth

Auth is handled by OneCLI — the HTTPS_PROXY injects the real token into API requests automatically. The Vercel CLI requires a token to be present to skip its local credential check, so **always pass `--token placeholder`** on every command. OneCLI replaces this with the real token at the proxy level.

Before any Vercel operation, verify auth:

```bash
vercel whoami --token placeholder
```

If this fails with an auth error, ask the user to add a Vercel token to OneCLI. They can create one at https://vercel.com/account/tokens and register it via `onecli secrets create` on the host. Once added, retry `vercel whoami`.

## Deploying

Always use `--yes` to skip interactive prompts and `--token placeholder` for auth (OneCLI replaces with real token).

```bash
# Deploy to production
vercel deploy --yes --prod --token placeholder

# Deploy from a specific directory
vercel deploy --yes --prod --token placeholder --cwd /path/to/project

# Preview deployment (not production)
vercel deploy --yes --token placeholder
```

After deploying, verify the live URL:

```bash
# Check deployment status
vercel inspect <deployment-url> --token placeholder
```

## Pre-Send Checks (do this before sharing the URL)

Don't send the deployment URL to the user until you've confirmed it's actually working. At minimum:

1. **Local build passes** — run `npm run build` (or the project's build command) before `vercel deploy`. If the build fails locally, fix it first; don't deploy broken code.
2. **Deployment succeeded** — the `vercel deploy` output shows a "Production: https://..." URL and the status is READY (confirm with `vercel inspect`).
3. **Live URL responds** — `curl -sI <url> | head -1` should return `HTTP/2 200` (or another 2xx/3xx). A 404/500 means something's broken even though Vercel reported success.
4. **Optional visual check** — if `agent-browser` is loaded, open the URL and eyeball it. Helpful for catching broken layouts that a 200 response wouldn't reveal.

If any check fails, fix the issue and redeploy before reporting to the user.

## Project Management

```bash
# Link to an existing Vercel project (non-interactive)
vercel link --yes --token placeholder

# List recent deployments
vercel ls --token placeholder

# List all projects
vercel project ls --token placeholder
```

## Domains

```bash
# List domains
vercel domains ls --token placeholder

# Add a domain to the current project
vercel domains add example.com --token placeholder
```

## Environment Variables

```bash
# Pull env vars from Vercel to local .env
vercel env pull --token placeholder

# Add an env var (use echo to pipe the value — avoids interactive prompt)
echo "value" | vercel env add VAR_NAME production --token placeholder
```

## Common Errors

| Error | Fix |
|-------|-----|
| `Error: No framework detected` | Ensure the project has a `package.json` with a `build` script, or set the framework in `vercel.json` |
| `Error: Rate limited` | Wait and retry. Don't loop — report to user |
| `Error: You have reached your project limit` | User needs to upgrade Vercel plan or delete unused projects |
| `ENOTFOUND api.vercel.com` | Network issue. Check proxy connectivity |
| Auth error after `vercel whoami` | Credential may be expired. Ask the user to refresh the Vercel token in OneCLI |

## Best Practices

- Run `npm run build` locally before deploying to catch build errors early
- Use `--cwd` instead of `cd` to keep your working directory stable
- For Next.js projects, `vercel deploy` auto-detects the framework — no extra config needed
- Use `vercel.json` only when you need custom build settings, rewrites, or headers
