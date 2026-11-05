import { describe, expect, it } from "@effect/vitest";
import {
  GarrsAttemptId,
  GarrsMessageId,
  GarrsTaskId,
  GarrsWorkItemId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  defaultTeamConfig,
  taskFromSpec,
  unknownUsage,
  type WorkAggregate,
} from "./GarrsDomain.ts";
import * as GarrsStore from "./GarrsStore.ts";
import { conversationUsage } from "./GarrsConversationUsage.ts";

const NOW = "2026-10-31T12:00:00.000Z";
const layer = GarrsStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const aggregate = (): WorkAggregate => {
  const workItem = {
    id: GarrsWorkItemId.make("w1"),
    projectId: ProjectId.make("p1"),
    garrasThreadId: ThreadId.make("garras:1"),
    title: "Work",
    objective: "Goal",
    intent: "diagnose" as const,
    access: "read_only" as const,
    status: "active" as const,
    statusReason: null,
    configRevision: 0,
    bindingRevision: 0,
    revision: 1,
    correctionCycles: 0,
    rules: [],
    workspace: null,
    authorizations: [],
    createdAt: NOW,
    updatedAt: NOW,
    deliveredAt: null,
    acceptedAt: null,
  };
  const task = taskFromSpec({
    id: GarrsTaskId.make("w1-t1"),
    workItem,
    planRevision: 1,
    now: NOW,
    spec: {
      key: "look",
      agentId: "botas",
      title: "Look",
      objective: "Find the cause",
      reason: "Backend owner",
      inputs: [],
      deliverables: ["Diagnosis"],
      acceptanceCriteria: ["Cause confirmed or hypotheses ranked"],
      dependsOn: [],
      capability: "read",
    },
  });
  return {
    workItem,
    plans: [],
    tasks: [{ ...task, status: "running" }],
    attempts: [
      {
        id: GarrsAttemptId.make("w1-a1"),
        taskId: task.id,
        workItemId: workItem.id,
        agentId: "botas",
        generation: 0,
        threadId: ThreadId.make("garrs:w1-a1"),
        runId: null,
        readOnlyEnforced: true,
        decision: {
          source: "catalog_default",
          candidates: [],
          requested: { instanceId: ProviderInstanceId.make("codex"), model: "model-a" },
          reason: "Default",
          fallbackUsed: false,
          constraints: [],
          effectiveModel: null,
          effectiveModelSource: "pending",
        },
        status: "running",
        error: null,
        createdAt: NOW,
        startedAt: NOW,
        endedAt: null,
        cancelRequestedAt: null,
        reviewSubjectHash: "review-subject-1",
        usage: unknownUsage(),
      },
    ],
    artifacts: [],
    reviews: [],
    messages: [],
  };
};

