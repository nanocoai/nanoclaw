---
name: gdrive-fetch
description: >-
  Search, read, and download files from Google Drive. Use when asked to find
  a file in Drive, read/summarize a Doc/Sheet/Slide, or fetch a Drive file's
  contents. Requires Google Drive to be connected in OneCLI — the
  onecli-gateway skill handles auth transparently, no separate MCP server.
---

# Google Drive Fetch

Read-only access to Google Drive via the Drive v3 REST API, proxied through
OneCLI (see the `onecli-gateway` skill — you already have transparent HTTPS
credential injection, no separate setup here). Just call the real API with
`curl`; do not add an `Authorization` header yourself.

Base URL: `https://www.googleapis.com/drive/v3`

## Search / list files

```bash
curl -s -G "https://www.googleapis.com/drive/v3/files" \
  --data-urlencode "q=name contains 'quarterly report' and trashed = false" \
  --data-urlencode "fields=files(id,name,mimeType,modifiedTime,size,webViewLink)"
```

`curl -G --data-urlencode` handles the escaping — always use it for `q` rather
than hand-building the query string; spaces and quotes break a raw one.

Common query clauses (combine with `and`):

| Clause | Matches |
|--------|---------|
| `name contains 'foo'` | Filename contains "foo" |
| `fullText contains 'foo'` | File content or metadata contains "foo" |
| `mimeType = 'application/vnd.google-apps.folder'` | Folders only |
| `mimeType = 'application/vnd.google-apps.document'` | Google Docs only (also `.spreadsheet`, `.presentation`) |
| `'<folderId>' in parents` | Direct children of a folder |
| `trashed = false` | Exclude trash (add to almost every query) |

## Get file metadata

```bash
curl -s "https://www.googleapis.com/drive/v3/files/<fileId>?fields=id,name,mimeType,size,parents,webViewLink,modifiedTime"
```

## Download a file's content

**Regular files** (PDF, images, plain text, zip, etc.) — download the raw bytes:

```bash
curl -s "https://www.googleapis.com/drive/v3/files/<fileId>?alt=media" -o /workspace/agent/downloaded-file
```

**Google-native files** (Docs, Sheets, Slides) have no raw bytes — they must
be **exported** to a real format:

```bash
# Google Doc -> plain text
curl -s "https://www.googleapis.com/drive/v3/files/<fileId>/export?mimeType=text/plain"

# Google Doc -> PDF
curl -s "https://www.googleapis.com/drive/v3/files/<fileId>/export?mimeType=application/pdf" -o /workspace/agent/doc.pdf

# Google Sheet -> CSV (first sheet only; use gid param workarounds for others)
curl -s "https://www.googleapis.com/drive/v3/files/<fileId>/export?mimeType=text/csv"

# Google Slides -> PDF
curl -s "https://www.googleapis.com/drive/v3/files/<fileId>/export?mimeType=application/pdf" -o /workspace/agent/slides.pdf
```

Check `mimeType` from the metadata call first to know whether a file needs
`alt=media` (regular file) or `/export` (Google-native file) — calling the
wrong one 400s.

## When a request fails

- **`app_not_connected` / 401 / 403** — Google Drive isn't connected in
  OneCLI yet. Tell the user to connect it via the `connect_url` in the error
  body, or the OneCLI dashboard at `http://127.0.0.1:10254` → Apps → Google
  Drive. Do not ask the user for a raw API key or token.
- **404** — wrong `fileId`, or the connected account doesn't have access to
  that file.
- **400 on `/export`** — the file isn't a Google-native type, or the
  requested `mimeType` isn't a valid export target for its type. Re-check
  metadata first.

## Notes

- This is **read-only by design** (search, get, download, export). Writing,
  uploading, or sharing files is out of scope for this skill.
- Large files: prefer downloading to `/workspace/agent/` and reading/grepping
  from disk over inlining huge responses into the conversation.
