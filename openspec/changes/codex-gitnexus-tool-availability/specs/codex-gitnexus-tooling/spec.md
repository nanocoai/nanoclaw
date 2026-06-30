## ADDED Requirements

### Requirement: Codex exposes GitNexus MCP tools
NanoClaw SHALL inject the GitNexus MCP server into Codex mode through the per-group Codex configuration it generates at runtime.

#### Scenario: Codex config includes GitNexus
- **WHEN** NanoClaw prepares `CODEX_HOME/config.toml` for a Codex-mode turn
- **THEN** the generated config SHALL include both the `nanoclaw` MCP server and the `gitnexus` MCP server
- **AND** the GitNexus server SHALL be injected by NanoClaw's explicit whitelist rather than by merging arbitrary global Codex configuration

#### Scenario: Manual config changes are not required
- **WHEN** a user starts a new Codex turn in any group
- **THEN** the GitNexus MCP configuration SHALL be generated automatically
- **AND** a manually edited `.codex-home/config.toml` SHALL NOT be required to make `gitnexus_*` tools available

### Requirement: GitNexus secrets stay out of source, logs, and generated Codex config
NanoClaw SHALL load GitNexus environment values at MCP process runtime and SHALL NOT hardcode or persist embedding API keys in source-controlled files, logs, snapshots, or generated per-group Codex configuration.

#### Scenario: API key is sourced from runtime configuration
- **WHEN** NanoClaw builds the GitNexus MCP configuration
- **THEN** the embedding API key SHALL be read from runtime configuration
- **AND** the literal secret value SHALL NOT appear in `codex-runner.ts`, tests, OpenSpec files, generated snapshots, normal logs, or generated `CODEX_HOME/config.toml`

#### Scenario: Generated config does not persist GitNexus secrets
- **WHEN** NanoClaw writes per-group `CODEX_HOME/config.toml`
- **THEN** the GitNexus MCP entry SHALL NOT contain a literal embedding API key
- **AND** the MCP process SHALL receive GitNexus secrets by loading runtime environment outside the generated TOML when that environment is present
- **AND** the MCP process SHALL still start without embedding env so already-indexed repository operations can run

#### Scenario: GitNexus env is missing
- **WHEN** the `gitnexus` command is available but embedding env values are unavailable
- **THEN** NanoClaw SHALL still inject the GitNexus MCP server for already-indexed repository query/context/impact operations
- **AND** embedding-backed index creation SHALL fail visibly only when that operation is requested

#### Scenario: GitNexus command is missing
- **WHEN** the `gitnexus` command is unavailable
- **THEN** Codex startup SHALL still work with the `nanoclaw` MCP server
- **AND** the missing GitNexus command SHALL be visible in diagnostics without exposing secrets

### Requirement: Unindexed repositories fail visibly
The code-graph skill SHALL NOT silently run embedding index builds for unindexed repositories.

#### Scenario: Repository is not indexed
- **WHEN** an agent needs GitNexus for a repository that is absent from `gitnexus list`
- **THEN** the skill SHALL report that the repository is not indexed
- **AND** it SHALL ask for explicit user confirmation before running an embedding index build
- **AND** it SHALL provide a fast static-analysis option that does not require embeddings

#### Scenario: Index build exceeds timeout
- **WHEN** an index build is executed from the skill and exceeds the configured timeout
- **THEN** the command SHALL be stopped
- **AND** the user SHALL see a clear timeout message and the exact manual command to continue
- **AND** the agent SHALL NOT present the fallback `rg`/`git diff` analysis as if GitNexus had succeeded

### Requirement: Existing CLI fallback remains available
The system SHALL preserve a CLI fallback path for environments where the GitNexus MCP server is unavailable.

#### Scenario: GitNexus MCP is unavailable but CLI works
- **WHEN** `gitnexus_*` MCP tools are not available and the local `gitnexus` CLI exists
- **THEN** the agent SHALL source `~/.gitnexus/env` only when it exists and then use `gitnexus <command>` for already-indexed repositories
- **AND** it SHALL state clearly when it used CLI rather than MCP

### Requirement: Verification proves real user-visible behavior
The E2E verification SHALL prove that the fix changes actual Codex behavior, not only unit-level config serialization.

#### Scenario: Codex sees GitNexus tools
- **WHEN** a real Codex-mode NanoClaw turn asks the agent to list or use code-graph capabilities
- **THEN** evidence SHALL include at least one successful GitNexus MCP tool invocation from inside that Codex turn
- **AND** the evidence SHALL distinguish MCP usage from CLI fallback, `rg`, or `git diff`
- **AND** generated config or stderr output MAY be used only as supporting evidence, not as the sole pass condition

#### Scenario: Unindexed repository no longer silently blocks
- **WHEN** a real or scripted flow targets an unindexed repository
- **THEN** the user-visible output SHALL explain that the repository is not indexed
- **AND** it SHALL NOT silently run `gitnexus analyze --embeddings` for several minutes before falling back
