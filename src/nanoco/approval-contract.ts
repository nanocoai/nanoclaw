export const APPROVAL_PROTOCOL_VERSION = 'nanoco.approval.v2' as const;

const IDENTIFIER_MAX_LENGTH = 256;
const APPROVER_ISSUER_MAX_LENGTH = 512;
const MAX_PRESENTATION_FIELDS = 24;
// Gateway projects at most 50 source values and appends one exact
// `… and N more` disclosure when the source list is longer. The disclosure is
// presentation evidence, not a 51st source value, and must survive rendering.
const MAX_PRESENTED_SOURCE_VALUES = 50;
const MAX_PRESENTED_FIELD_ITEMS = 51;
const LIST_MORE_DISCLOSURE = /^… and [1-9]\d* more$/;
const MAX_APPROVALS = 1024;
const UNICODE_CONTROL_CHARACTER = /\p{Cc}/u;
const HTTP_METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface GatewayApproval {
  approvalId: string;
  requestDigest: string;
  deadline: string;
  lineage: {
    requestId: number;
    deploymentId: string;
    agentId: string;
    sessionId: string;
    containerInstanceId: string;
    channelId: string;
  };
  approver: {
    issuer: string;
    subject: string;
  };
  policy: {
    policyVersion: string;
    matchedPolicyIds: string[];
  };
  summary: {
    method: string;
    origin: string;
    path: string;
  };
  presentation: {
    appId: string;
    appLabel: string;
    operationId: string;
    title: string;
    description?: string;
    class: string;
    fields: ApprovalPresentationField[];
  };
}

export type ApprovalPresentationField =
  | { label: string; kind: 'text'; value: string }
  | { label: string; kind: 'long_text'; value: string }
  | { label: string; kind: 'list'; value: string[] };

export interface ApprovalSnapshot {
  version: typeof APPROVAL_PROTOCOL_VERSION;
  gatewayEpoch: string;
  cursor: number;
  approvals: GatewayApproval[];
}

export type ApprovalTerminalState = 'approved' | 'rejected' | 'timed_out' | 'cancelled';

export type ApprovalEvent =
  | {
      version: typeof APPROVAL_PROTOCOL_VERSION;
      eventId: number;
      gatewayEpoch: string;
      type: 'approval_requested';
      approval: GatewayApproval;
    }
  | {
      version: typeof APPROVAL_PROTOCOL_VERSION;
      eventId: number;
      gatewayEpoch: string;
      type: 'approval_terminal';
      approval: GatewayApproval;
      state: ApprovalTerminalState;
    };

export type ApprovalDecision = 'approve' | 'reject' | 'unavailable';

export interface DecisionCommand {
  version: typeof APPROVAL_PROTOCOL_VERSION;
  gatewayEpoch: string;
  approvalId: string;
  requestDigest: string;
  lineage: GatewayApproval['lineage'];
  approver: GatewayApproval['approver'];
  decision: ApprovalDecision;
}

export interface DecisionAcknowledgement {
  version: typeof APPROVAL_PROTOCOL_VERSION;
  gatewayEpoch: string;
  approvalId: string;
  status: 'applied' | 'duplicate';
  state: ApprovalTerminalState;
}

export class ApprovalContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalContractError';
  }
}

export function parseApprovalSnapshot(value: unknown, deploymentId: string): ApprovalSnapshot {
  const object = exactObject(value, ['version', 'gatewayEpoch', 'cursor', 'approvals'], 'snapshot');
  requireVersion(object.version);
  const gatewayEpoch = parseGatewayEpoch(object.gatewayEpoch);
  const cursor = unsignedInteger(object.cursor, 'cursor');
  if (!Array.isArray(object.approvals) || object.approvals.length > MAX_APPROVALS) {
    throw new ApprovalContractError('snapshot approvals are invalid');
  }
  return {
    version: APPROVAL_PROTOCOL_VERSION,
    gatewayEpoch,
    cursor,
    approvals: object.approvals.map((approval) => parseApproval(approval, deploymentId)),
  };
}

export function parseApprovalEvent(value: unknown, deploymentId: string): ApprovalEvent {
  const base = exactObject(value, ['version', 'eventId', 'gatewayEpoch', 'type', 'approval'], 'approval event', [
    'state',
  ]);
  requireVersion(base.version);
  const eventId = unsignedInteger(base.eventId, 'eventId');
  const gatewayEpoch = parseGatewayEpoch(base.gatewayEpoch);
  const approval = parseApproval(base.approval, deploymentId);
  if (base.type === 'approval_requested') {
    if ('state' in base) throw new ApprovalContractError('approval requested event has terminal state');
    return { version: APPROVAL_PROTOCOL_VERSION, eventId, gatewayEpoch, type: base.type, approval };
  }
  if (base.type !== 'approval_terminal') throw new ApprovalContractError('approval event type is invalid');
  if (!isTerminalState(base.state)) throw new ApprovalContractError('approval terminal state is invalid');
  return {
    version: APPROVAL_PROTOCOL_VERSION,
    eventId,
    gatewayEpoch,
    type: base.type,
    approval,
    state: base.state,
  };
}

