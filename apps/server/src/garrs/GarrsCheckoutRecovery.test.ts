import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  GarrsAttemptId,
  GarrsTaskId,
  GarrsWorkItemId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  defaultProjectBinding,
  planTaskSpec,
  taskFromSpec,
  unknownUsage,
  type WorkAggregate,
} from "./GarrsDomain.ts";
import * as GarrsService from "./GarrsService.ts";
import * as GarrsStore from "./GarrsStore.ts";

it.effect.each([
  "provider-failure",
  "continuation-limit",
  "historical",
  "wrong-repository",
  "wrong-base",
] as const)("recovers a prepared checkout without recreating it: %s", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-prepared-recovery-" });
    const root = path.join(temp, "project");
    const other = path.join(temp, "other");
    const checkout = path.join(temp, "prepared");
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      vcs.run({ operation: "GarrsCheckoutRecovery.test", command: "git", cwd, args });
    for (const dir of [root, other]) {
      yield* fs.makeDirectory(dir);
      yield* git(dir, ["init", "--quiet"]);
      yield* fs.writeFileString(
        path.join(dir, "file"),
        dir === root ? "original" : "other repository",
      );
      yield* git(dir, ["add", "file"]);
      yield* git(dir, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "-m",
        "base",
      ]);
    }
    const baseSha = (yield* git(root, ["rev-parse", "HEAD"])).stdout.trim();
    yield* git(scenario === "wrong-repository" ? other : root, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "garrs/prepared",
      checkout,
    ]);
    if (scenario === "wrong-base") {
      yield* git(checkout, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "outside base",
      ]);
    }
    yield* fs.writeFileString(path.join(root, "file"), "uncommitted user work");
    const now = "2026-11-01T06:00:00.000Z";
    yield* TestClock.setTime(Date.parse(now));
    const projectId = ProjectId.make("prepared-project");
    const threadId = ThreadId.make("garrs:prepared-first");
    const attemptId = GarrsAttemptId.make("prepared-first");
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "model" };
    const fallback = { ...selection, instanceId: ProviderInstanceId.make("codex-other") };
    const workItem = {
      id: GarrsWorkItemId.make("prepared-work"),
      projectId,
      garrasThreadId: ThreadId.make("garras:prepared"),
      title: "Write work",
      objective: "Plan then implement",
      intent: "implement" as const,
      access: "write" as const,
      status: scenario === "historical" ? ("blocked" as const) : ("active" as const),
      statusReason: null,
      configRevision: 0,
      bindingRevision: 1,
      revision: 1,
      correctionCycles: 0,
      rules: [],
      workspace: { projectId, checkoutPath: null, isolated: true, baseSha },
      authorizations: [],
      createdAt: now,
      updatedAt: now,
      deliveredAt: null,
      acceptedAt: null,
    };
    const task = {
      ...taskFromSpec({
        id: GarrsTaskId.make("prepared-plan"),
        workItem,
        planRevision: 0,
        now,
        spec: {
          ...planTaskSpec(workItem.objective),
          selection,
          selectionReason: "Bounded planning",
          ...(scenario === "continuation-limit" ? { fallbackSelections: [fallback] } : {}),
        },
      }),
      status: scenario === "historical" ? ("failed" as const) : ("running" as const),
      attemptCount: 1,
    };
    const aggregate: WorkAggregate = {
      workItem,
      tasks: [task],
      plans: [],
      artifacts: [],
      reviews: [],
      messages: [],
      attempts: [
        {
          id: attemptId,
          taskId: task.id,
          workItemId: workItem.id,
          agentId: "asta",
          generation: 0,
          threadId,
          runId: RunId.make("prepared-run"),
          readOnlyEnforced: true,
          decision: {
            source: "coordinator",
            candidates: [],
            requested: selection,
            reason: "Bounded planning",
            fallbackUsed: false,
            constraints: [],
            effectiveModel: null,
            effectiveModelSource: "pending",
          },
          status: scenario === "historical" ? "failed" : "running",
          error: scenario === "historical" ? "Earlier provider failure" : null,
          createdAt: now,
          startedAt: now,
          endedAt: scenario === "historical" ? now : null,
          cancelRequestedAt: null,
          reviewSubjectHash: null,
          usage: unknownUsage(),
        },
      ],
    };
    let ended = scenario === "historical";
    const run = () => ({
      id: RunId.make("prepared-run"),
      ordinal: 1,
      status: ended ? (scenario === "continuation-limit" ? "completed" : "failed") : "running",
      modelSelection: selection,
      requestedAt: DateTime.makeUnsafe(now),
      startedAt: DateTime.makeUnsafe(now),
      completedAt: ended ? DateTime.makeUnsafe(now) : null,
    });
    const latestRun = () =>
      scenario === "continuation-limit"
        ? {
            ...run(),
            id: RunId.make("prepared-continuation"),
            ordinal: 2,
            status: ended ? "failed" : "running",
          }
        : run();
    const event = {
      type: "run.updated" as const,
      threadId,
      payload: { ...latestRun(), status: "failed" },
    };
    const events = yield* Queue.unbounded<typeof event>();
    const firstRead = yield* Deferred.make<void>();
    const settled = yield* Deferred.make<void>();
    const retryStarted = yield* Deferred.make<void>();
    const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const deps = Layer.mergeAll(
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        streamDomainEvents: Stream.fromQueue(events),
        isProviderInstanceEnabledForProject: () => Effect.succeed(true),
        getThreadShell: (id: ThreadId) => Effect.succeed({ id, projectId, worktreePath: checkout }),
        getThreadProjection: (id: ThreadId) =>
          Effect.gen(function* () {
            if (id === threadId && !ended) yield* Deferred.succeed(firstRead, undefined);
            return {
              runs:
                id === threadId
                  ? scenario === "continuation-limit"
                    ? [run(), latestRun()]
                    : [run()]
                  : [],
              providerTurns: [],
              messages: [],
              visibleTurnItems: [
                {
                  item: {
                    type: "error",
                    runId: latestRun().id,
                    failure:
                      scenario === "continuation-limit"
                        ? {
                            class: "usage_limit",
                            code: "subscription_limit",
                            retryable: false,
                            message: "Limit reached in the continuation",
                          }
                        : {
                            class: "provider_error",
                            code: "mcp_unavailable",
                            retryable: false,
                            message:
                              "Garrs cannot start while an external MCP server is available to the thread.",
                          },
                  },
                },
              ],
            };
          }),
        sendToThread: () => Effect.succeed({}),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
        launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
          Effect.gen(function* () {
            launches.push(input);
            yield* Deferred.succeed(retryStarted, undefined);
            if (input.workspaceStrategy.type !== "existing_worktree") {
              return yield* new ThreadLaunchService.ThreadLaunchError({
                operation: "provision-worktree",
                commandId: input.commandId,
                projectId,
                cause: "branch_already_exists",
              });
            }
            return {
              threadId: input.threadId!,
              projection: { runs: [], thread: { worktreePath: checkout } },
              resumed: false,
            };
          }),
      } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]),
      Layer.succeed(UsageService.UsageService, {} as UsageService.UsageService["Service"]),
      Layer.succeed(ProjectStore.ProjectStoreV2, {
        get: () => Effect.succeedSome({ workspaceRoot: root, archivedAt: null }),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed(
          [selection, fallback].map((candidate) => ({
            instanceId: candidate.instanceId,
            driver: "codex",
            displayName: "Codex",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            availability: "available",
            status: "ready",
            models: [{ slug: "model", isDefault: true }],
          })),
        ),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      GarrsStore.layer,
    ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* GarrsStore.GarrsStore;
        yield* store.saveBinding(
          0,
          {
            ...defaultProjectBinding(projectId),
            enabled: true,
            autonomy: "auto",
            modelOverrides: [
              {
                agentId: "asta",
                candidates: scenario === "continuation-limit" ? [selection, fallback] : [selection],
                allowFallback: scenario === "continuation-limit",
              },
            ],
          },
          now,
        );
        yield* store.registerThread(
          {
            threadId,
            projectId,
            agentId: "asta",
            attemptId,
            readOnly: true,
            instructions: "",
            configRevision: 0,
          },
          now,
        );
        yield* store.registerThread(
          {
            threadId: workItem.garrasThreadId,
            projectId,
            agentId: "garras",
            attemptId: null,
            readOnly: true,
            instructions: "",
            configRevision: 0,
          },
          now,
        );
        yield* store.commit({ previous: null, next: aggregate, activity: [], effects: [], now });
        const observedStore: GarrsStore.GarrsStore["Service"] = {
          ...store,
          commit: (input) =>
            store
              .commit(input)
              .pipe(
                Effect.tap(() =>
                  input.next.attempts.find((attempt) => attempt.id === attemptId)?.status ===
                  "failed"
                    ? Deferred.succeed(settled, undefined)
                    : Effect.void,
                ),
              ),
        };
        const service = Context.get(
          yield* Layer.build(GarrsService.layer).pipe(
            Effect.provideService(GarrsStore.GarrsStore, observedStore),
          ),
          GarrsService.GarrsService,
        );
        yield* service.start();
        if (scenario !== "historical") {
          yield* Deferred.await(firstRead);
          ended = true;
          if (scenario === "continuation-limit")
            yield* Queue.offer(events, { ...event, payload: { ...run(), status: "completed" } });
          yield* Queue.offer(events, event);
        }
        yield* Deferred.await(settled);
        if (scenario === "provider-failure" || scenario === "continuation-limit") {
          const pending = (yield* store.loadAggregate(workItem.id))!;
          expect(pending.workItem.statusReason).toBeNull();
          expect(pending.tasks[0]?.statusReason).toBeNull();
          expect(pending.attempts).toHaveLength(2);
          yield* Deferred.await(retryStarted);
        }
        yield* service.drain;
        const next = (yield* store.loadAggregate(workItem.id))!;
        const unsafe = scenario === "wrong-repository" || scenario === "wrong-base";
        expect(next.workItem.workspace?.checkoutPath).toBe(unsafe ? null : checkout);
        if (unsafe) {
          expect(next.workItem.status).toBe("blocked");
          expect(next.workItem.statusReason).toContain("checkout");
          expect(launches).toEqual([]);
        } else if (scenario === "provider-failure" || scenario === "continuation-limit") {
          expect(launches).toHaveLength(1);
          expect(launches[0]?.workspaceStrategy).toEqual({
            type: "existing_worktree",
            worktreePath: checkout,
          });
          const status = yield* service.status(
            { threadId: workItem.garrasThreadId },
            { workItemId: workItem.id },
          );
          if (scenario === "continuation-limit") {
            expect(
              next.attempts.find((attempt) => attempt.id === attemptId)?.failure,
            ).toMatchObject({ class: "usage_limit", code: "subscription_limit" });
            expect(launches[0]?.modelSelection).toEqual(fallback);
            expect(yield* store.countEffects(attemptId, "resume_attempt")).toBe(0);
            expect(status.message).toContain("subscription_limit");
          } else {
            expect(status.message).toContain("provider_error");
            expect(status.message).toContain("mcp_unavailable");
            expect(status.message).toContain("external MCP server");
          }
        }
        expect(yield* fs.readFileString(path.join(root, "file"))).toBe("uncommitted user work");
      }).pipe(Effect.provide(deps)),
    );
  }).pipe(
    Effect.provide(
      VcsProcess.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
