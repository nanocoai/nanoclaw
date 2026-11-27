---
name: google-reader
description: Read public Google Docs, Sheets, and Slides by URL. Fetches plain text content without requiring authentication. Use whenever the user shares a Google Docs, Sheets, or Slides link and wants you to read, summarize, or answer questions about it.
---

# Reading Public Google Docs, Sheets, and Slides

Use this skill when the user shares a Google Docs, Sheets, or Slides URL and wants you to read its contents.

## How it works

Google provides a public export endpoint for any file shared with "Anyone with the link can view". No API key or authentication is needed.

## Step 1 — Extract the document ID

The document ID is the long alphanumeric string in the URL:

| URL pattern | ID location |
|-------------|-------------|
| `docs.google.com/document/d/{ID}/...` | Docs |
| `docs.google.com/spreadsheets/d/{ID}/...` | Sheets |
| `docs.google.com/presentation/d/{ID}/...` | Slides |

## Step 2 — Detect the type and fetch

**Google Docs** → plain text:
```bash
curl -sL "https://docs.google.com/document/d/{ID}/export?format=txt"
```

**Google Sheets** → CSV (first sheet):
```bash
curl -sL "https://docs.google.com/spreadsheets/d/{ID}/export?format=csv"
```

For a specific sheet by index (0-based):
```bash
curl -sL "https://docs.google.com/spreadsheets/d/{ID}/export?format=csv&gid=0"
```

**Google Slides** → plain text (slide text + speaker notes):
```bash
curl -sL "https://docs.google.com/presentation/d/{ID}/export?format=txt"
```

## Error handling

- **403 or redirect to accounts.google.com** — the document is not publicly shared. Tell the user: "This document is private. Please set sharing to 'Anyone with the link can view' and try again."
- **404** — the document does not exist or the URL is malformed.
- **Empty output** — the document exists but has no text content (e.g. a Slides deck with only images).

## Example

User shares: `https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit`

Extract ID: `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms`

Detect type: `/document/` → Docs

Fetch:
```bash
curl -sL "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/export?format=txt"
```

Then read and respond to whatever the user asked about the content.