export function parseDecisionAcknowledgement(value: unknown): DecisionAcknowledgement {
  const object = exactObject(
    value,
    ['version', 'gatewayEpoch', 'approvalId', 'status', 'state'],
    'decision acknowledgement',
  );
  requireVersion(object.version);
  if (object.status !== 'applied' && object.status !== 'duplicate') {
    throw new ApprovalContractError('decision acknowledgement status is invalid');
  }
  if (!isTerminalState(object.state)) {
    throw new ApprovalContractError('decision acknowledgement state is invalid');
  }
  return {
    version: APPROVAL_PROTOCOL_VERSION,
    gatewayEpoch: parseGatewayEpoch(object.gatewayEpoch),
    approvalId: parseApprovalId(object.approvalId),
    status: object.status,
    state: object.state,
  };
}

export function isResyncRequired(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return object.version === APPROVAL_PROTOCOL_VERSION && object.error === 'resync_required';
}

function parseApproval(value: unknown, deploymentId: string): GatewayApproval {
  const object = exactObject(
    value,
    ['approvalId', 'requestDigest', 'deadline', 'lineage', 'approver', 'policy', 'summary', 'presentation'],
    'approval',
  );
  const lineage = exactObject(
    object.lineage,
    ['requestId', 'deploymentId', 'agentId', 'sessionId', 'containerInstanceId', 'channelId'],
    'lineage',
  );
  const actualDeploymentId = lineageIdentifier(lineage.deploymentId, 'deploymentId');
  if (actualDeploymentId !== deploymentId) throw new ApprovalContractError('approval belongs to another deployment');

  const approver = exactObject(object.approver, ['issuer', 'subject'], 'approver');
  const policy = exactObject(object.policy, ['policyVersion', 'matchedPolicyIds'], 'policy');
  if (!Array.isArray(policy.matchedPolicyIds) || policy.matchedPolicyIds.length > 128) {
    throw new ApprovalContractError('matched policy identifiers are invalid');
  }
  const summary = exactObject(object.summary, ['method', 'origin', 'path'], 'summary');
  const presentation = parseApprovalPresentation(object.presentation);
  const deadline = canonicalTimestamp(object.deadline, 'deadline');
  const requestDigest = stringValue(object.requestDigest, 'requestDigest', 64);
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) throw new ApprovalContractError('requestDigest is invalid');

  return {
    approvalId: parseApprovalId(object.approvalId),
    requestDigest,
    deadline,
    lineage: {
      requestId: unsignedInteger(lineage.requestId, 'requestId'),
      deploymentId: actualDeploymentId,
      agentId: lineageIdentifier(lineage.agentId, 'agentId'),
      sessionId: lineageIdentifier(lineage.sessionId, 'sessionId'),
      containerInstanceId: lineageIdentifier(lineage.containerInstanceId, 'containerInstanceId'),
      channelId: lineageIdentifier(lineage.channelId, 'channelId'),
    },
    approver: {
      issuer: approverIssuer(approver.issuer),
      subject: approverSubject(approver.subject),
    },
    policy: {
      policyVersion: identifier(policy.policyVersion, 'policyVersion'),
      matchedPolicyIds: policy.matchedPolicyIds.map((id) => identifier(id, 'matched policy identifier')),
    },
    summary: {
      method: summaryMethod(summary.method),
      origin: summaryOrigin(summary.origin),
      path: summaryPath(summary.path),
    },
    presentation,
  };
}

export function parseApprovalPresentation(value: unknown): GatewayApproval['presentation'] {
  const presentation = exactObject(
    value,
    ['appId', 'appLabel', 'operationId', 'title', 'class', 'fields'],
    'presentation',
    ['description'],
  );
  if (!Array.isArray(presentation.fields) || presentation.fields.length > MAX_PRESENTATION_FIELDS) {
    throw new ApprovalContractError('presentation fields are invalid');
  }
  return {
    appId: identifier(presentation.appId, 'presentation app id'),
    appLabel: displayText(presentation.appLabel, 'presentation app label', 256),
    operationId: identifier(presentation.operationId, 'presentation operation id'),
    title: displayText(presentation.title, 'presentation title', 256),
    // `description` is optional, and the Gateway's wire spells "none" as an
    // EXPLICIT null (Rust Option::None under plain serde). Observed live on
    // the first network-class Ask this adapter ever received — the frozen
    // fixtures are all operation-class and carry a string, so present-and-null
    // was unrepresented and the strict parse wedged the adapter in a
    // code="contract" retry loop against a healthy gateway (the §3.4
    // discriminator read a valid snapshot; the events stream carried
    // "description": null). Null is the same claim as absent; any OTHER
    // non-string value is still rejected below.
    ...(presentation.description === undefined || presentation.description === null
      ? {}
      : { description: displayText(presentation.description, 'presentation description', 2048) }),
    class: displayText(presentation.class, 'presentation class', 64),
    fields: presentation.fields.map((field, index) => parsePresentationField(field, index)),
  };
}

