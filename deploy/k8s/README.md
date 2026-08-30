# Stateless Host workload

`stage.sh` builds source-addressed Host and pod-local materializer images, imports
them into k3s, projects runtime configuration, and applies a zero-replica
Deployment on first use. `cutover.sh` stops the systemd writer before scaling
the Deployment to one. `rollback.sh` performs the reverse order.

Runtime contract:

- no `hostPath`, PVC, node selector, or path affinity;
- one `Recreate` replica;
- read-only application root;
- private memory `emptyDir` for process state and `/tmp`;
- projected runtime environment, database credentials, and deployment PKI;
- five Pod verbs in the agent namespace.
