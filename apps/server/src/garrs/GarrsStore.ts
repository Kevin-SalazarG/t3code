import {
  GarrsActivity,
  GarrsAgentId,
  GarrsArtifact,
  GarrsAttempt,
  GarrsAttemptId,
  GarrsBootstrapDecision,
  GarrsMemoryEntry,
  type GarrsMemoryId,
  GarrsMessage,
  GarrsPlanRevision,
  GarrsProjectBinding,
  type GarrsProjectBindingSnapshot,
  GarrsReview,
  GarrsTask,
  GarrsTaskId,
  GarrsTeamConfig,
  type GarrsConfigSnapshot,
  GarrsWorkItem,
  GarrsWorkItemId,
  OrchestrationV2RunJson,
  OrchestrationV2ProviderTurnJson,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  type ActivityDraft,
  type GarrsEffect,
  type WorkAggregate,
  defaultProjectBinding,
  defaultTeamConfig,
  normalizeTeamConfig,
} from "./GarrsDomain.ts";
import type { ConversationCandidate, ConversationTurn } from "./GarrsConversationUsage.ts";

export class GarrsStoreError extends Schema.TaggedError<GarrsStoreError>()("GarrsStoreError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Garrs storage failed during ${this.operation}.`;
  }
}

export class GarrsRevisionConflict extends Schema.TaggedError<GarrsRevisionConflict>()(
  "GarrsRevisionConflict",
  { expected: Schema.Number, actual: Schema.Number },
) {
  override get message(): string {
    return `Settings changed elsewhere (revision ${this.actual}, expected ${this.expected}). Reload and try again.`;
  }
}

export interface GarrsThreadRecord {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly agentId: GarrsAgentId;
  readonly attemptId: GarrsAttemptId | null;
  readonly readOnly: boolean;
  readonly instructions: string;
  readonly configRevision: number;
}

const GarrsEffectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("prepare_commit"), taskId: GarrsTaskId }),
  Schema.Struct({ kind: Schema.Literal("execute_push"), proposalId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("execute_commit"), proposalId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("launch_attempt"), attemptId: GarrsAttemptId }),
  Schema.Struct({ kind: Schema.Literal("stop_attempt"), attemptId: GarrsAttemptId }),
  Schema.Struct({
    kind: Schema.Literal("resume_attempt"),
    attemptId: GarrsAttemptId,
    text: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("notify_garras"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("deliver_helper_result"), taskId: GarrsTaskId }),
  Schema.Struct({
    kind: Schema.Literal("deliver_message"),
    messageId: GarrsMessage.fields.id,
    attemptId: Schema.NullOr(GarrsAttemptId),
  }),
]);

const ActivityRow = Schema.Struct({
  workItemId: GarrsWorkItemId,
  type: Schema.String,
  summary: Schema.String,
  agentId: Schema.NullOr(GarrsAgentId),
  taskId: GarrsActivity.fields.taskId,
  attemptId: GarrsActivity.fields.attemptId,
  createdAt: Schema.String,
});

export interface OutboxRow {
  readonly id: string;
  readonly workItemId: GarrsWorkItemId;
  readonly effect: GarrsEffect;
  readonly tries: number;
}

export interface CommitInput {
  readonly previous: WorkAggregate | null;
  readonly next: WorkAggregate;
  readonly activity: ReadonlyArray<ActivityDraft>;
  readonly effects: ReadonlyArray<{ readonly id: string; readonly effect: GarrsEffect }>;
  readonly receipt?: { readonly key: string; readonly json: string } | undefined;
  readonly now: string;
}

/** Encode and decode a contract type as stored JSON text. */
const codec = <A, I>(schema: Schema.Codec<A, I>, operation: string) => {
  const json = Schema.fromJsonString(schema);
  const encode = Schema.encodeEffect(json);
  const decode = Schema.decodeUnknownEffect(json);
  return {
    encode: (value: A) =>
      encode(value).pipe(
        Effect.mapError(
          (cause) => new GarrsStoreError({ operation: `encode ${operation}`, cause }),
        ),
      ),
    decode: (text: string) =>
      decode(text).pipe(
        Effect.mapError(
          (cause) => new GarrsStoreError({ operation: `decode ${operation}`, cause }),
        ),
      ),
  };
};

const workItemJson = codec(GarrsWorkItem, "work item");
const planJson = codec(GarrsPlanRevision, "plan");
const taskJson = codec(GarrsTask, "task");
const attemptJson = codec(GarrsAttempt, "attempt");
const artifactJson = codec(GarrsArtifact, "artifact");
const reviewJson = codec(GarrsReview, "review");
const messageJson = codec(GarrsMessage, "message");
const memoryJson = codec(GarrsMemoryEntry, "memory");
const teamConfigJson = codec(GarrsTeamConfig, "config");
const bindingJson = codec(GarrsProjectBinding, "binding");
const effectJson = codec(GarrsEffectSchema, "effect");
const activityJson = codec(ActivityRow, "activity");
const conversationRunJson = codec(OrchestrationV2RunJson, "conversation run");
const conversationTurnJson = codec(OrchestrationV2ProviderTurnJson, "conversation turn");
const bootstrapDecisionJson = codec(GarrsBootstrapDecision, "bootstrap decision");
const bootstrapPrefix = (threadId: ThreadId) => `garrs:bootstrap:${encodeURIComponent(threadId)}:`;
const encodeStringArrayJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const isGarrsStoreError = Schema.is(GarrsStoreError);

