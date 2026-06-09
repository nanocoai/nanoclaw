## ADDED Requirements

### Requirement: Per-group Pushover voice toggle

The system SHALL allow each registered group to independently enable or disable Pushover voice notifications. The default SHALL be disabled for groups unless explicitly enabled, including the main group.

#### Scenario: Group enables voice push

- **WHEN** a user enables voice notification for the current group
- **THEN** the group's persisted container configuration records Pushover voice as enabled

#### Scenario: Group disables voice push

- **WHEN** a user disables voice notification for the current group
- **THEN** future final replies in that group do not trigger Pushover voice notifications

#### Scenario: Unconfigured group

- **WHEN** a group has no voice notification configuration
- **THEN** final replies in that group do not trigger Pushover voice notifications

#### Scenario: Main group is unconfigured

- **WHEN** the main group has no voice notification configuration
- **THEN** final replies in the main group do not trigger Pushover voice notifications

### Requirement: Final-result-only announcements

The system SHALL trigger Pushover voice notifications only for final user-visible replies, not for tool calls, tool results, progress text, media placeholders, or very short system messages.

#### Scenario: Final reply arrives

- **WHEN** a final text reply is sent to a group with voice notification enabled
- **THEN** the system sends one Pushover voice notification for the summarized result

#### Scenario: Tool progress arrives

- **WHEN** a tool call or tool result progress event is shown
- **THEN** the system does not send a Pushover voice notification

#### Scenario: Media-only reply arrives

- **WHEN** the remaining text after stripping media markers is empty or too short
- **THEN** the system does not send a Pushover voice notification

### Requirement: Alias-prefixed speech

The system SHALL prefix Pushover voice notification text with a stable group label. The label priority SHALL be configured alias, then registered group name, then shortened chat JID.

#### Scenario: Alias exists

- **WHEN** a group has an alias in the alias table
- **THEN** the spoken text starts with that alias followed by the summarized result

#### Scenario: Alias missing

- **WHEN** a group has no alias but has a registered group name
- **THEN** the spoken text starts with the group name followed by the summarized result

#### Scenario: Alias and name missing

- **WHEN** neither alias nor group name is available
- **THEN** the spoken text starts with a shortened chat JID followed by the summarized result

### Requirement: Pushover delivery safety

The system SHALL keep Pushover delivery fire-and-forget, bounded, and non-blocking for the Feishu reply path.

#### Scenario: Pushover credentials are missing

- **WHEN** voice notification is enabled but Pushover credentials are missing
- **THEN** the system logs a warning and still sends the Feishu reply

#### Scenario: Pushover delivery fails

- **WHEN** Pushover returns an error or times out
- **THEN** the system logs a warning and does not fail the Feishu reply

### Requirement: Legacy config compatibility

The system SHALL treat the early `voiceNotify.mac` flag as enabled voice push during runtime, and SHALL write `voiceNotify.push` for new command changes.

#### Scenario: Existing mac flag is true

- **WHEN** a group has `voiceNotify.mac` set to true from the earlier implementation
- **THEN** final replies in that group still trigger Pushover voice notifications

#### Scenario: User changes voice setting

- **WHEN** a user runs `/voice on` or `/voice off`
- **THEN** the system writes `voiceNotify.push` and removes the legacy `voiceNotify.mac` flag
