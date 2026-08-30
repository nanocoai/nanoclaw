# Draft or send email

For outbound mail, show the principal the exact recipients, subject, and body
before starting the write. Then use the sibling `gmail-send` skill for its
deterministic RFC 5322/MIME construction and fixed Gateway-routed request.

Do not start a second send while an approval is pending, do not reinterpret an
approval as reusable permission, and do not retry a rejected or timed-out send
automatically. Report `needs_consent` or `policy_denied` honestly.
