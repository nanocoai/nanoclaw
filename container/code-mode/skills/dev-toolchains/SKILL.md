---
name: dev-toolchains
description: Install the project's toolchain versions in the persistent workspace before building or testing.
---

# Project toolchains

Install under `/workspace/tools`, with executable links in
`/workspace/tools/bin`. Check existing versions before installing; a container
restart preserves this directory.

```bash
export PATH="/workspace/tools/bin:$PATH"
```

Use versions declared by the project. The sandbox has no access to the Docker
daemon.

Honor the supplied proxy and trust configuration, including `HTTPS_PROXY`,
`NO_PROXY`, `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`. Verify downloads using
the publisher's checksums. Report inaccessible download origins to the operator.