describe("GarrsStore", () => {
  it.effect(
    "selects bounded Garras conversation runs and their root turn usage without work item IDs",
    () =>
      Effect.gen(function* () {
        const store = yield* GarrsStore.GarrsStore;
        const sql = yield* SqlClient.SqlClient;
        for (const [thread, agent] of [
          ["garras:1", "garras"],
          ["worker:1", "botas"],
        ] as const) {
          yield* store.registerThread(
            {
              threadId: ThreadId.make(thread),
              projectId: ProjectId.make("p1"),
              agentId: agent,
              attemptId: agent === "garras" ? null : GarrsAttemptId.make("attempt"),
              readOnly: true,
              instructions: "",
              configRevision: 0,
            },
            NOW,
          );
        }
        for (const [id, thread, ordinal] of [
          ["run1", "garras:1", 1],
          ["run2", "garras:1", 2],
          ["run3", "worker:1", 1],
        ] as const) {
          const run = JSON.stringify({
            id,
            threadId: thread,
            ordinal,
            providerInstanceId: "codex",
            modelSelection: { instanceId: "codex", model: "cheap" },
            providerThreadId: null,
            userMessageId: `message-${id}`,
            rootNodeId: `node-${id}`,
            activeAttemptId: null,
            status: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            checkpointId: null,
            contextHandoffId: null,
          });
          yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES (${id},${thread},${ordinal},'codex','completed',${NOW},${run})`;
          yield* sql`INSERT INTO orchestration_v2_projection_nodes (node_id,thread_id,run_id,root_node_id,kind,status,payload_json) VALUES (${`node-${id}`},${thread},${id},${`node-${id}`},'root_turn','completed','{}')`;
          const turn = JSON.stringify({
            id: `turn-${id}`,
            providerThreadId: `provider-${id}`,
            nodeId: `node-${id}`,
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: NOW,
            completedAt: NOW,
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: false,
              inputTokens: 100,
              cachedInputTokens: 10,
              cacheCreationTokens: 0,
              outputTokens: 20,
            },
          });
          yield* sql`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id,thread_id,provider_thread_id,node_id,ordinal,status,payload_json) VALUES (${`turn-${id}`},${thread},${`provider-${id}`},${`node-${id}`},1,'completed',${turn})`;
        }
        const query = {
          projectId: ProjectId.make("p1"),
          agentId: "garras" as const,
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "cheap",
          since: undefined,
          until: undefined,
          limit: 1,
        };
        const result = yield* store.listConversationUsage(query);
        expect(result.candidates.map((entry) => entry.run.id)).toEqual(["run2"]);
        expect(
          conversationUsage(result.candidates, result.turns, result.turnsTruncated)[0]?.usage
            .inputTokens,
        ).toBe(100);
        expect(
          (yield* store.listConversationUsage({ ...query, agentId: "botas" })).candidates,
        ).toEqual([]);
        expect(
          (yield* store.listConversationUsage({ ...query, since: "2026-11-01T00:00:00.000Z" }))
            .candidates,
        ).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("counts tasks for requested work items regardless of work status", () =>
    Effect.gen(function* () {
      const store = yield* GarrsStore.GarrsStore;
      const base = aggregate();
      const delivered = {
        ...base,
        workItem: { ...base.workItem, status: "delivered" as const },
        tasks: [
          { ...base.tasks[0]!, status: "completed" as const },
          {
            ...base.tasks[0]!,
            id: GarrsTaskId.make("w1-t2"),
            key: "second",
            status: "completed" as const,
          },
          {
            ...base.tasks[0]!,
            id: GarrsTaskId.make("w1-t3"),
            key: "cancelled",
            status: "cancelled" as const,
          },
        ],
      };
      yield* store.commit({ previous: null, next: delivered, activity: [], effects: [], now: NOW });
      const otherId = GarrsWorkItemId.make("w2");
      const active = {
        ...base,
        workItem: { ...base.workItem, id: otherId },
        tasks: [{ ...base.tasks[0]!, id: GarrsTaskId.make("w2-t1"), workItemId: otherId }],
      };
      yield* store.commit({
        previous: null,
        next: { ...active, attempts: [] },
        activity: [],
        effects: [],
        now: NOW,
      });
      expect(yield* store.listTaskCounts([base.workItem.id])).toEqual([
        { workItemId: base.workItem.id, taskCount: 3, completedTaskCount: 2 },
      ]);
      expect(yield* store.listTaskCounts([base.workItem.id, otherId])).toEqual([
        { workItemId: base.workItem.id, taskCount: 3, completedTaskCount: 2 },
        { workItemId: otherId, taskCount: 1, completedTaskCount: 0 },
      ]);
      expect(yield* store.listTaskCounts([])).toEqual([]);
      expect(yield* store.listTaskCounts([GarrsWorkItemId.make("missing")])).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("attributes usage to the task project rather than the work item's project", () =>
    Effect.gen(function* () {
      const store = yield* GarrsStore.GarrsStore;
      const base = aggregate();
      const next = { ...base, tasks: [{ ...base.tasks[0]!, projectId: ProjectId.make("p2") }] };
      yield* store.commit({ previous: null, next, activity: [], effects: [], now: NOW });
      const filter = {
        since: undefined,
        until: undefined,
        agentId: undefined,
        providerInstanceId: undefined,
        model: undefined,
        limit: 10,
      };
      expect(
        (yield* store.listUsageAttempts({ ...filter, projectId: ProjectId.make("p2") })).map(
          (row) => row.attempt.id,
        ),
      ).toEqual(["w1-a1"]);
      expect(
        yield* store.listUsageAttempts({ ...filter, projectId: ProjectId.make("p1") }),
      ).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("commits state, activity and effects together and reads them back", () =>
    Effect.gen(function* () {
      const store = yield* GarrsStore.GarrsStore;
      const base = aggregate();
      const next: WorkAggregate = {
        ...base,
        tasks: [
          ...base.tasks,
          {
            ...base.tasks[0]!,
            id: GarrsTaskId.make("w1-helper"),
            key: "helper-1",
            helper: {
              parentTaskId: base.tasks[0]!.id,
              parentAttemptId: base.attempts[0]!.id,
              deadline: "2026-10-31T12:10:00.000Z",
            },
          },
        ],
        messages: [
          {
            id: GarrsMessageId.make("m1"),
            workItemId: base.workItem.id,
            taskId: null,
            fromAgent: "pixi",
            toAgent: "botas",
            kind: "question",
            body: "Which API?",
            refs: [],
            replyTo: null,
            deliveryStatus: "pending",
            createdAt: NOW,
          },
        ],
      };
      yield* store.commit({
        previous: null,
        next,
        activity: [
          {
            type: "work.created",
            summary: "Opened",
            agentId: "garras",
            taskId: null,
            attemptId: null,
          },
        ],
        effects: [
          { id: "e1", effect: { kind: "launch_attempt", attemptId: next.attempts[0]!.id } },
          {
            id: "e2",
            effect: {
              kind: "deliver_message",
              messageId: GarrsMessageId.make("m1"),
              attemptId: next.attempts[0]!.id,
            },
          },
        ],
        receipt: { key: "start:1", json: '{"ok":true}' },
        now: NOW,
      });

      expect(yield* store.loadAggregate(next.workItem.id)).toEqual(next);
      expect(yield* store.listHelperWorkItemIds()).toEqual([next.workItem.id]);
      expect(yield* store.findAttemptByThread(ThreadId.make("garrs:w1-a1"))).toEqual(
        next.attempts[0],
      );
      expect((yield* store.listActiveAttempts()).map((attempt) => attempt.id)).toEqual(["w1-a1"]);
      expect(
        (yield* store.listUsageAttempts({
          projectId: undefined,
          since: undefined,
          until: undefined,
          agentId: "pixi",
          providerInstanceId: undefined,
          model: undefined,
          limit: 1,
        })).length,
      ).toBe(0);
      expect(
        (yield* store.listUsageAttempts({
          projectId: undefined,
          since: undefined,
          until: undefined,
          agentId: "botas",
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "model-a",
          limit: 1,
        })).map(({ attempt }) => attempt.id),
      ).toEqual(["w1-a1"]);
      expect(
        (yield* store.listUsageAttempts({
          projectId: undefined,
          since: undefined,
          until: undefined,
          agentId: "botas",
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "model-a",
          limit: 1,
        }))[0]?.task,
      ).toEqual(next.tasks[0]);
      for (const filter of [
        {
          agentId: "botas" as const,
          providerInstanceId: ProviderInstanceId.make("claude"),
          model: "model-a",
        },
        {
          agentId: "botas" as const,
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "model-b",
        },
      ]) {
        expect(
          yield* store.listUsageAttempts({
            projectId: undefined,
            since: undefined,
            until: undefined,
            ...filter,
            limit: 1,
          }),
        ).toEqual([]);
      }
      expect(yield* store.listPendingEffects()).toMatchObject([
        { id: "e1", tries: 0 },
        { id: "e2", tries: 0 },
      ]);
      expect(yield* store.getReceipt("start:1")).toBe('{"ok":true}');
      expect(
        (yield* store.listActivity(next.workItem.id, 10)).map((entry) => entry.summary),
      ).toEqual(["Opened"]);

      yield* store.finishEffect({ id: "e1", status: "done", error: null, now: NOW });
      yield* store.finishEffect({
        id: "e2",
        status: "pending",
        error: "Temporary failure",
        now: NOW,
      });
      expect(yield* store.listPendingEffects()).toMatchObject([
        { id: "e2", tries: 1, effect: { kind: "deliver_message", messageId: "m1" } },
      ]);
      expect((yield* store.loadAggregate(next.workItem.id))?.messages[0]?.deliveryStatus).toBe(
        "pending",
      );
      yield* store.finishEffect({ id: "e2", status: "done", error: null, now: NOW });
      expect(yield* store.listPendingEffects()).toEqual([]);
      expect(yield* store.countEffects(next.attempts[0]!.id, "launch_attempt")).toBe(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects a config save based on a stale revision", () =>
    Effect.gen(function* () {
      const store = yield* GarrsStore.GarrsStore;
      const initial = yield* store.getConfig();
      expect(initial.revision).toBe(0);
      const saved = yield* store.saveConfig(0, defaultTeamConfig(), NOW);
      expect(saved.revision).toBe(1);
      const stale = yield* Effect.flip(store.saveConfig(0, defaultTeamConfig(), NOW));
      expect(stale._tag).toBe("GarrsRevisionConflict");
      // Work started on revision 1 keeps reading it after later saves.
      yield* store.saveConfig(1, { ...defaultTeamConfig(), knowledgeSources: ["docs/"] }, NOW);
      expect((yield* store.getConfigRevision(1)).knowledgeSources).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("persists associated project IDs with the project settings", () =>
    Effect.gen(function* () {
      const store = yield* GarrsStore.GarrsStore;
      const owner = ProjectId.make("owner");
      const linked = ProjectId.make("linked");
      const binding = yield* store.getBinding(owner);
      yield* store.saveBinding(
        binding.revision,
        { ...binding.binding, linkedProjectIds: [linked] },
        NOW,
      );
      expect((yield* store.getBinding(owner)).binding.linkedProjectIds).toEqual([linked]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("records which threads are team members and with what access", () =>
    Effect.gen(function* () {
      const store = yield* GarrsStore.GarrsStore;
      const record = {
        threadId: ThreadId.make("garras:9"),
        projectId: ProjectId.make("p1"),
        agentId: "garras" as const,
        attemptId: null,
        readOnly: true,
        instructions: "Coordinate.",
        configRevision: 0,
      };
      yield* store.registerThread(record, NOW);
      // A retried launch registers the same thread again without changing it.
      yield* store.registerThread({ ...record, readOnly: false }, NOW);
      expect(yield* store.getThread(record.threadId)).toEqual(record);
      expect(yield* store.getThread(ThreadId.make("ordinary-thread"))).toBeNull();
      expect(yield* store.listGarrasThreads(record.projectId)).toEqual([record.threadId]);
    }).pipe(Effect.provide(layer)),
  );
});
