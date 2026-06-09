## ADDED Requirements

### Requirement: Per-group Mac voice toggle

The system SHALL allow each registered group to independently enable or disable Mac local voice announcements. The default SHALL be disabled for groups unless explicitly enabled.

#### Scenario: Group enables Mac voice

- **WHEN** a user enables Mac voice for the current group
- **THEN** the group's persisted container configuration records Mac voice as enabled

#### Scenario: Group disables Mac voice

- **WHEN** a user disables Mac voice for the current group
- **THEN** future final replies in that group do not trigger Mac local voice announcements

#### Scenario: Unconfigured group

- **WHEN** a group has no Mac voice configuration
- **THEN** final replies in that group do not trigger Mac local voice announcements

### Requirement: Final-result-only announcements

The system SHALL trigger Mac local voice announcements only for final user-visible replies, not for tool calls, tool results, progress text, media placeholders, or very short system messages.

#### Scenario: Final reply arrives

- **WHEN** a final text reply is sent to a group with Mac voice enabled
- **THEN** the system schedules one Mac voice announcement for the summarized result

#### Scenario: Tool progress arrives

- **WHEN** a tool call or tool result progress event is shown
- **THEN** the system does not schedule a Mac voice announcement

#### Scenario: Media-only reply arrives

- **WHEN** the remaining text after stripping media markers is empty or too short
- **THEN** the system does not schedule a Mac voice announcement

### Requirement: Alias-prefixed speech

The system SHALL prefix Mac voice announcements with a stable group label. The label priority SHALL be configured alias, then registered group name, then shortened chat JID.

#### Scenario: Alias exists

- **WHEN** a group has an alias in the alias table
- **THEN** the spoken text starts with that alias followed by the summarized result

#### Scenario: Alias missing

- **WHEN** a group has no alias but has a registered group name
- **THEN** the spoken text starts with the group name followed by the summarized result

#### Scenario: Alias and name missing

- **WHEN** neither alias nor group name is available
- **THEN** the spoken text starts with a shortened chat JID followed by the summarized result

### Requirement: Serial Mac playback

The system SHALL play Mac local voice announcements serially so multiple group results do not overlap.

#### Scenario: Multiple announcements queued

- **WHEN** two or more announcements are scheduled close together
- **THEN** the system plays them one after another

#### Scenario: Mac TTS command fails

- **WHEN** the local TTS process exits with an error
- **THEN** the system logs a warning and continues processing later queued announcements

### Requirement: Existing Pushover compatibility

The system SHALL preserve the existing main-group Pushover notification behavior unless separately configured otherwise.

#### Scenario: Main group final reply

- **WHEN** the main group receives a final reply
- **THEN** the existing Pushover notification path remains available

#### Scenario: Non-main group enables Mac voice

- **WHEN** a non-main group enables Mac voice
- **THEN** the system uses Mac local speech without requiring Pushover credentials
