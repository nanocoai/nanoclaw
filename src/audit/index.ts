/**
 * Opt-in local audit log — installed by add-audit-log.
 *
 * This directory is a domain-free leaf: the event schema, the emit seam, the
 * store, the reader, post-write hooks, and shared vocabulary. What gets
 * audited — and how each domain describes itself — lives in the domain-owned
 * `*.audit.ts` adapter files next to the code they observe. Business logic
 * contains zero audit calls.
 *
 * emitAuditEvent is deliberately NOT re-exported here: adapters import it
 * from './emit.js' directly, and only src/audit/ + `*.audit.ts` may call it.
 */
export * from './types.js';
export { AUDIT_ENABLED, AUDIT_HOST_ID, AUDIT_RETENTION_HOURS } from './config.js';
export { initAuditLog, maintainAudit } from './init.js';
export { type AuditHook, registerAuditHook } from './hooks.js';
