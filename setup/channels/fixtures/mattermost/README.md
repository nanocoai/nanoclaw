# Mattermost E2E fixture

This Compose definition is for NanoClaw development and E2E only. The
`/add-mattermost` skill does not install, start, or manage it. It keeps a
repeatable real-server fixture for adapter, callback, restart, and approval
acceptance tests.

The pinned Mattermost image currently requires a Linux AMD64 Docker daemon.
Keep the fixture in an isolated test environment and retain its data until the
test evidence has been collected. Test harnesses should copy `compose.yml` to
their retained evidence directory, generate `MATTERMOST_DB_PASSWORD` there,
start the project with Docker Compose, and record the exact image digest.

User-facing evaluation and production choices belong to Mattermost's official
[Quick Start Evaluation](https://docs.mattermost.com/deployment-guide/quick-start-evaluation)
and [server deployment guide](https://docs.mattermost.com/deployment-guide/server/deploy-server).