/** Encoded rows of `next` whose JSON differs from `previous`. */
const changedRows = Effect.fn("GarrsStore.changedRows")(function* <
  A extends { readonly id: string },
>(
  json: ReturnType<typeof codec<A, unknown>>,
  previous: ReadonlyArray<A> | undefined,
  next: ReadonlyArray<A>,
) {
  const before = new Map<string, string>();
  for (const entry of previous ?? []) before.set(entry.id, yield* json.encode(entry));
  const rows: Array<{ readonly entry: A; readonly payload: string }> = [];
  for (const entry of next) {
    const payload = yield* json.encode(entry);
    if (before.get(entry.id) !== payload) rows.push({ entry, payload });
  }
  return rows;
});

export class GarrsStore extends Context.Service<
  GarrsStore,
  {
    readonly getConfig: () => Effect.Effect<GarrsConfigSnapshot, GarrsStoreError>;
    readonly getConfigRevision: (
      revision: number,
    ) => Effect.Effect<GarrsTeamConfig, GarrsStoreError>;
    readonly saveConfig: (
      expectedRevision: number,
      config: GarrsTeamConfig,
      now: string,
    ) => Effect.Effect<GarrsConfigSnapshot, GarrsStoreError | GarrsRevisionConflict>;
    readonly getBinding: (
      projectId: ProjectId,
    ) => Effect.Effect<GarrsProjectBindingSnapshot, GarrsStoreError>;
    readonly saveBinding: (
      expectedRevision: number,
      binding: GarrsProjectBinding,
      now: string,
    ) => Effect.Effect<GarrsProjectBindingSnapshot, GarrsStoreError | GarrsRevisionConflict>;
    readonly registerThread: (
      record: GarrsThreadRecord,
      now: string,
      receipt?: { readonly key: string; readonly json: string },
    ) => Effect.Effect<void, GarrsStoreError>;
    readonly getThread: (
      threadId: ThreadId,
    ) => Effect.Effect<GarrsThreadRecord | null, GarrsStoreError>;
    readonly listGarrasThreads: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ThreadId>, GarrsStoreError>;
    readonly listFailedGarrasThreads: () => Effect.Effect<ReadonlyArray<ThreadId>, GarrsStoreError>;
    readonly listBootstrapDecisions: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<GarrsBootstrapDecision>, GarrsStoreError>;
    readonly saveBootstrapDecision: (
      threadId: ThreadId,
      decision: GarrsBootstrapDecision,
    ) => Effect.Effect<void, GarrsStoreError>;
    readonly loadAggregate: (
      workItemId: GarrsWorkItemId,
    ) => Effect.Effect<WorkAggregate | null, GarrsStoreError>;
    readonly listWorkItems: (
      projectId: ProjectId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<GarrsWorkItem>, GarrsStoreError>;
    readonly listTaskCounts: (workItemIds: ReadonlyArray<GarrsWorkItemId>) => Effect.Effect<
      ReadonlyArray<{
        readonly workItemId: GarrsWorkItemId;
        readonly taskCount: number;
        readonly completedTaskCount: number;
      }>,
      GarrsStoreError
    >;
    readonly listOpenWorkItemIds: () => Effect.Effect<
      ReadonlyArray<GarrsWorkItemId>,
      GarrsStoreError
    >;
    readonly listHelperWorkItemIds: () => Effect.Effect<
      ReadonlyArray<GarrsWorkItemId>,
      GarrsStoreError
    >;
    readonly listActiveAttempts: () => Effect.Effect<ReadonlyArray<GarrsAttempt>, GarrsStoreError>;
    readonly listModelFailures: () => Effect.Effect<ReadonlyArray<GarrsAttempt>, GarrsStoreError>;
    readonly findAttemptByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<GarrsAttempt | null, GarrsStoreError>;
    readonly findAttemptById: (
      attemptId: GarrsAttemptId,
    ) => Effect.Effect<GarrsAttempt | null, GarrsStoreError>;
    readonly listActivity: (
      workItemId: GarrsWorkItemId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<GarrsActivity>, GarrsStoreError>;
    /** The stored JSON result of an accepted command, or null. */
    readonly getReceipt: (key: string) => Effect.Effect<string | null, GarrsStoreError>;
    readonly putReceipt: (
      key: string,
      json: string,
      now: string,
    ) => Effect.Effect<void, GarrsStoreError>;
    readonly commit: (input: CommitInput) => Effect.Effect<void, GarrsStoreError>;
    readonly listPendingEffects: () => Effect.Effect<ReadonlyArray<OutboxRow>, GarrsStoreError>;
    readonly finishEffect: (input: {
      readonly id: string;
      readonly status: "done" | "failed" | "pending";
      readonly error: string | null;
      readonly now: string;
    }) => Effect.Effect<void, GarrsStoreError>;
    readonly countEffects: (
      attemptId: GarrsAttemptId,
      kind: GarrsEffect["kind"],
    ) => Effect.Effect<number, GarrsStoreError>;
    readonly listMemory: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<GarrsMemoryEntry>, GarrsStoreError>;
    readonly putMemory: (entry: GarrsMemoryEntry) => Effect.Effect<void, GarrsStoreError>;
    readonly deleteMemory: (
      id: GarrsMemoryId,
      projectId: ProjectId,
    ) => Effect.Effect<boolean, GarrsStoreError>;
    readonly listUsageAttempts: (input: {
      readonly projectId: ProjectId | undefined;
      readonly agentId: GarrsAttempt["agentId"] | undefined;
      readonly providerInstanceId: GarrsAttempt["decision"]["requested"]["instanceId"] | undefined;
      readonly model: string | undefined;
      readonly since: string | undefined;
      readonly until: string | undefined;
      readonly limit: number;
    }) => Effect.Effect<
      ReadonlyArray<{
        readonly attempt: GarrsAttempt;
        readonly workItem: GarrsWorkItem;
        readonly task: GarrsTask | null;
      }>,
      GarrsStoreError
    >;
    readonly listConversationUsage: (input: {
      readonly projectId: ProjectId | undefined;
      readonly agentId: GarrsAttempt["agentId"] | undefined;
      readonly providerInstanceId: GarrsAttempt["decision"]["requested"]["instanceId"] | undefined;
      readonly model: string | undefined;
      readonly since: string | undefined;
      readonly until: string | undefined;
      readonly limit: number;
    }) => Effect.Effect<
      {
        readonly candidates: ReadonlyArray<ConversationCandidate>;
        readonly turns: ReadonlyArray<ConversationTurn>;
        readonly turnsTruncated: boolean;
      },
      GarrsStoreError
    >;
  }
>()("t3/garrs/GarrsStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (operation: string) => (cause: unknown) => new GarrsStoreError({ operation, cause });

  const getConfig = Effect.fn("GarrsStore.getConfig")(function* () {
    const rows = yield* sql<{ revision: number; document_json: string; created_at: string }>`
      SELECT revision, document_json, created_at FROM garrs_config_revisions
      ORDER BY revision DESC LIMIT 1
    `.pipe(Effect.mapError(fail("read config")));
    const row = rows[0];
    if (row === undefined) return { revision: 0, config: defaultTeamConfig(), updatedAt: null };
    const config = normalizeTeamConfig(yield* teamConfigJson.decode(row.document_json));
    return { revision: row.revision, config, updatedAt: row.created_at };
  });

  const getConfigRevision = Effect.fn("GarrsStore.getConfigRevision")(function* (revision: number) {
    if (revision === 0) return defaultTeamConfig();
    const rows = yield* sql<{ document_json: string }>`
      SELECT document_json FROM garrs_config_revisions WHERE revision = ${revision}
    `.pipe(Effect.mapError(fail("read config revision")));
    const row = rows[0];
    if (row === undefined) return defaultTeamConfig();
    return normalizeTeamConfig(yield* teamConfigJson.decode(row.document_json));
  });

  const saveConfig = Effect.fn("GarrsStore.saveConfig")(function* (
    expectedRevision: number,
    config: GarrsTeamConfig,
    now: string,
  ) {
    const normalized = normalizeTeamConfig(config);
    const document = yield* teamConfigJson.encode(normalized);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* getConfig();
          if (current.revision !== expectedRevision) {
            return yield* new GarrsRevisionConflict({
              expected: expectedRevision,
              actual: current.revision,
            });
          }
          const revision = current.revision + 1;
          yield* sql`
            INSERT INTO garrs_config_revisions (revision, document_json, created_at)
            VALUES (${revision}, ${document}, ${now})
          `;
          return { revision, config: normalized, updatedAt: now };
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(fail("save config")(cause)) }));
  });

  const getBinding = Effect.fn("GarrsStore.getBinding")(function* (projectId: ProjectId) {
    const rows = yield* sql<{ revision: number; document_json: string; updated_at: string }>`
      SELECT revision, document_json, updated_at FROM garrs_project_bindings
      WHERE project_id = ${projectId}
    `.pipe(Effect.mapError(fail("read binding")));
    const row = rows[0];
    if (row === undefined) {
      return { revision: 0, binding: defaultProjectBinding(projectId), updatedAt: null };
    }
    const binding = yield* bindingJson.decode(row.document_json);
    return { revision: row.revision, binding, updatedAt: row.updated_at };
  });

  const saveBinding = Effect.fn("GarrsStore.saveBinding")(function* (
    expectedRevision: number,
    binding: GarrsProjectBinding,
    now: string,
  ) {
    const document = yield* bindingJson.encode(binding);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* getBinding(binding.projectId);
          if (current.revision !== expectedRevision) {
            return yield* new GarrsRevisionConflict({
              expected: expectedRevision,
              actual: current.revision,
            });
          }
          const revision = current.revision + 1;
          yield* sql`
            INSERT INTO garrs_project_bindings (project_id, revision, document_json, updated_at)
            VALUES (${binding.projectId}, ${revision}, ${document}, ${now})
            ON CONFLICT (project_id) DO UPDATE SET
              revision = excluded.revision,
              document_json = excluded.document_json,
              updated_at = excluded.updated_at
          `;
          return { revision, binding, updatedAt: now };
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(fail("save binding")(cause)) }));
  });

  const registerThread = Effect.fn("GarrsStore.registerThread")(function* (
    record: GarrsThreadRecord,
    now: string,
    receipt?: { readonly key: string; readonly json: string },
  ) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
      INSERT INTO garrs_threads (
        thread_id, project_id, agent_id, attempt_id, read_only, instructions, config_revision, created_at
      ) VALUES (
        ${record.threadId}, ${record.projectId}, ${record.agentId}, ${record.attemptId},
        ${record.readOnly ? 1 : 0}, ${record.instructions}, ${record.configRevision}, ${now}
      )
      ON CONFLICT (thread_id) DO NOTHING
      `;
          if (receipt !== undefined) {
            yield* sql`
          INSERT INTO garrs_receipts (command_key, result_json, created_at)
          VALUES (${receipt.key}, ${receipt.json}, ${now})
          ON CONFLICT (command_key) DO NOTHING
        `;
          }
        }),
      )
      .pipe(Effect.mapError(fail("register thread")));
  });

  const ThreadRow = Schema.Struct({
    thread_id: Schema.String,
    project_id: Schema.String,
    agent_id: GarrsAgentId,
    attempt_id: Schema.NullOr(GarrsAttemptId),
    read_only: Schema.Number,
    instructions: Schema.String,
    config_revision: Schema.Number,
  });
  const decodeThreadRow = Schema.decodeUnknownEffect(ThreadRow);

  const getThread = Effect.fn("GarrsStore.getThread")(function* (threadId: ThreadId) {
    const rows = yield* sql`SELECT * FROM garrs_threads WHERE thread_id = ${threadId}`.pipe(
      Effect.mapError(fail("read thread")),
    );
    if (rows[0] === undefined) return null;
    const row = yield* decodeThreadRow(rows[0]).pipe(Effect.mapError(fail("decode thread")));
    return {
      threadId,
      projectId: row.project_id as ProjectId,
      agentId: row.agent_id,
      attemptId: row.attempt_id,
      readOnly: row.read_only === 1,
      instructions: row.instructions,
      configRevision: row.config_revision,
    } satisfies GarrsThreadRecord;
  });

  const listGarrasThreads = Effect.fn("GarrsStore.listGarrasThreads")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{ thread_id: string }>`
      SELECT thread_id FROM garrs_threads
      WHERE project_id = ${projectId} AND agent_id = 'garras'
      ORDER BY created_at DESC LIMIT 50
    `.pipe(Effect.mapError(fail("list garras threads")));
    return rows.map((row) => row.thread_id as ThreadId);
  });

  const listFailedGarrasThreads = Effect.fn("GarrsStore.listFailedGarrasThreads")(function* () {
    const rows = yield* sql<{ thread_id: string }>`
      SELECT DISTINCT t.thread_id FROM garrs_threads t
      JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id
      WHERE t.agent_id = 'garras' AND (
        (r.status = 'failed' AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs newer
          WHERE newer.thread_id = r.thread_id AND newer.ordinal > r.ordinal))
        OR EXISTS (SELECT 1 FROM garrs_receipts pending
          WHERE pending.command_key >= 'garrs:bootstrap:' AND pending.command_key < 'garrs:bootstrap;'
            AND json_extract(pending.result_json, '$.runId') = r.run_id
            AND json_extract(pending.result_json, '$.status') = 'selected')
      )
    `.pipe(Effect.mapError(fail("list failed Garras conversations")));
    return rows.map((row) => row.thread_id as ThreadId);
  });

  const listBootstrapDecisions = Effect.fn("GarrsStore.listBootstrapDecisions")(function* (
    threadId: ThreadId,
  ) {
    const prefix = bootstrapPrefix(threadId);
    const rows = yield* sql<{ result_json: string }>`
      SELECT result_json FROM garrs_receipts WHERE command_key >= ${prefix} AND command_key < ${`${prefix}\uffff`}
      ORDER BY created_at DESC, command_key DESC LIMIT 100
    `.pipe(Effect.mapError(fail("read bootstrap decisions")));
    return yield* Effect.forEach(rows.toReversed(), (row) =>
      bootstrapDecisionJson.decode(row.result_json),
    );
  });

  const saveBootstrapDecision = Effect.fn("GarrsStore.saveBootstrapDecision")(function* (
    threadId: ThreadId,
    decision: GarrsBootstrapDecision,
  ) {
    const json = yield* bootstrapDecisionJson.encode(decision);
    yield* sql`
      INSERT INTO garrs_receipts (command_key, result_json, created_at)
      VALUES (${`${bootstrapPrefix(threadId)}${decision.runId}`}, ${json}, ${decision.observedAt})
      ON CONFLICT (command_key) DO UPDATE SET result_json = excluded.result_json
    `.pipe(Effect.mapError(fail("save bootstrap decision")));
  });

  const children = <A>(
    table: string,
    workItemId: string,
    decode: (text: string) => Effect.Effect<A, GarrsStoreError>,
  ) =>
    sql
      .unsafe<{
        payload_json: string;
      }>(`SELECT payload_json FROM ${table} WHERE work_item_id = ? ORDER BY rowid`, [workItemId])
      .pipe(
        Effect.mapError(fail(`read ${table}`)),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.payload_json))),
      );

  const loadAggregate = Effect.fn("GarrsStore.loadAggregate")(function* (
    workItemId: GarrsWorkItemId,
  ) {
    const rows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM garrs_work_items WHERE id = ${workItemId}
    `.pipe(Effect.mapError(fail("read work item")));
    const row = rows[0];
    if (row === undefined) return null;
    const workItem = yield* workItemJson.decode(row.payload_json);
    const [plans, tasks, attempts, artifacts, reviews, messages] = yield* Effect.all([
      children("garrs_plans", workItemId, planJson.decode),
      children("garrs_tasks", workItemId, taskJson.decode),
      children("garrs_attempts", workItemId, attemptJson.decode),
      children("garrs_artifacts", workItemId, artifactJson.decode),
      children("garrs_reviews", workItemId, reviewJson.decode),
      children("garrs_messages", workItemId, messageJson.decode),
    ]);
    return {
      workItem,
      plans,
      tasks,
      attempts,
      artifacts,
      reviews,
      messages,
    } satisfies WorkAggregate;
  });

  const listWorkItems = Effect.fn("GarrsStore.listWorkItems")(function* (
    projectId: ProjectId,
    limit: number,
  ) {
    const rows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM garrs_work_items WHERE project_id = ${projectId}
      ORDER BY updated_at DESC LIMIT ${limit}
    `.pipe(Effect.mapError(fail("list work items")));
    return yield* Effect.forEach(rows, (row) => workItemJson.decode(row.payload_json));
  });

  const listTaskCounts = Effect.fn("GarrsStore.listTaskCounts")(function* (
    workItemIds: ReadonlyArray<GarrsWorkItemId>,
  ) {
    if (workItemIds.length === 0) return [];
    const rows = yield* sql<{
      work_item_id: string;
      task_count: number;
      completed_task_count: number;
    }>`
      SELECT work_item_id, COUNT(*) AS task_count,
        SUM(CASE WHEN json_extract(payload_json, '$.status') = 'completed' THEN 1 ELSE 0 END) AS completed_task_count
      FROM garrs_tasks WHERE work_item_id IN ${sql.in(workItemIds)} GROUP BY work_item_id
    `.pipe(Effect.mapError(fail("count work item tasks")));
    return rows.map((row) => ({
      workItemId: GarrsWorkItemId.make(row.work_item_id),
      taskCount: row.task_count,
      completedTaskCount: row.completed_task_count,
    }));
  });

  const listOpenWorkItemIds = Effect.fn("GarrsStore.listOpenWorkItemIds")(function* () {
    const rows = yield* sql<{ id: string }>`
      SELECT id FROM garrs_work_items
      WHERE status NOT IN ('delivered', 'accepted', 'cancelled', 'failed')
    `.pipe(Effect.mapError(fail("list open work items")));
    return rows.map((row) => GarrsWorkItemId.make(row.id));
  });

  const listHelperWorkItemIds = Effect.fn("GarrsStore.listHelperWorkItemIds")(function* () {
    const rows = yield* sql<{ id: string }>`
      SELECT DISTINCT t.work_item_id AS id FROM garrs_tasks t
      JOIN garrs_work_items w ON w.id = t.work_item_id
      WHERE w.status NOT IN ('delivered', 'accepted', 'cancelled', 'failed')
        AND json_type(t.payload_json, '$.helper') = 'object'
        AND json_extract(t.payload_json, '$.status') NOT IN ('completed', 'failed', 'cancelled')
    `.pipe(Effect.mapError(fail("list helper work items")));
    return rows.map((row) => GarrsWorkItemId.make(row.id));
  });

  const listActiveAttempts = Effect.fn("GarrsStore.listActiveAttempts")(function* () {
    const rows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM garrs_attempts
      WHERE status IN ('launching', 'running', 'cancel_requested')
    `.pipe(Effect.mapError(fail("list active attempts")));
    return yield* Effect.forEach(rows, (row) => attemptJson.decode(row.payload_json));
  });

  const findAttemptByThread = Effect.fn("GarrsStore.findAttemptByThread")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM garrs_attempts WHERE thread_id = ${threadId}
    `.pipe(Effect.mapError(fail("find attempt")));
    const row = rows[0];
    return row === undefined ? null : yield* attemptJson.decode(row.payload_json);
  });
  const findAttemptById = Effect.fn("GarrsStore.findAttemptById")(function* (
    attemptId: GarrsAttemptId,
  ) {
    const rows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM garrs_attempts WHERE id = ${attemptId}
    `.pipe(Effect.mapError(fail("find attempt by id")));
    const row = rows[0];
    return row === undefined ? null : yield* attemptJson.decode(row.payload_json);
  });

  const listActivity = Effect.fn("GarrsStore.listActivity")(function* (
    workItemId: GarrsWorkItemId,
    limit: number,
  ) {
    const rows = yield* sql<{ sequence: number; payload_json: string }>`
      SELECT sequence, payload_json FROM garrs_activity WHERE work_item_id = ${workItemId}
      ORDER BY sequence DESC LIMIT ${limit}
    `.pipe(Effect.mapError(fail("list activity")));
    const entries = yield* Effect.forEach(rows, (row) =>
      activityJson
        .decode(row.payload_json)
        .pipe(Effect.map((entry): GarrsActivity => ({ ...entry, sequence: row.sequence }))),
    );
    return entries.toReversed();
  });

  const getReceipt = Effect.fn("GarrsStore.getReceipt")(function* (key: string) {
    const rows = yield* sql<{ result_json: string }>`
      SELECT result_json FROM garrs_receipts WHERE command_key = ${key}
    `.pipe(Effect.mapError(fail("read receipt")));
    return rows[0]?.result_json ?? null;
  });

  const putReceipt = Effect.fn("GarrsStore.putReceipt")(function* (
    key: string,
    json: string,
    now: string,
  ) {
    yield* sql`
      INSERT INTO garrs_receipts (command_key, result_json, created_at)
      VALUES (${key}, ${json}, ${now})
      ON CONFLICT (command_key) DO NOTHING
    `.pipe(Effect.mapError(fail("write receipt")));
  });

  const upsertChild = (table: string, id: string, workItemId: string, payload: string) =>
    sql.unsafe(
      `INSERT INTO ${table} (id, work_item_id, payload_json) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET payload_json = excluded.payload_json`,
      [id, workItemId, payload],
    );

  const commit = Effect.fn("GarrsStore.commit")(function* (input: CommitInput) {
    const { next, previous } = input;
    const workItemId = next.workItem.id;
    // Encode everything before the transaction so it holds only SQL.
    const workItemPayload = yield* workItemJson.encode(next.workItem);
    const workItemChanged =
      previous === null || (yield* workItemJson.encode(previous.workItem)) !== workItemPayload;
    const plans = yield* changedRows(planJson, previous?.plans, next.plans);
    const tasks = yield* changedRows(taskJson, previous?.tasks, next.tasks);
    const artifacts = yield* changedRows(artifactJson, previous?.artifacts, next.artifacts);
    const reviews = yield* changedRows(reviewJson, previous?.reviews, next.reviews);
    const attempts = yield* changedRows(attemptJson, previous?.attempts, next.attempts);
    const messages = yield* changedRows(messageJson, previous?.messages, next.messages);
    const activity = yield* Effect.forEach(input.activity, (entry) =>
      activityJson.encode({ ...entry, workItemId, createdAt: input.now }),
    );
    const effects = yield* Effect.forEach(input.effects, ({ id, effect }) =>
      effectJson.encode(effect).pipe(Effect.map((payload) => ({ id, kind: effect.kind, payload }))),
    );
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          if (workItemChanged) {
            yield* sql`
              INSERT INTO garrs_work_items (id, project_id, garras_thread_id, status, updated_at, payload_json)
              VALUES (${workItemId}, ${next.workItem.projectId}, ${next.workItem.garrasThreadId},
                ${next.workItem.status}, ${next.workItem.updatedAt}, ${workItemPayload})
              ON CONFLICT (id) DO UPDATE SET
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
          }
          for (const row of plans) {
            yield* upsertChild("garrs_plans", row.entry.id, workItemId, row.payload);
          }
          for (const row of tasks) {
            yield* upsertChild("garrs_tasks", row.entry.id, workItemId, row.payload);
          }
          for (const row of artifacts) {
            yield* upsertChild("garrs_artifacts", row.entry.id, workItemId, row.payload);
          }
          for (const row of reviews) {
            yield* upsertChild("garrs_reviews", row.entry.id, workItemId, row.payload);
          }
          for (const { entry, payload } of attempts) {
            yield* sql`
              INSERT INTO garrs_attempts (id, work_item_id, thread_id, status, created_at, payload_json)
              VALUES (${entry.id}, ${workItemId}, ${entry.threadId}, ${entry.status},
                ${entry.createdAt}, ${payload})
              ON CONFLICT (id) DO UPDATE SET
                thread_id = excluded.thread_id,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
          }
          for (const { entry, payload } of messages) {
            yield* sql`
              INSERT INTO garrs_messages (id, work_item_id, dedupe_key, created_at, payload_json)
              VALUES (${entry.id}, ${workItemId}, ${entry.id}, ${entry.createdAt}, ${payload})
              ON CONFLICT (id) DO UPDATE SET payload_json = excluded.payload_json
            `;
          }
          for (const payload of activity) {
            yield* sql`
              INSERT INTO garrs_activity (work_item_id, payload_json) VALUES (${workItemId}, ${payload})
            `;
          }
          for (const effect of effects) {
            yield* sql`
              INSERT INTO garrs_outbox (id, work_item_id, kind, payload_json, status, created_at, updated_at)
              VALUES (${effect.id}, ${workItemId}, ${effect.kind}, ${effect.payload}, 'pending',
                ${input.now}, ${input.now})
            `;
          }
          if (input.receipt !== undefined) {
            yield* sql`
              INSERT INTO garrs_receipts (command_key, result_json, created_at)
              VALUES (${input.receipt.key}, ${input.receipt.json}, ${input.now})
              ON CONFLICT (command_key) DO NOTHING
            `;
          }
        }),
      )
      .pipe(Effect.mapError(fail("commit")));
  });

  const listPendingEffects = Effect.fn("GarrsStore.listPendingEffects")(function* () {
    const rows = yield* sql<{
      id: string;
      work_item_id: string;
      payload_json: string;
      tries: number;
    }>`
      SELECT id, work_item_id, payload_json, tries FROM garrs_outbox
      WHERE status = 'pending' ORDER BY created_at, rowid
    `.pipe(Effect.mapError(fail("list effects")));
    return yield* Effect.forEach(rows, (row) =>
      effectJson.decode(row.payload_json).pipe(
        Effect.map((effect): OutboxRow => ({
          id: row.id,
          workItemId: GarrsWorkItemId.make(row.work_item_id),
          effect,
          tries: row.tries,
        })),
      ),
    );
  });

  const finishEffect = Effect.fn("GarrsStore.finishEffect")(function* (input: {
    readonly id: string;
    readonly status: "done" | "failed" | "pending";
    readonly error: string | null;
    readonly now: string;
  }) {
    yield* sql`
      UPDATE garrs_outbox
      SET status = ${input.status}, last_error = ${input.error}, tries = tries + 1,
          updated_at = ${input.now}
      WHERE id = ${input.id}
    `.pipe(Effect.mapError(fail("finish effect")));
  });

  const countEffects = Effect.fn("GarrsStore.countEffects")(function* (
    attemptId: GarrsAttemptId,
    kind: GarrsEffect["kind"],
  ) {
    const rows = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM garrs_outbox
      WHERE kind = ${kind} AND json_extract(payload_json, '$.attemptId') = ${attemptId}
    `.pipe(Effect.mapError(fail("count effects")));
    return rows[0]?.count ?? 0;
  });

  const listMemory = Effect.fn("GarrsStore.listMemory")(function* (projectId: ProjectId) {
    const rows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM garrs_memory WHERE project_id = ${projectId}
      ORDER BY updated_at DESC LIMIT 500
    `.pipe(Effect.mapError(fail("list memory")));
    return yield* Effect.forEach(rows, (row) => memoryJson.decode(row.payload_json));
  });

  const putMemory = Effect.fn("GarrsStore.putMemory")(function* (entry: GarrsMemoryEntry) {
    const payload = yield* memoryJson.encode(entry);
    yield* sql`
      INSERT INTO garrs_memory (id, project_id, updated_at, payload_json)
      VALUES (${entry.id}, ${entry.projectId}, ${entry.updatedAt}, ${payload})
      ON CONFLICT (id) DO UPDATE SET
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `.pipe(Effect.mapError(fail("write memory")));
  });

  const deleteMemory = Effect.fn("GarrsStore.deleteMemory")(function* (
    id: GarrsMemoryId,
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{ id: string }>`
      DELETE FROM garrs_memory WHERE id = ${id} AND project_id = ${projectId} RETURNING id
    `.pipe(Effect.mapError(fail("delete memory")));
    return rows.length > 0;
  });

  const listModelFailures = Effect.fn("GarrsStore.listModelFailures")(function* () {
    const rows = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM garrs_attempts
      WHERE json_extract(payload_json, '$.failure.class') = 'usage_limit'
      ORDER BY created_at DESC LIMIT 256
    `.pipe(Effect.mapError(fail("list model failures")));
    return yield* Effect.forEach(rows, (row) => attemptJson.decode(row.payload_json));
  });

  const listUsageAttempts = Effect.fn("GarrsStore.listUsageAttempts")(function* (input: {
    readonly projectId: ProjectId | undefined;
    readonly agentId: GarrsAttempt["agentId"] | undefined;
    readonly providerInstanceId: GarrsAttempt["decision"]["requested"]["instanceId"] | undefined;
    readonly model: string | undefined;
    readonly since: string | undefined;
    readonly until: string | undefined;
    readonly limit: number;
  }) {
    const projectId = input.projectId ?? null;
    const agentId = input.agentId ?? null;
    const providerInstanceId = input.providerInstanceId ?? null;
    const model = input.model ?? null;
    const since = input.since ?? null;
    const until = input.until ?? null;
    const rows = yield* sql<{ attempt_json: string; work_json: string; task_json: string | null }>`
      SELECT a.payload_json AS attempt_json, w.payload_json AS work_json, t.payload_json AS task_json
      FROM garrs_attempts a JOIN garrs_work_items w ON w.id = a.work_item_id
      LEFT JOIN garrs_tasks t ON t.id = json_extract(a.payload_json, '$.taskId') AND t.work_item_id = w.id
      WHERE (${projectId} IS NULL OR COALESCE(json_extract(t.payload_json, '$.projectId'), w.project_id) = ${projectId})
        AND (${agentId} IS NULL OR json_extract(a.payload_json, '$.agentId') = ${agentId})
        AND (${providerInstanceId} IS NULL OR json_extract(a.payload_json, '$.decision.requested.instanceId') = ${providerInstanceId})
        AND (${model} IS NULL OR json_extract(a.payload_json, '$.decision.requested.model') = ${model})
        AND (${since} IS NULL OR a.created_at >= ${since})
        AND (${until} IS NULL OR a.created_at < ${until})
      ORDER BY a.created_at DESC
      LIMIT ${input.limit}
    `.pipe(Effect.mapError(fail("list usage")));
    return yield* Effect.forEach(rows, (row) =>
      Effect.all({
        attempt: attemptJson.decode(row.attempt_json),
        workItem: workItemJson.decode(row.work_json),
        task: row.task_json === null ? Effect.succeed(null) : taskJson.decode(row.task_json),
      }),
    );
  });

  const listConversationUsage = Effect.fn("GarrsStore.listConversationUsage")(function* (input: {
    readonly projectId: ProjectId | undefined;
    readonly agentId: GarrsAttempt["agentId"] | undefined;
    readonly providerInstanceId: GarrsAttempt["decision"]["requested"]["instanceId"] | undefined;
    readonly model: string | undefined;
    readonly since: string | undefined;
    readonly until: string | undefined;
    readonly limit: number;
  }) {
    if (input.agentId !== undefined && input.agentId !== "garras")
      return { candidates: [], turns: [], turnsTruncated: false };
    const projectId = input.projectId ?? null,
      provider = input.providerInstanceId ?? null,
      model = input.model ?? null,
      since = input.since ?? null,
      until = input.until ?? null;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            thread_id: string;
            project_id: string;
            run_id: string;
            payload_json: string;
          }>`
        SELECT g.thread_id, g.project_id, r.run_id, r.payload_json FROM garrs_threads g
        JOIN orchestration_v2_projection_runs r ON r.thread_id = g.thread_id
        WHERE g.agent_id = 'garras' AND g.attempt_id IS NULL
          AND (${projectId} IS NULL OR g.project_id = ${projectId})
          AND (${provider} IS NULL OR json_extract(r.payload_json, '$.providerInstanceId') = ${provider})
          AND (${model} IS NULL OR json_extract(r.payload_json, '$.modelSelection.model') = ${model})
          AND (${since} IS NULL OR r.requested_at >= ${since}) AND (${until} IS NULL OR r.requested_at < ${until})
        ORDER BY r.requested_at DESC, r.run_id DESC LIMIT ${input.limit}
      `.pipe(Effect.mapError(fail("list Garras conversation runs")));
          const candidates = yield* Effect.forEach(rows, (row) =>
            Effect.flatMap(conversationRunJson.decode(row.payload_json), (run) => {
              if (run.id !== row.run_id || run.threadId !== row.thread_id)
                return Effect.fail(
                  new GarrsStoreError({ operation: "verify Garras conversation identity" }),
                );
              return Effect.succeed({
                threadId: row.thread_id as ThreadId,
                projectId: row.project_id as ProjectId,
                run,
              } satisfies ConversationCandidate);
            }),
          );
          if (candidates.length === 0) return { candidates, turns: [], turnsTruncated: false };
          const threadIds = encodeStringArrayJson([
            ...new Set(candidates.map((entry) => entry.threadId)),
          ]);
          const runIds = encodeStringArrayJson(candidates.map((entry) => entry.run.id));
          const turnRows = yield* sql<{
            thread_id: string;
            provider_turn_id: string;
            node_id: string;
            run_attempt_id: string | null;
            payload_json: string;
            attempt_run: string | null;
            attempt_root: string | null;
            node_run: string | null;
          }>`
        SELECT t.thread_id, t.provider_turn_id, t.node_id, t.run_attempt_id, t.payload_json, a.run_id AS attempt_run, a.root_node_id AS attempt_root, n.run_id AS node_run
        FROM orchestration_v2_projection_provider_turns t
        LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id AND a.thread_id = t.thread_id
        LEFT JOIN orchestration_v2_projection_nodes n ON n.node_id = t.node_id AND n.thread_id = t.thread_id
        WHERE t.thread_id IN (SELECT value FROM json_each(${threadIds}))
          AND (a.run_id IN (SELECT value FROM json_each(${runIds})) OR n.run_id IN (SELECT value FROM json_each(${runIds})) OR (a.run_id IS NULL AND n.run_id IS NULL))
        ORDER BY t.provider_turn_id LIMIT 25001
      `.pipe(Effect.mapError(fail("list Garras conversation turns")));
          const turns = yield* Effect.forEach(turnRows.slice(0, 25000), (row) =>
            Effect.map(conversationTurnJson.decode(row.payload_json), (turn): ConversationTurn => ({
              threadId: row.thread_id,
              turn,
              attemptRun: row.attempt_run,
              attemptRoot: row.attempt_root,
              nodeRun: row.node_run,
              inconsistent:
                turn.id !== row.provider_turn_id ||
                turn.nodeId !== row.node_id ||
                turn.runAttemptId !== row.run_attempt_id,
            })),
          );
          return { candidates, turns, turnsTruncated: turnRows.length > 25000 };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isGarrsStoreError(cause) ? cause : fail("read Garras conversation usage")(cause),
        ),
      );
  });

  return GarrsStore.of({
    getConfig,
    getConfigRevision,
    saveConfig,
    getBinding,
    saveBinding,
    registerThread,
    getThread,
    listGarrasThreads,
    listFailedGarrasThreads,
    listBootstrapDecisions,
    saveBootstrapDecision,
    loadAggregate,
    listWorkItems,
    listTaskCounts,
    listOpenWorkItemIds,
    listHelperWorkItemIds,
    listActiveAttempts,
    listModelFailures,
    findAttemptByThread,
    findAttemptById,
    listActivity,
    getReceipt,
    putReceipt,
    commit,
    listPendingEffects,
    finishEffect,
    countEffects,
    listMemory,
    putMemory,
    deleteMemory,
    listUsageAttempts,
    listConversationUsage,
  });
});

export const layer = Layer.effect(GarrsStore, make);
