# Get a Mattermost server

NanoClaw connects to a Mattermost server; it does not install, upgrade, back
up, secure, or remove the server itself. Use Mattermost's maintained guidance
to choose the installation that fits the operator's needs.

## Temporary evaluation

Use Mattermost's [Quick Start Evaluation](https://docs.mattermost.com/deployment-guide/quick-start-evaluation).
Its official Docker preview is the shortest path to a local trial and normally
listens at `http://localhost:8065`, which NanoClaw's discovery step probes.
Mattermost labels this path for testing and evaluation rather than production.

## Persistent or production deployment

Use Mattermost's [server deployment guide](https://docs.mattermost.com/deployment-guide/server/deploy-server)
to compare its supported Kubernetes, Linux, and container paths. Mattermost's
current guide reserves container deployments for evaluation, testing, and
development; choose the Linux or Kubernetes guidance for a production server
according to the required scale and availability.

## Return to NanoClaw

Finish the Mattermost initialization, including the first administrator and
team. Confirm that the server is reachable from the NanoClaw host, then return
to `/add-mattermost` with its canonical base URL. The skill verifies the URL,
guides SiteURL configuration, and walks through bot account creation.
