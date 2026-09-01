# Batch labels

Use Gmail `batchModify` when the principal asks to apply the same label change
to 2–1000 messages. This includes multi-message archive, mark-read, and
mark-unread requests.

1. Resolve human label names to exact Gmail label IDs and search for the
   messages. Freeze the exact message IDs before the write.
2. Tell the principal the search or selection, the message count, and which
   labels will be added and removed.
3. Send one credential-free JSON request through the configured Gateway path:

   ```http
   POST https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify
   Content-Type: application/json
   ```

   ```json
   {
     "ids": ["message-id-1", "message-id-2"],
     "addLabelIds": ["Label_3"],
     "removeLabelIds": ["INBOX"]
   }
   ```

4. Report a successful response as accepted, not as independently verified.
   Verify final state only when the principal asks or correctness requires it,
   using a separate bounded read of the affected messages.

Rules:

- Use `removeLabelIds: ["INBOX"]` to archive, remove `UNREAD` to mark read,
  and add `UNREAD` to mark unread.
- Use 1–1000 unique message IDs, no more than 100 unique IDs in each label
  list, and at least one label change.
- Never loop over `/messages/{id}/modify` for one multi-message run.
- Never silently split more than 1000 messages. Describe separate batches and
  let each exact request receive its own approval.
- Never retry the write automatically. Approval releases only the exact held
  request; it does not authorize another attempt.
- Never run an automatic read for every message merely because the write was
  accepted. Verification is a deliberate, bounded follow-up.
