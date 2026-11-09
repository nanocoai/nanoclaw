# OneCLI approval compatibility

OneCLI's pinned local gateway is the reference for approval summaries. The Iron adapter’s NanoClaw front runs
that same implementation inside its proxy boundary. NanoClaw does not maintain
an app rule catalog or a second Gmail/MIME parser.

`upstream.json` pins the Apache-2.0 OneCLI source by commit and file checksum.
`prepare.py` downloads the unchanged summary modules and selects the unchanged
pure provider-registry declarations and lookup functions from `apps.rs`; OAuth,
credential injection and network code are excluded. The empty extension registry
matches OneCLI's local OSS edition. `main.rs` supplies only stdin/stdout transport.

The helper receives method, host, path, content type and a 16 KiB body prefix,
matching OneCLI's approval peek limit. It emits OneCLI's structured summary;
headers, credentials and raw bodies never enter NanoClaw. The proxy restores the
prefix before forwarding. Errors fail closed. OneCLI itself continues using its
native summary, and both adapters use `normalizeGatewayApprovalSummary` and the
same renderer. Application coverage and fallback behavior must match OneCLI.

Build with `cargo test --locked` and `cargo build --release --locked` after
`python3 prepare.py`. The managed Iron image performs these checks automatically.
A change to the OneCLI gateway version must update this source pin and lockfile;
the Iron builder rejects a mismatched version. Upstream tests run unchanged.
