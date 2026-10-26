# Remove Kubernetes SessionDriver

Switch `NANOCLAW_RUNTIME_DRIVER` to another installed driver before removal.

Delete `import './kubernetes-driver.js';` from `src/drivers/installed.ts`, then delete the two destinations from the `nc:copy` block in [SKILL.md](SKILL.md). Remove the four `NANOCLAW_KUBERNETES_*` settings if no other tooling uses them. The skill does not own cluster RBAC, NetworkPolicies, PVCs, or workloads, so preserve those unless their owner explicitly removes them.
