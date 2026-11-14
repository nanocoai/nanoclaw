---
name: add-blossom
description: Add Blossom media hosting to NanoClaw. Your agent can upload images, audio, and files to a content-addressed Blossom server and share permanent, uncensorable URLs in Nostr posts and chats.
---

# Add Blossom Media Hosting

This skill adds the ability to upload files to a [Blossom](https://github.com/hzrd149/blossom) server and get back permanent, content-addressed URLs. Blossom files are identified by their SHA-256 hash — the URL never changes, and no platform can take the file down by deplatforming you.

The agent uses Blossom URLs in Nostr posts, article hero images, and any time it needs to share a file that must stay accessible. Uploads are signed with your Nostr key (via the signing daemon) — no username or password needed.

**Recommended:** Install `skill/nostr` first. Blossom uses Nostr key signing for auth. If you don't have a Nostr keypair, this skill can still work with a public Blossom server that doesn't require auth.

## Phase 1: Pre-flight

### Check if already applied

Check whether `tools/nostr-signer/blossom-upload.js` exists. If it does, skip to Phase 3.

### Requirements

- A Blossom server you can upload to:
  - **Self-hosted:** [blossom-server](https://github.com/hzrd149/blossom-server) (recommended for sovereignty)
  - **Public:** [blossom.band](https://blossom.band), [media.nostr.band](https://media.nostr.band), or any BUD-01 compatible server
- Nostr keypair (if your server requires NIP-98 auth — recommended)

### Ask the user

Use `AskUserQuestion` to collect:

AskUserQuestion: Do you have a Blossom server URL? (e.g., `https://blossom.yourdomain.com` or a public server like `https://blossom.band`)

If they're self-hosting, ask for the server URL. If they want to use a public server, recommend `https://blossom.band`.

## Phase 2: Apply Code Changes

### Ensure the Jorgenclaw remote

```bash
git remote -v
```

If `jorgenclaw` is missing, add it:

```bash
git remote add jorgenclaw https://github.com/jorgenclaw/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch jorgenclaw skill/blossom
git merge jorgenclaw/skill/blossom || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `tools/nostr-signer/blossom-upload.js` — upload CLI (also handles URL mirroring and blob deletion)
- `container/skills/blossom/SKILL.md` — agent instructions for upload, mirror, and URL patterns
- `BLOSSOM_SERVER_URL` added to `.env.example`

**Note:** If `skill/nostr` is already merged, `tools/nostr-signer/` already exists. The merge just adds `blossom-upload.js` — no conflict.

### Install dependencies

If `skill/nostr` was already merged, dependencies are already installed. Otherwise:

```bash
cd tools/nostr-signer && npm install && cd ../..
```

## Phase 3: Setup

### Configure Blossom server URL

```bash
# Add to .env:
BLOSSOM_SERVER_URL=https://blossom.yourdomain.com
```

If using a public server, set accordingly (e.g., `https://blossom.band`).

Restart the container for env changes to take effect.

### Test upload

```bash
echo "hello blossom" > /tmp/test.txt
node tools/nostr-signer/blossom-upload.js /tmp/test.txt
```

If it prints a URL like `https://blossom.yourdomain.com/<sha256>`, the upload is working.

### Optional: Configure your Blossom server's allowed pubkeys

If you're running your own Blossom server, you'll need to add your Nostr pubkey to the allowlist. Check your Blossom server's config file (usually `config.yml` or environment variables) for a `allowedPubkeys` or similar setting.

Your pubkey (hex format) is printed by `clawstr-post pubkey`.

## Phase 4: Verify

### Upload an image

```bash
node tools/nostr-signer/blossom-upload.js /path/to/any-image.jpg
```

This should print a URL. Open it in a browser — you should see the image.

### Mirror a remote URL

```bash
node tools/nostr-signer/blossom-upload.js https://example.com/image.jpg --mirror
```

This downloads the remote file, uploads it to your Blossom server, and returns your permanent URL.

## Phase 5: Using the skill

Your agent now has Blossom upload capabilities described in `container/skills/blossom/SKILL.md`. The agent understands:

- Uploading local files and getting permanent content-addressed URLs
- Mirroring remote URLs to your sovereign server
- Including Blossom URLs in Nostr posts as `imeta` tags (NIP-92) for inline display
- Checking file availability and deleting blobs when needed

Ask the agent: *"Upload this image to Blossom and post it to Nostr."* or *"Mirror this external image URL to our Blossom server."*

## Self-Hosting Blossom

If you want your own Blossom server:

```bash
# Quick setup with Docker
docker run -d \
  -p 9000:9000 \
  -v /path/to/data:/data \
  -e NOSTR_PUBKEY_ALLOWLIST=<your-hex-pubkey> \
  ghcr.io/hzrd149/blossom-server:latest
```

Then point a subdomain at it (e.g., `blossom.yourdomain.com` via reverse proxy). Files are stored in `/path/to/data` on your host — you control everything.

Recommended server settings:
- No time-based retention — use quota-based limits instead
- HTTPS required (use Caddy or nginx with Let's Encrypt)
- Require NIP-98 auth to prevent anonymous uploads

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| `Signer: connect ENOENT` | Nostr signing daemon not running | `sudo systemctl start nostr-signer` (requires `skill/nostr`) |
| `403 Forbidden` on upload | Server requires auth, pubkey not in allowlist | Add your pubkey to `allowedPubkeys` in Blossom server config |
| `File too large` | Server has a max file size | Check server's `maxUploadSize` setting; split or compress the file |
| URL returns 404 after upload | Server deleted the file | Check server storage and retention settings |
| `BLOSSOM_SERVER_URL not set` | Missing env var | Add `BLOSSOM_SERVER_URL` to .env and restart container |
