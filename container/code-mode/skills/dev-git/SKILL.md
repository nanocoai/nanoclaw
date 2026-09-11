---
name: dev-git
description: Configure workspace-persistent Git settings and use the credentials and trust provided by the environment.
---

# Git in a persistent workspace

Set this before writing global settings, and repeat the export each session:

```bash
export GIT_CONFIG_GLOBAL=/workspace/.gitconfig
```

The container home may be replaced on restart. The workspace copy preserves
your configuration. Configure your author name and email there as needed.

When your environment uses an HTTP proxy, HTTPS remotes can use it. An
optional rewrite for tools that choose SSH URLs is:

```bash
git config --global url."https://github.com/".insteadOf git@github.com:
git config --global --add url."https://github.com/".insteadOf ssh://git@github.com/
```

Honor `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`. If the environment supplies
`SSL_CERT_FILE`, use that trust bundle for Git:

```bash
if [ -n "${SSL_CERT_FILE:-}" ]; then
  git config --global http.sslCAInfo "$SSL_CERT_FILE"
fi
```

Credentials are supplied by the configured gateway provider. Report an
authentication or authorization failure with the origin and operation; do not
persist a token in a remote URL, file, or environment variable.
