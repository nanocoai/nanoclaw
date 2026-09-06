/** Opt-in storage for mailbox consumer tests. Backend composition replaces
 * this test-only module alongside its real registration; autoload tests do
 * not use it. Tests inspecting SQLite files use sqlite/test-fixture directly. */
export { useSqliteMailboxFixture as useComposedMailboxFixture } from './sqlite/test-fixture.js';
