# Away Mode Audit Trail

One JSON file per consequential Away Mode action — `<eventId>.json`, written once, `chmod 444` immediately after writing. Not agent-editable by convention or by permission: nothing in this codebase gives Claude a tool to rewrite a file it doesn't own after making it read-only, mirroring the technique already used this project for the 4 read-only reference lease PDFs.

Each event file records: `task_id` (the `away_mode_queue.id` this belongs to, if any), `original_goal`, `authority_level`, `important_files_changed`, `tests_performed`, `deployment_performed` (if any), `approval_received` (if required — reference the real `pending_approvals` row, never a self-asserted claim), `timestamp`, `rollback_point` (if applicable).

This directory is gitignored except this README — audit events are per-installation runtime state, same as `groups/`.
