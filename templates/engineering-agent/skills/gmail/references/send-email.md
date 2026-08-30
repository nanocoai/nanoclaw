# Draft or send email

Show the principal the exact recipients, subject, and body before starting an
outbound write. Follow the shared `nanoco-gw` Gmail MIME guidance to construct
the governed request; never add credentials or an `Authorization` header.

Do not start a second send while an approval is pending, do not reinterpret an
approval as reusable permission, and do not retry a rejected or timed-out send
automatically. Report `needs_consent` or `policy_denied` honestly.
