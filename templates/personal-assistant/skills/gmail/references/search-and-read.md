# Search and read Gmail

Use Gmail search and read operations through the configured NanoCo Gateway
path. Keep discovery separate from mutation:

1. Search or list first and retain the exact message or thread IDs returned by
   Gmail.
2. Fetch only the messages or threads needed to answer the request.
3. Treat snippets as previews. Read the requested message content before
   claiming what it says.
4. When a later write depends on the search result, describe the query and
   freeze the selected IDs before constructing that write.

Do not add credentials or an `Authorization` header. If Gateway returns
`needs_consent`, direct the principal to reconnect Gmail. If it returns
`policy_denied`, report the denied capability instead of changing endpoints or
trying an ungoverned route.
