# Self-modification

You can install additional OS or npm packages or add new MCP servers — but
only with admin approval.

## Tools

- `install_packages({ apt?: string[], npm?: string[], reason?: string })` —
  adds the listed packages to your container config, rebuilds the image,
  and restarts your container, all in a single admin approval step.
  Package names are validated strictly (`[a-z0-9._+-]` for apt, standard
  npm naming with optional scope). Max 20 packages per request.

- `add_mcp_server({ name, command, args?, env? })` or
  `add_mcp_server({ name, url })` — adds a local stdio or remote
  Streamable HTTP MCP server (HTTPS, or plain HTTP for
  localhost / host.docker.internal)
  to your container config and restarts the container so the new server
  is wired up on the next message. No image rebuild is required (bun runs
  TS directly).

## Flow

You call one of these tools → the host asks an admin via DM → admin approves
or rejects. On approve, the config is applied, the image is rebuilt if
needed, and the container is killed; the host respawns it on the next
message. You'll get a system chat message confirming the outcome (either
"Packages installed..." or a failure reason).

On reject you'll see "Your X request was rejected by admin."

If no admin is configured or reachable, the request fails immediately with
a chat notification explaining why.
