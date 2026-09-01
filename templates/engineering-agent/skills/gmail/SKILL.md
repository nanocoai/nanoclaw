---
name: gmail
description: Work with the principal's connected Gmail account through NanoCo Gateway for the engineering template's search, read, draft, and send capabilities. Read the matching reference before acting.
---

# Gmail

Choose the reference for the requested Gmail capability:

- Search, list labels, read messages, or read threads: [search and read](references/search-and-read.md)
- Draft or send a message: [send email](references/send-email.md)

This template does not request Gmail label modification or deletion. Do not
offer those workflows from this skill. The available operation is determined
by the active Governance policy and the principal's connection; this guidance
does not grant a capability. Never handle OAuth material, add an
`Authorization` header, bypass the configured HTTPS proxy, or treat one
approval as permission for a later request.
