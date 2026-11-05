import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Environment team definition. Every saved document is kept so work started on
  // a revision keeps reading that revision.
  yield* sql`
    CREATE TABLE IF NOT EXISTS garrs_config_revisions (
      revision INTEGER PRIMARY KEY,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS garrs_project_bindings (
      project_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Threads that run as a Garrs member: the user's Garras conversation, or one
  // attempt of a task. The runtime policy reads role and access from here.
  yield* sql`
    CREATE TABLE IF NOT EXISTS garrs_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      attempt_id TEXT,
      read_only INTEGER NOT NULL,
      instructions TEXT NOT NULL,
      config_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS garrs_threads_project
    ON garrs_threads (project_id, agent_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS garrs_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      garras_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS garrs_work_items_project
    ON garrs_work_items (project_id, updated_at)
  `;

  // Child records of a work item. Payloads hold the contract shape; the columns
  // exist for lookups that must not decode every row.
  for (const table of ["garrs_plans", "garrs_tasks", "garrs_artifacts", "garrs_reviews"]) {
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
    yield* sql.unsafe(`
      CREATE INDEX IF NOT EXISTS ${table}_work_item ON ${table} (work_item_id)
    `);
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS garrs_attempts (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      thread_id TEXT UNIQUE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS garrs_attempts_work_item ON garrs_attempts (work_item_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS garrs_attempts_status ON garrs_attempts (status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS garrs_messages (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS garrs_messages_work_item ON garrs_messages (work_item_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS garrs_activity (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS garrs_activity_work_item ON garrs_activity (work_item_id, sequence)
  `;

  // A command's result, so a retried command returns it instead of acting twice.
  yield* sql`
    CREATE TABLE IF NOT EXISTS garrs_receipts (
      command_key TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  // Side effects committed with the state that asked for them; the worker runs
  // pending rows after commit and again after a restart.
  yield* sql`
    CREATE TABLE IF NOT EXISTS garrs_outbox (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      tries INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS garrs_outbox_pending ON garrs_outbox (status, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS garrs_memory (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS garrs_memory_project ON garrs_memory (project_id, updated_at)
  `;
});
