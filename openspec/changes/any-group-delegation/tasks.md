## 1. Schema and Types

- [ ] 1.1 Add `source_group` and `source_jid` columns to `delegation_tasks` with migration backfill from the unique main group.
- [ ] 1.2 Update `DelegationTask`, `DelegationRow`, and row mapping to include source fields.
- [ ] 1.3 Update `createDelegation()` to require source and target fields.
- [ ] 1.4 Add DB tests for migration, row mapping, and active target slot uniqueness.

## 2. Host IPC Delegation

- [ ] 2.1 Update `handleDelegate()` to allow registered non-main sources and reject unregistered source/target/self-delegation.
- [ ] 2.2 Preserve target-group active slot checks, including retry self-task exemption and rejection when another task occupies the target.
- [ ] 2.3 Ensure target send failure and target DB store failure release the just-created task slot and notify source_jid.
- [ ] 2.4 Update delegated message sender labels to include source group.
- [ ] 2.5 Add IPC tests for main→subgroup, subgroup→subgroup, invalid target, self-delegation, target busy, send failure rollback, and store failure rollback.

## 3. Report Routing

- [ ] 3.1 Rename/report-path variables so IPC current group is `reportingGroup` or `ipcSourceGroup`, then resolve task by `target_group = reportingGroup` and route reports to `task.source_jid`.
- [ ] 3.2 Add `report_to_source` MCP tool and keep `report_to_main` as compatibility alias.
- [ ] 3.3 Update automatic terminal report routing to `task.source_jid`.
- [ ] 3.4 Add tests for explicit report, compatibility old tool name, no active task rejection, and auto terminal report.

## 4. Delegate Commands

- [ ] 4.1 Remove `requiresMain` from `/delegate` and implement source-based authorization inside the handler.
- [ ] 4.2 Update `/delegate status` to filter ordinary groups by source and allow main global view.
- [ ] 4.3 Update reply/retry/close to allow only task source group or main group.
- [ ] 4.4 Update command tests for ordinary group ownership, main override, and unauthorized access.

## 5. Tool Descriptions and Compatibility

- [ ] 5.1 Update MCP descriptions for `delegate`, `report_to_source`, and `report_to_main`.
- [ ] 5.2 Verify prompt wording no longer says only main can delegate.
- [ ] 5.3 Keep cross-group `send_message` blocked for task workflows.

## 6. Verification

- [ ] 6.1 Run focused tests: delegation, delegate command, IPC commander paths.
- [ ] 6.2 Run `npm run build`.
- [ ] 6.3 Run a dry E2E with source group A delegating to target group B and report returning to A.
- [ ] 6.4 Run a dry E2E with a non-main group delegating to main, and verify main self-delegation is rejected.
- [ ] 6.5 Verify existing main group delegation still works unchanged.
