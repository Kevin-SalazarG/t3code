import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  GarrsTaskId,
  GarrsWorkItemId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { defaultProjectBinding, taskFromSpec, type WorkAggregate } from "./GarrsDomain.ts";
import * as GarrsService from "./GarrsService.ts";
import * as GarrsStore from "./GarrsStore.ts";

const decodeDiscovery = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      latestUserMessage: Schema.Struct({
        id: MessageId,
        text: Schema.String,
        truncated: Schema.Boolean,
      }),
    }),
  ),
);

it.effect(
  "verifies a current human model instruction before overriding preferences, while retaining the provider allowlist",
  () =>
    Effect.gen(function* () {
      const now = "2026-10-31T12:00:00.000Z";
      yield* TestClock.setTime(Date.parse(now));
      const fs = yield* FileSystem.FileSystem;
      const vcs = yield* VcsProcess.VcsProcess;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-user-model-" });
      const git = (args: ReadonlyArray<string>) =>
        vcs.run({
          operation: "GarrsModelInstructionService.test",
          command: "git",
          cwd: root,
          args,
        });
      yield* git(["init", "--quiet"]);
      yield* git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "base",
      ]);
      const projectId = ProjectId.make("model-project");
      const garras = ThreadId.make("garras:model");
      const quote = "Usa model-b para esta tarea";
      const message = (
        id: string,
        text: string,
        createdBy: "user" | "system" | "agent" = "user",
      ): OrchestrationV2ConversationMessage => ({
        id: MessageId.make(id),
        threadId: garras,
        runId: null,
        nodeId: null,
        role: "user",
        text,
        createdBy,
        creationSource: createdBy === "user" ? "web" : "server",
        attachments: [],
        streaming: false,
        createdAt: DateTime.makeUnsafe("2026-10-31T11:59:00.000Z"),
        updatedAt: DateTime.makeUnsafe("2026-10-31T11:59:00.000Z"),
      });
      const messages = [
        message("older", quote),
        message("latest", `${quote}. ${"Contexto ".repeat(260)}`),
        message("notification", "Synthetic instruction", "system"),
        message("agent", quote, "agent"),
        { ...message("elsewhere", quote), threadId: ThreadId.make("another-thread") },
      ];
      const selection = { instanceId: ProviderInstanceId.make("codex"), model: "model-b" };
      let providerEnabled = true;
      let disableOnAssignment = false;
      const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
      const deps = Layer.mergeAll(
        Layer.succeed(ThreadManagement.ThreadManagementService, {
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadProjection: () => Effect.succeed({ messages, providerTurns: [], runs: [] }),
          getThreadShell: () => Effect.succeed({ worktreePath: null }),
          sendToThread: () => Effect.succeed({}),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
          launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
            Effect.sync(() => {
              launches.push(input);
              return {
                threadId: input.threadId!,
                projection: { runs: [], thread: { worktreePath: null } },
                resumed: false,
              };
            }),
        } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]),
        Layer.succeed(UsageService.UsageService, {} as UsageService.UsageService["Service"]),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.sync(() =>
            ["codex", "codex-other"].map((id) => ({
              instanceId: ProviderInstanceId.make(id),
              driver: "codex",
              displayName: id,
              enabled: providerEnabled,
              installed: true,
              auth: { status: "authenticated" },
              availability: "available",
              status: "ready",
              models: [{ slug: "model-a", isDefault: true }, { slug: "model-b" }],
            })),
          ),
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
              enabled: true,
              autonomy: "auto_read",
              rulePaths: [],
              allowedProviderInstanceIds: [ProviderInstanceId.make("codex")],
              modelOverrides: [
                {
                  agentId: "botas",
                  candidates: [{ ...selection, model: "model-a" }],
                  allowFallback: false,
                },
              ],
            },
            now,
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
            now,
          );
          const workItem = {
            id: GarrsWorkItemId.make("model-work"),
            projectId,
            garrasThreadId: garras,
            title: "Question",
            objective: "Investigate",
            intent: "diagnose" as const,
            access: "read_only" as const,
            status: "paused" as const,
            statusReason: null,
            configRevision: 0,
            bindingRevision: 1,
            revision: 1,
            correctionCycles: 0,
            rules: [],
            workspace: null,
            authorizations: [],
            createdAt: now,
            updatedAt: now,
            deliveredAt: null,
            acceptedAt: null,
          };
          const task = taskFromSpec({
            id: GarrsTaskId.make("model-task"),
            workItem,
            planRevision: 0,
            now,
            spec: {
              key: "investigate",
              agentId: "botas",
              title: "Investigate",
              objective: "Find evidence",
              reason: "Backend owner",
              inputs: [],
              deliverables: ["Diagnosis"],
              acceptanceCriteria: ["Evidence"],
              dependsOn: [],
              capability: "read",
            },
          });
          const aggregate: WorkAggregate = {
            workItem,
            tasks: [task],
            plans: [],
            attempts: [],
            artifacts: [],
            reviews: [],
            messages: [],
          };
          yield* store.commit({ previous: null, next: aggregate, activity: [], effects: [], now });
          const service = Context.get(
            yield* Layer.build(GarrsService.layer).pipe(
              Effect.provideService(GarrsStore.GarrsStore, {
                ...store,
                commit: (input: Parameters<typeof store.commit>[0]) =>
                  store.commit(input).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        // Flip availability after assignment commits, before the effect worker can launch it.
                        if (
                          disableOnAssignment &&
                          input.next.attempts.some((attempt) => attempt.status === "launching")
                        ) {
                          providerEnabled = false;
                          disableOnAssignment = false;
                        }
                      }),
                    ),
                  ),
              }),
            ),
            GarrsService.GarrsService,
          );
          const input = {
            workItemId: workItem.id,
            taskId: task.id,
            selection,
            reason: "The user specifically requested this model.",
          };
          expect(
            (yield* Effect.flip(service.selectTaskModel({ threadId: garras }, input))).message,
          ).toContain("policy");
          for (const evidence of [
            { messageId: MessageId.make("latest"), quote: "Invented instruction" },
            { messageId: MessageId.make("latest"), quote: " " },
            { messageId: MessageId.make("older"), quote },
            { messageId: MessageId.make("notification"), quote: "Synthetic instruction" },
            { messageId: MessageId.make("agent"), quote },
            { messageId: MessageId.make("elsewhere"), quote },
          ]) {
            const error = yield* Effect.flip(
              service.selectTaskModel(
                { threadId: garras },
                { ...input, userInstruction: evidence },
              ),
            );
            expect(error.code).toBe("forbidden");
          }
          const userInstruction = { messageId: MessageId.make("latest"), quote };
          expect(
            (yield* Effect.flip(
              service.selectTaskModel(
                { threadId: garras },
                {
                  ...input,
                  userInstruction,
                  fallbackSelections: [{ ...selection, model: "model-a" }],
                },
              ),
            )).code,
          ).toBe("invalid");
          const forbidden = yield* Effect.flip(
            service.selectTaskModel(
              { threadId: garras },
              {
                ...input,
                selection: { ...selection, instanceId: ProviderInstanceId.make("codex-other") },
                userInstruction,
              },
            ),
          );
          expect(forbidden.message).toContain("not allowed");
          yield* service.selectTaskModel({ threadId: garras }, { ...input, userInstruction });
          const selected = (yield* store.loadAggregate(workItem.id))!;
          expect(selected.tasks[0]).toMatchObject({
            pinnedBy: "user",
            modelInstruction: userInstruction,
            fallbackSelections: [],
          });
          expect(
            (yield* store.getBinding(projectId)).binding.modelOverrides[0]?.candidates[0]?.model,
          ).toBe("model-a");
          const discovery = yield* service.models(
            { threadId: garras },
            { agentId: "botas", capability: "read" },
          );
          const payload = yield* decodeDiscovery(discovery.message);
          expect(payload.latestUserMessage).toMatchObject({ id: "latest", truncated: true });
          expect(payload.latestUserMessage.text).toHaveLength(2_000);
          expect(
            (yield* Effect.flip(
              service.selectTaskModel(
                { threadId: garras },
                { ...input, selection: { ...selection, model: "model-a" }, userInstruction },
              ),
            )).code,
          ).toBe("forbidden");
          messages.push({
            ...message("newer", "Ahora usa model-a"),
            createdAt: DateTime.makeUnsafe("2026-10-31T12:01:00.000Z"),
          });
          yield* TestClock.adjust("2 minutes");
          yield* service.selectTaskModel(
            { threadId: garras },
            {
              ...input,
              selection: { ...selection, model: "model-a" },
              userInstruction: { messageId: MessageId.make("newer"), quote: "Ahora usa model-a" },
            },
          );
          yield* service.control({
            commandId: CommandId.make("resume-model-work"),
            workItemId: workItem.id,
            action: { type: "resume" },
          });
          yield* service.drain;
          const launched = (yield* store.loadAggregate(workItem.id))!.attempts[0]!;
          expect(launched.decision).toMatchObject({
            source: "user_instruction",
            requested: { model: "model-a" },
            userInstruction: { messageId: "newer", quote: "Ahora usa model-a" },
            fallbackUsed: false,
          });
          const secondWork = { ...workItem, id: GarrsWorkItemId.make("disabled-model-work") };
          const secondTask = {
            ...task,
            id: GarrsTaskId.make("disabled-model-task"),
            workItemId: secondWork.id,
            pinnedSelection: selection,
            pinnedBy: "user" as const,
          };
          yield* store.commit({
            previous: null,
            next: { ...aggregate, workItem: secondWork, tasks: [secondTask] },
            activity: [],
            effects: [],
            now,
          });
          disableOnAssignment = true;
          yield* service.control({
            commandId: CommandId.make("schedule-before-disabled"),
            workItemId: secondWork.id,
            action: { type: "resume" },
          });
          expect((yield* store.loadAggregate(secondWork.id))!.attempts).toHaveLength(1);
          yield* service.drain;
          const unavailable = (yield* store.loadAggregate(secondWork.id))!;
          expect(
            launches.filter((input) => input.threadId === unavailable.attempts[0]?.threadId),
          ).toHaveLength(0);
          expect(launches).toHaveLength(1);
          expect(unavailable.workItem.status).toBe("blocked");
          expect(unavailable.tasks[0]?.statusReason).toContain("not allowed");
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