function parsePresentationField(value: unknown, index: number): ApprovalPresentationField {
  const field = exactObject(value, ['label', 'kind', 'value'], `presentation field ${index}`);
  const label = displayText(field.label, `presentation field ${index} label`, 80);
  if (field.kind === 'text') {
    return { label, kind: 'text', value: displayText(field.value, `presentation field ${index} value`, 8193) };
  }
  if (field.kind === 'long_text') {
    const text = stringValue(field.value, `presentation field ${index} value`, 16385);
    if (
      [...text].some(
        (character) => UNICODE_CONTROL_CHARACTER.test(character) && character !== '\n' && character !== '\t',
      )
    ) {
      throw new ApprovalContractError(`presentation field ${index} value is invalid`);
    }
    return { label, kind: 'long_text', value: text };
  }
  if (
    field.kind === 'list' &&
    Array.isArray(field.value) &&
    field.value.length <= MAX_PRESENTED_FIELD_ITEMS &&
    (field.value.length <= MAX_PRESENTED_SOURCE_VALUES ||
      (typeof field.value[MAX_PRESENTED_FIELD_ITEMS - 1] === 'string' &&
        LIST_MORE_DISCLOSURE.test(field.value[MAX_PRESENTED_FIELD_ITEMS - 1])))
  ) {
    return {
      label,
      kind: 'list',
      value: field.value.map((item, itemIndex) =>
        displayText(item, `presentation field ${index} item ${itemIndex}`, 2049),
      ),
    };
  }
  throw new ApprovalContractError(`presentation field ${index} kind is invalid`);
}

function displayText(value: unknown, name: string, maxLength: number): string {
  const text = stringValue(value, name, maxLength);
  if (UNICODE_CONTROL_CHARACTER.test(text)) throw new ApprovalContractError(`${name} is invalid`);
  return text;
}

function approverIssuer(value: unknown): string {
  const issuer = stringValue(value, 'approver issuer', APPROVER_ISSUER_MAX_LENGTH);
  if (!/^https:\/\/[\x21-\x7e]+$/.test(issuer)) {
    throw new ApprovalContractError('approver issuer is invalid');
  }
  return issuer;
}

function approverSubject(value: unknown): string {
  const subject = stringValue(value, 'approver subject', IDENTIFIER_MAX_LENGTH);
  if (UNICODE_CONTROL_CHARACTER.test(subject)) {
    throw new ApprovalContractError('approver subject is invalid');
  }
  return subject;
}

function parseApprovalId(value: unknown): string {
  if (typeof value !== 'string' || !/^ask_[0-9A-Fa-f]{32}$/.test(value)) {
    throw new ApprovalContractError('approvalId is invalid');
  }
  return value;
}

function parseGatewayEpoch(value: unknown): string {
  const epoch = stringValue(value, 'gatewayEpoch', 64);
  if (!/^[A-Za-z0-9_]+$/.test(epoch)) throw new ApprovalContractError('gatewayEpoch is invalid');
  return epoch;
}

function lineageIdentifier(value: unknown, name: string): string {
  const id = stringValue(value, name, 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new ApprovalContractError(`${name} is invalid`);
  return id;
}

function summaryMethod(value: unknown): string {
  const method = stringValue(value, 'summary method', 32);
  if (!HTTP_METHOD_TOKEN.test(method)) throw new ApprovalContractError('summary method is invalid');
  return method;
}

function summaryOrigin(value: unknown): string {
  const origin = stringValue(value, 'summary origin', 2048);
  if (hasAsciiControl(origin) || !/^https?:\/\/[\x21-\x7e]+$/i.test(origin)) {
    throw new ApprovalContractError('summary origin is invalid');
  }
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new ApprovalContractError('summary origin is invalid');
    }
  } catch (error) {
    if (error instanceof ApprovalContractError) throw error;
    throw new ApprovalContractError('summary origin is invalid');
  }
  return origin;
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function summaryPath(value: unknown): string {
  const path = stringValue(value, 'summary path', 4096);
  if (!/^[\x21-\x7e]+$/.test(path) || !path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new ApprovalContractError('summary path is invalid');
  }
  return path;
}

function exactObject(
  value: unknown,
  required: string[],
  name: string,
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApprovalContractError(`${name} is not an object`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(object).some((key) => !allowed.has(key)) || required.some((key) => !(key in object))) {
    throw new ApprovalContractError(`${name} fields are invalid`);
  }
  return object;
}

function requireVersion(value: unknown): void {
  if (value !== APPROVAL_PROTOCOL_VERSION) throw new ApprovalContractError('approval protocol version is unsupported');
}

function identifier(value: unknown, name: string): string {
  return stringValue(value, name, IDENTIFIER_MAX_LENGTH);
}

function stringValue(value: unknown, name: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || Buffer.byteLength(value) > maxLength) {
    throw new ApprovalContractError(`${name} is invalid`);
  }
  return value;
}

function unsignedInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ApprovalContractError(`${name} is invalid`);
  }
  return value as number;
}

function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new ApprovalContractError(`${name} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ApprovalContractError(`${name} is not canonical UTC`);
  }
  return value;
}

function isTerminalState(value: unknown): value is ApprovalTerminalState {
  return value === 'approved' || value === 'rejected' || value === 'timed_out' || value === 'cancelled';
}
