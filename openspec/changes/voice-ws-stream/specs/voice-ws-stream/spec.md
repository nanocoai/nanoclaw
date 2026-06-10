## ADDED Requirements

### Requirement: Token-gated WebSocket voice stream

The system SHALL run an embedded WebSocket server for voice broadcast only when a `VOICE_WS_TOKEN` is configured. Connections presenting a wrong or missing token SHALL be rejected immediately.

#### Scenario: Token not configured

- **WHEN** the main process starts without `VOICE_WS_TOKEN` configured
- **THEN** the WebSocket voice server does not start and a warning is logged

#### Scenario: Client connects with valid token

- **WHEN** a client connects with the correct token in the URL query
- **THEN** the connection is accepted and kept alive via heartbeat

#### Scenario: Client connects with invalid token

- **WHEN** a client connects with a missing or wrong token
- **THEN** the connection is closed immediately with a policy violation code

### Requirement: Voice summary broadcast

The system SHALL broadcast each voice summary as a JSON message to all connected WebSocket clients for groups that have voice notification enabled, in parallel with the existing Pushover push.

#### Scenario: Voice-enabled group produces final reply

- **WHEN** a final reply is summarized for a group with voice notification enabled
- **THEN** all connected clients receive one JSON message containing the group label, spoken text, and timestamp

#### Scenario: No connected clients

- **WHEN** a voice summary is produced while no clients are connected
- **THEN** the broadcast is skipped silently and the Pushover push still proceeds

#### Scenario: Voice-disabled group produces final reply

- **WHEN** a final reply is produced for a group without voice notification enabled
- **THEN** no WebSocket message is broadcast

### Requirement: Failure isolation

The system SHALL ensure WebSocket server errors and broadcast failures never affect message delivery on the primary channel.

#### Scenario: Broadcast send fails

- **WHEN** sending to a client fails or the server errors
- **THEN** the error is logged as a warning and the primary message flow is unaffected
