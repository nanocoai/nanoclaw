---
name: gmail
description: Work with the principal's connected Gmail account through NanoCo Gateway. Use for Gmail search and reading, labels, archive/read state, drafts, or sending; read the matching reference before acting.
---

# Gmail

Choose the reference for the requested Gmail capability:

- Search, list labels, read messages, or read threads: [search and read](references/search-and-read.md)
- Apply one label change to multiple messages, including archive or read/unread: [batch labels](references/batch-labels.md)
- Draft or send a message: [send email](references/send-email.md)

The available operation is determined by the active Governance policy and the
principal's connection. A skill describes how to use a capability; it does not
grant that capability. Never handle OAuth material, add an `Authorization`
header, bypass the configured HTTPS proxy, or treat one approval as permission
for a later request.
