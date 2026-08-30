ARG HOST_IMAGE
FROM ${HOST_IMAGE}
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/nanoclaw/dist/stateless-k8s/materializer.js"]
