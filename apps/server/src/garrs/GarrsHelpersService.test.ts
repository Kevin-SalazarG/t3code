import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { defaultProjectBinding } from "./GarrsDomain.ts";
import * as GarrsService from "./GarrsService.ts";
import * as GarrsStore from "./GarrsStore.ts";

it.effect.each(["botas", "asta", "copito"] as const)(
  "runs a temporary helper for %s and queues its result once",
  (agentId) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const vcs = yield* VcsProcess.VcsProcess;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-helper-service-" });
      const git = (args: ReadonlyArray<string>) =>
        vcs.run({ operation: "GarrsHelpersService.test", command: "git", cwd: root, args });
      yield* git(["init", "--quiet"]);
      yield* git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "base",
      ]);
      const projectId = ProjectId.make("project:helper");
      const garras = ThreadId.make("garras:helper");
      const sent: Array<{ threadId: ThreadId; messageId: string; text: string }> = [];
      const threadStub = {
        isProviderInstanceEnabledForProject: () => Effect.succeed(true),
        getThreadShell: () => Effect.succeed({ worktreePath: null }),
        getThreadProjection: (threadId: ThreadId) =>
          Effect.succeed({
            messages: sent
              .filter((entry) => entry.threadId === threadId)
              .map((entry) => ({ id: entry.messageId })),
          }),
        sendToThread: (input: { threadId: ThreadId; messageId: string; text: string }) =>
          Effect.sync(() => {
            sent.push(input);
            return {};
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"];
      const launcher = {
        launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
          Effect.succeed({
            threadId: input.threadId!,
            projection: { runs: [], thread: { worktreePath: null } },
            resumed: false,
          }),
      } as unknown as ThreadLaunchService.ThreadLaunchService["Service"];
      const deps = Layer.mergeAll(
        Layer.succeed(ThreadManagement.ThreadManagementService, threadStub),
        Layer.succeed(ThreadLaunchService.ThreadLaunchService, launcher),
        Layer.succeed(UsageService.UsageService, {} as UsageService.UsageService["Service"]),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: "codex",
              displayName: "Codex",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              availability: "available",
              status: "ready",
              models: [{ slug: "model", isDefault: true }],
            },
          ]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
        Layer.succeed(ProjectStore.ProjectStoreV2, {
          get: () => Effect.succeedSome({ workspaceRoot: root }),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      ).pipe(
        Layer.provideMerge(GarrsStore.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GarrsStore.GarrsStore;
          yield* store.saveBinding(
            0,
            {
              ...defaultProjectBinding(projectId),
              autonomy: "auto_read",
              enabled: true,
              rulePaths: [],
              modelOverrides: (["asta", "pixi", "botas", "copito"] as const).map((agentId) => ({
                agentId,
                candidates: [{ instanceId: ProviderInstanceId.make("codex"), model: "model" }],
                allowFallback: false,
              })),
            },
            "2026-10-31T12:00:00.000Z",
          );
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
            "2026-10-31T12:00:00.000Z",
          );
          const context = yield* Layer.build(GarrsService.layer);
          const service = Context.get(context, GarrsService.GarrsService);
          const started = yield* service.startWork(
            { threadId: garras },
            {
              title: "Diagnose",
              objective: "Find the cause without edits",
              intent: "diagnose",
              access: "read_only",
              plan: {
                tasks: [
                  {
                    key:
                      agentId === "asta"
                        ? "plan-1"
                        : agentId === "copito"
                          ? "review-1"
                          : "diagnose",
                    agentId,
                    title: "Diagnose",
                    objective: "Find cause",
                    reason: "Owner",
                    inputs: [],
                    deliverables: ["Diagnosis"],
                    acceptanceCriteria: ["Evidence"],
                    dependsOn: [],
                    capability: "read",
                  },
                ],
              },
            },
          );
          const workItemId = started.workItemId!;
          yield* service.drain;
          const initial = (yield* store.loadAggregate(workItemId))!;
          const owner = initial.attempts[0]!;
          expect(owner.status).toBe("running");
          const request = {
            objective: "Inspect the error path",
            reason: "An independent check of the error path is needed",
            minutes: 5,
            clientRequestId: "request-1",
          };
          yield* service.requestHelper({ threadId: owner.threadId! }, request);
          yield* service.requestHelper({ threadId: owner.threadId! }, request);
          yield* service.drain;
          const running = (yield* store.loadAggregate(workItemId))!;
          const helperTask = running.tasks.find((task) => task.helper !== undefined)!;
          const helper = running.attempts.find((attempt) => attempt.taskId === helperTask.id)!;
          expect(running.tasks.filter((task) => task.helper !== undefined)).toHaveLength(1);
          expect(helperTask.helper?.parentAttemptId).toBe(owner.id);
          expect(helper.readOnlyEnforced).toBe(true);
          expect(helper.status).toBe("running");
          yield* service.report(
            { threadId: helper.threadId! },
            {
              outcome: "done",
              kind: "diagnosis",
              summary: "Found issue",
              body: "The call has no error handler.",
              evidence: ["Inspected the call"],
            },
          );
          yield* service.drain;
          const completed = (yield* store.loadAggregate(workItemId))!;
          expect(completed.tasks.find((task) => task.id === owner.taskId)?.status).toBe("running");
          const delivered = sent.filter(
            (entry) =>
              entry.threadId === owner.threadId &&
              entry.messageId.includes(`helper:${helperTask.id}`),
          );
          expect(delivered).toHaveLength(1);
          expect(delivered[0]!.text).toContain("Found issue");
          expect(
            completed.artifacts.find((artifact) => artifact.taskId === helperTask.id)?.attemptId,
          ).toBe(helper.id);
          if (agentId === "copito") {
            yield* service.submitReview(
              { threadId: owner.threadId! },
              { verdict: "approved", criteria: [], findings: [] },
            );
            const reviewed = (yield* store.loadAggregate(workItemId))!;
            expect(reviewed.reviews[0]?.status).toBe("valid");
          }
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
