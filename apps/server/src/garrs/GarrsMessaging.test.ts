import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  GarrsAttemptId,
  GarrsTaskId,
  GarrsWorkItemId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { taskFromSpec, unknownUsage, type WorkAggregate } from "./GarrsDomain.ts";
import * as GarrsService from "./GarrsService.ts";
import * as GarrsStore from "./GarrsStore.ts";

const NOW = "2026-10-31T12:00:00.000Z";
const projectId = ProjectId.make("project");
const targetProjectId = ProjectId.make("other-project");
const garras = ThreadId.make("garras-thread");
const recipient = ThreadId.make("garrs:attempt");

function work(): WorkAggregate {
  const workItem = {
    id: GarrsWorkItemId.make("work"),
    projectId,
    garrasThreadId: garras,
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
    projectContexts: [
      {
        projectId: targetProjectId,
        bindingRevision: 1,
        rules: [],
        workspace: {
          projectId: targetProjectId,
          checkoutPath: "/other-project",
          isolated: false,
          baseSha: null,
        },
      },
    ],
    authorizations: [],
    createdAt: NOW,
    updatedAt: NOW,
    deliveredAt: null,
    acceptedAt: null,
  };
  const task = taskFromSpec({
    id: GarrsTaskId.make("task"),
    workItem,
    planRevision: 1,
    now: NOW,
    spec: {
      key: "api",
      projectId: targetProjectId,
      agentId: "botas",
      title: "API",
      objective: "Inspect",
      reason: "Owner",
      inputs: [],
      deliverables: ["Result"],
      acceptanceCriteria: ["Evidence"],
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
        id: GarrsAttemptId.make("attempt"),
        taskId: task.id,
        workItemId: workItem.id,
        agentId: "botas",
        generation: 0,
        threadId: recipient,
        runId: null,
        readOnlyEnforced: true,
        decision: {
          source: "catalog_default",
          candidates: [],
          requested: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
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
        reviewSubjectHash: null,
        usage: unknownUsage(),
      },
    ],
    artifacts: [],
    reviews: [],
    messages: [],
  };
}

it.effect.each(["stop_attempt", "cancel", "lookup_unavailable", "ended_thread"] as const)(
  "settles %s before a queued attempt creates its provider thread",
  (action) =>
    Effect.gen(function* () {
      let launches = 0;
      let lookupUnavailable = action === "lookup_unavailable";
      const deps = Layer.mergeAll(
        Layer.succeed(ThreadManagement.ThreadManagementService, {
          dispatch: () => Effect.void,
          getThreadProjection: (threadId: ThreadId) =>
            action === "ended_thread"
              ? Effect.succeed({ runs: [], messages: [], providerTurns: [], visibleTurnItems: [] })
              : Effect.fail(
                  new Orchestrator.OrchestratorProjectionError({
                    threadId,
                    cause: lookupUnavailable
                      ? new Error("Lookup temporarily unavailable")
                      : new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
                  }),
                ),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
          launch: () =>
            Effect.sync(() => {
              launches += 1;
            }),
        } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]),
        Layer.succeed(UsageService.UsageService, {} as UsageService.UsageService["Service"]),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
        Layer.succeed(ProjectStore.ProjectStoreV2, {
          get: () => Effect.succeedNone,
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      ).pipe(
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(GarrsStore.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GarrsStore.GarrsStore;
          const initial = work();
          const aggregate = {
            ...initial,
            workItem: { ...initial.workItem, projectContexts: [] },
            attempts: initial.attempts.map((attempt) => ({
              ...attempt,
              status: action === "ended_thread" ? ("running" as const) : ("launching" as const),
              threadId: action === "ended_thread" ? recipient : null,
            })),
          };
          const attemptId = aggregate.attempts[0]!.id;
          yield* store.commit({
            previous: null,
            next: aggregate,
            activity: [],
            effects: [{ id: "queued-launch", effect: { kind: "launch_attempt", attemptId } }],
            now: NOW,
          });
          const context = yield* Layer.build(GarrsService.layer);
          const service = Context.get(context, GarrsService.GarrsService);
          yield* service.control({
            commandId: CommandId.make(`stop-${action}`),
            workItemId: aggregate.workItem.id,
            action: action === "cancel" ? { type: "cancel" } : { type: "stop_attempt", attemptId },
          });
          yield* service.drain;
          if (lookupUnavailable) {
            expect((yield* store.loadAggregate(aggregate.workItem.id))!.attempts[0]!.status).toBe(
              "cancel_requested",
            );
            expect(yield* store.listPendingEffects()).toMatchObject([
              { effect: { kind: "stop_attempt" }, tries: 1 },
            ]);
            lookupUnavailable = false;
            yield* service.control({
              commandId: CommandId.make("retry-stop"),
              workItemId: aggregate.workItem.id,
              action: { type: "pause" },
            });
            yield* service.drain;
          }
          const stopped = (yield* store.loadAggregate(aggregate.workItem.id))!;
          expect(stopped.attempts[0]!.status).toBe("cancelled");
          expect(stopped.tasks[0]!.status).toBe(action === "cancel" ? "cancelled" : "failed");
          expect(yield* store.listActiveAttempts()).toEqual([]);
          expect(launches).toBe(0);
        }).pipe(Effect.provide(deps)),
      );
    }),
);

it.effect(
  "keeps a failed delivery pending and recovers an accepted message across service restart",
  () =>
    Effect.gen(function* () {
      let failure: "before" | "after" | null = "before";
      const persisted = new Set<string>();
      const deliveryProjects: Array<ProjectId> = [];
      let dispatches = 0;
      const threadStub = {
        streamDomainEvents: Stream.never,
        getThreadProjection: () =>
          Effect.sync(() => ({
            messages: [...persisted].map((id) => ({ id })),
            runs: [],
            providerTurns: [],
          })),
        sendToThread: (input: {
          readonly messageId: string;
          readonly threadId: ThreadId;
          readonly projectId: ProjectId;
        }) =>
          Effect.gen(function* () {
            dispatches += 1;
            deliveryProjects.push(input.projectId);
            if (failure !== "before") persisted.add(input.messageId);
            if (failure !== null)
              return yield* new ThreadManagement.ThreadManagementThreadNotFoundError({
                projectId,
                threadId: input.threadId,
              });
            return {};
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"];
      const deps = Layer.mergeAll(
        Layer.succeed(ThreadManagement.ThreadManagementService, threadStub),
        Layer.succeed(
          ThreadLaunchService.ThreadLaunchService,
          {} as ThreadLaunchService.ThreadLaunchService["Service"],
        ),
        Layer.succeed(UsageService.UsageService, {} as UsageService.UsageService["Service"]),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
        Layer.succeed(ProjectStore.ProjectStoreV2, {
          get: () => Effect.succeedNone,
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      ).pipe(
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(GarrsStore.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      yield* Effect.gen(function* () {
        const store = yield* GarrsStore.GarrsStore;
        const aggregate = work();
        yield* store.commit({
          previous: null,
          next: aggregate,
          activity: [],
          effects: [],
          now: NOW,
        });
        yield* store.registerThread(
          {
            threadId: garras,
            projectId,
            agentId: "garras",
            attemptId: null,
            readOnly: true,
            instructions: "",
            configRevision: 0,
          },
          NOW,
        );
        yield* store.registerThread(
          {
            threadId: recipient,
            projectId: targetProjectId,
            agentId: "botas",
            attemptId: aggregate.attempts[0]!.id,
            readOnly: true,
            instructions: "",
            configRevision: 0,
          },
          NOW,
        );
        const input = {
          to: "botas" as const,
          kind: "question" as const,
          body: "Which API?",
          workItemId: aggregate.workItem.id,
          clientRequestId: "request-1",
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(GarrsService.layer);
            const service = Context.get(context, GarrsService.GarrsService);
            expect(
              (yield* service.status(
                { threadId: recipient },
                { workItemId: aggregate.workItem.id },
              )).workItemId,
            ).toBe(aggregate.workItem.id);
            yield* service.sendMessage({ threadId: garras }, input);
            yield* service.drain;
            expect(
              (yield* store.loadAggregate(aggregate.workItem.id))?.messages[0]?.deliveryStatus,
            ).toBe("pending");
            expect(yield* store.listPendingEffects()).toMatchObject([
              { effect: { kind: "deliver_message" }, tries: 1 },
            ]);
            yield* service.sendMessage({ threadId: garras }, input);
            expect((yield* store.loadAggregate(aggregate.workItem.id))?.messages).toHaveLength(1);
            failure = "after";
            yield* service.control({
              commandId: CommandId.make("pause"),
              workItemId: aggregate.workItem.id,
              action: { type: "pause" },
            });
            yield* service.drain;
            expect(
              (yield* store.loadAggregate(aggregate.workItem.id))?.messages[0]?.deliveryStatus,
            ).toBe("pending");
            expect(persisted.size).toBe(1);
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(GarrsService.layer);
            const service = Context.get(context, GarrsService.GarrsService);
            failure = null;
            yield* service.start();
            yield* service.control({
              commandId: CommandId.make("resume"),
              workItemId: aggregate.workItem.id,
              action: { type: "resume" },
            });
            yield* service.drain;
            expect(
              (yield* store.loadAggregate(aggregate.workItem.id))?.messages[0]?.deliveryStatus,
            ).toBe("queued");
            expect(persisted.size).toBe(1);
            expect(dispatches).toBe(2);
            expect(deliveryProjects).toEqual([targetProjectId, targetProjectId]);
          }),
        );
      }).pipe(Effect.provide(deps));
    }),
);
