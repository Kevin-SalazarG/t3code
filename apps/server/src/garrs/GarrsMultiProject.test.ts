import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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

it.effect(
  "writes in two verified checkouts and reviews their integrated state and corrections",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcs = yield* VcsProcess.VcsProcess;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-multi-write-" });
      const frontId = ProjectId.make("front-write");
      const backId = ProjectId.make("back-write");
      const garras = ThreadId.make("garras:write");
      const roots = new Map([
        [frontId, path.join(temp, "front")],
        [backId, path.join(temp, "back")],
      ]);
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        vcs.run({ operation: "GarrsMultiProject.test", command: "git", cwd, args });
      for (const [id, root] of roots) {
        yield* fs.makeDirectory(root);
        yield* git(root, ["init", "--quiet"]);
        yield* fs.writeFileString(path.join(root, "RULES.md"), `Rules for ${id}`);
        yield* fs.writeFileString(path.join(root, "code.ts"), "base");
        yield* git(root, ["add", "."]);
        yield* git(root, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "-m",
          "base",
        ]);
        yield* fs.writeFileString(path.join(root, "code.ts"), `User's uncommitted ${id}`);
      }
      const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
      const checkouts = new Map<ThreadId, string>();
      const archivedProjects = new Set<ProjectId>();
      const pixiRunning = yield* Deferred.make<void>();
      const releaseBackend = yield* Deferred.make<void>();
      const acceptedMessages: Array<{ threadId: ThreadId; messageId: string; text: string }> = [];
      const deps = Layer.mergeAll(
        Layer.succeed(ThreadManagement.ThreadManagementService, {
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadShell: (threadId: ThreadId) =>
            Effect.succeed({
              projectId: launches.find((entry) => entry.threadId === threadId)?.projectId,
              worktreePath: checkouts.get(threadId) ?? null,
            }),
          getThreadProjection: (threadId: ThreadId) =>
            Effect.succeed({
              messages: acceptedMessages
                .filter((message) => message.threadId === threadId)
                .map((message) => ({ id: message.messageId })),
              providerTurns: [],
              runs: [{ id: `run-${threadId}`, ordinal: 1, status: "completed" }],
            }),
          sendToThread: (input: { threadId: ThreadId; messageId: string; text: string }) =>
            Effect.sync(() => {
              acceptedMessages.push(input);
              return {};
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
          launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
            Effect.gen(function* () {
              launches.push(input);
              const root = roots.get(input.projectId)!;
              const strategy = input.workspaceStrategy;
              if (input.projectId === backId && strategy.type === "worktree")
                yield* Deferred.await(releaseBackend);
              const checkout =
                strategy.type === "existing_worktree"
                  ? strategy.worktreePath
                  : path.join(temp, `checkout-${input.projectId}`);
              if (strategy.type === "worktree") {
                yield* git(root, [
                  "worktree",
                  "add",
                  "--quiet",
                  "--detach",
                  checkout,
                  strategy.baseRef,
                ]);
              } else if (strategy.type !== "existing_worktree") {
                throw new Error("Write work must use an isolated checkout.");
              }
              checkouts.set(input.threadId!, checkout);
              return {
                threadId: input.threadId!,
                projection: { runs: [], thread: { worktreePath: checkout } },
                resumed: false,
              };
            }),
        } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]),
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
          get: (id: ProjectId) =>
            roots.has(id)
              ? Effect.succeedSome({
                  workspaceRoot: roots.get(id)!,
                  archivedAt: archivedProjects.has(id) ? "2026-10-31T12:01:00.000Z" : null,
                })
              : Effect.succeedNone,
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      ).pipe(
        Layer.provideMerge(GarrsStore.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GarrsStore.GarrsStore;
          const selection = { instanceId: ProviderInstanceId.make("codex"), model: "model" };
          for (const id of roots.keys()) {
            yield* store.saveBinding(
              0,
              {
                ...defaultProjectBinding(id),
                enabled: true,
                autonomy: "auto",
                rulePaths: ["RULES.md"],
                linkedProjectIds: id === frontId ? [backId] : [],
                modelOverrides: (["asta", "pixi", "botas", "copito"] as const).map((agentId) => ({
                  agentId,
                  candidates: [selection],
                  allowFallback: false,
                })),
              },
              "2026-10-31T12:00:00.000Z",
            );
          }
          yield* store.registerThread(
            {
              threadId: garras,
              projectId: frontId,
              agentId: "garras",
              attemptId: null,
              readOnly: true,
              instructions: "",
              configRevision: 0,
            },
            "2026-10-31T12:00:00.000Z",
          );
          const observedStore: GarrsStore.GarrsStore["Service"] = {
            ...store,
            commit: (input) =>
              store
                .commit(input)
                .pipe(
                  Effect.tap(() =>
                    input.next.attempts.some(
                      (attempt) => attempt.agentId === "pixi" && attempt.status === "running",
                    )
                      ? Deferred.succeed(pixiRunning, undefined)
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
          const task = (key: string, projectId: ProjectId, agentId: "pixi" | "botas") => ({
            key,
            projectId,
            agentId,
            title: key,
            objective: `Change ${key}`,
            reason: "Owner",
            inputs: [],
            deliverables: ["Code"],
            acceptanceCriteria: [`${key} handles missing input`],
            dependsOn: [],
            capability: "write" as const,
          });
          const started = yield* service.startWork(
            { threadId: garras },
            {
              title: "UI and API",
              objective: "Implement both projects",
              intent: "implement",
              access: "write",
              projectIds: [backId],
              plan: { tasks: [task("ui", frontId, "pixi"), task("api", backId, "botas")] },
            },
          );
          const id = started.workItemId!;
          yield* Deferred.await(pixiRunning);
          const frontRunning = (yield* store.loadAggregate(id))!;
          const pixi = frontRunning.attempts.find((attempt) => attempt.agentId === "pixi")!;
          const backendTask = frontRunning.tasks.find((task) => task.agentId === "botas")!;
          yield* service.sendMessage(
            { threadId: pixi.threadId! },
            {
              workItemId: id,
              to: "botas",
              toTaskId: backendTask.id,
              kind: "question",
              body: "What is the health response contract?",
            },
          );
          const question = (yield* store.loadAggregate(id))!.messages[0]!;
          expect(question.deliveryStatus).toBe("pending");
          const pendingStatus = yield* service.status({ threadId: garras }, { workItemId: id });
          expect(pendingStatus.message).toContain("pixi → botas");
          expect(pendingStatus.message).toContain("pending");
          expect(pendingStatus.message).toContain("What is the health response contract?");
          yield* Deferred.succeed(releaseBackend, undefined);
          yield* service.drain;
          const concurrent = (yield* store.loadAggregate(id))!;
          expect(
            concurrent.attempts
              .filter((attempt) => attempt.status === "running")
              .map((attempt) => attempt.agentId),
          ).toEqual(["pixi", "botas"]);
          expect(concurrent.messages[0]?.deliveryStatus).toBe("queued");
          const botas = concurrent.attempts.find((attempt) => attempt.agentId === "botas")!;
          yield* service.sendMessage(
            { threadId: botas.threadId! },
            {
              to: "pixi",
              kind: "answer",
              replyTo: question.id,
              body: "The response is {status, label}.",
            },
          );
          yield* service.drain;
          const answered = (yield* store.loadAggregate(id))!;
          expect(answered.messages.map((message) => message.deliveryStatus)).toEqual([
            "queued",
            "queued",
          ]);
          expect(
            (yield* service.status({ threadId: garras }, { workItemId: id })).message,
          ).toContain(`replyTo ${question.id}`);
          for (const agentId of ["pixi", "botas"] as const) {
            yield* service.drain;
            const aggregate = (yield* store.loadAggregate(id))!;
            const attempt = aggregate.attempts.find((entry) => entry.agentId === agentId)!;
            expect(attempt.status).toBe("running");
            const checkout = checkouts.get(attempt.threadId!)!;
            expect(yield* fs.readFileString(path.join(checkout, "code.ts"))).toBe("base");
            yield* fs.writeFileString(path.join(checkout, "code.ts"), `${agentId} implementation`);
            yield* service.report(
              { threadId: attempt.threadId! },
              {
                outcome: "done",
                kind: "code_change",
                summary: agentId,
                body: "Implemented",
                evidence: ["Focused checks"],
              },
            );
          }
          yield* service.drain;
          const integrated = (yield* store.loadAggregate(id))!;
          const frontCheckout = integrated.workItem.workspace!.checkoutPath!;
          const backCheckout = integrated.workItem.projectContexts![0]!.workspace.checkoutPath!;
          expect(frontCheckout).not.toBe(backCheckout);
          expect(integrated.workItem.projectContexts![0]!.workspace.isolated).toBe(true);
          const review = integrated.attempts.find((attempt) => attempt.agentId === "copito")!;
          const brief = launches.find((input) => input.threadId === review.threadId)!
            .initialMessage!.text;
          expect(brief).toContain(`Checkout: ${backCheckout}`);
          expect(brief).toContain("ui handles missing input");
          expect(brief).toContain("api handles missing input");
          yield* service.submitReview(
            { threadId: review.threadId! },
            {
              verdict: "changes_requested",
              criteria: [
                {
                  criterion: "api handles missing input",
                  status: "failed",
                  evidence: "Missing guard",
                },
              ],
              findings: [
                {
                  projectId: backId,
                  description: "Handle missing input",
                  impact: "Throws",
                  location: "code.ts",
                  severity: "major",
                  suggestedOwner: "botas",
                  resolutionCondition: "Returns an error",
                },
              ],
            },
          );
          yield* service.drain;
          const correcting = (yield* store.loadAggregate(id))!;
          const correction = correcting.tasks.find((entry) => entry.key.startsWith("fix-"))!;
          expect(correction.projectId).toBe(backId);
          const correctingAttempt = correcting.attempts.find(
            (entry) => entry.taskId === correction.id,
          )!;
          expect(checkouts.get(correctingAttempt.threadId!)).toBe(backCheckout);
          yield* fs.writeFileString(
            path.join(backCheckout, "code.ts"),
            "botas corrected implementation",
          );
          yield* service.report(
            { threadId: correctingAttempt.threadId! },
            {
              outcome: "done",
              kind: "code_change",
              summary: "Corrected",
              body: "Added guard",
              evidence: ["Guard check"],
            },
          );
          yield* service.drain;
          const finalState = (yield* store.loadAggregate(id))!;
          const finalReview = finalState.attempts
            .filter((attempt) => attempt.agentId === "copito")
            .at(-1)!;
          yield* service.submitReview(
            { threadId: finalReview.threadId! },
            {
              verdict: "approved",
              criteria: [
                {
                  criterion: "All acceptance criteria and project rules",
                  status: "verified",
                  evidence: "Both checkouts and rules inspected",
                },
              ],
              findings: [],
            },
          );
          yield* fs.writeFileString(path.join(backCheckout, "code.ts"), "changed after review");
          expect(
            (yield* service.status({ threadId: garras }, { workItemId: id })).message,
          ).toContain("approved (invalidated");
          expect(
            (yield* Effect.flip(
              service.deliver({ threadId: garras }, { workItemId: id, summary: "Old" }),
            )).message,
          ).toContain("Copito");
          const stale = (yield* store.loadAggregate(id))!;
          expect(
            stale.reviews
              .filter((entry) => entry.verdict === "approved")
              .every((entry) => entry.status === "invalidated"),
          ).toBe(true);
          for (const [projectId, root] of roots) {
            expect(yield* fs.readFileString(path.join(root, "code.ts"))).toBe(
              `User's uncommitted ${projectId}`,
            );
          }
          archivedProjects.add(frontId);
          const archived = yield* Effect.flip(
            service.startWork(
              { threadId: garras },
              {
                title: "Unavailable primary",
                objective: "Inspect the archived project",
                intent: "diagnose",
                access: "read_only",
                plan: "asta",
              },
            ),
          );
          expect(archived.message).toContain("unavailable");
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

it.effect(
  "coordinates a read-only frontend and backend diagnosis with per-project rules and review evidence",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcs = yield* VcsProcess.VcsProcess;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-two-projects-" });
      const frontend = path.join(temp, "frontend");
      const backend = path.join(temp, "backend");
      const backendLink = path.join(temp, "backend-link");
      const frontId = ProjectId.make("frontend");
      const backId = ProjectId.make("backend");
      const garras = ThreadId.make("garras:frontend");
      for (const [dir, rule] of [
        [frontend, "FRONT.md"],
        [backend, "BACK.md"],
      ] as const) {
        yield* fs.makeDirectory(dir);
        const git = (args: ReadonlyArray<string>) =>
          vcs.run({ operation: "GarrsMultiProject.test", command: "git", cwd: dir, args });
        yield* git(["init", "--quiet"]);
        yield* fs.writeFileString(path.join(dir, rule), `${rule} rules`);
        yield* fs.writeFileString(path.join(dir, "code.ts"), "initial");
        yield* git(["add", "."]);
        yield* git([
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
      yield* fs.symlink(backend, backendLink);
      yield* fs.writeFileString(path.join(backend, "code.ts"), "existing user change");
      const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
      let failConversation = true;
      let providerAvailable = true;
      let backProviderEnabled = true;
      const threadStub = {
        isProviderInstanceEnabledForProject: (input: { readonly projectId: ProjectId }) =>
          Effect.succeed(input.projectId !== backId || backProviderEnabled),
        getThreadShell: () => Effect.succeed({ worktreePath: null }),
        getThreadProjection: () => Effect.succeed({ messages: [], runs: [], providerTurns: [] }),
        sendToThread: () => Effect.succeed({}),
      } as unknown as ThreadManagement.ThreadManagementService["Service"];
      const launcher = {
        launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
          Effect.gen(function* () {
            launches.push(input);
            if (input.commandId === "conversation-retry" && failConversation) {
              failConversation = false;
              return yield* new ThreadLaunchService.ThreadLaunchError({
                operation: "dispatch-message",
                commandId: input.commandId,
                projectId: input.projectId,
                cause: "temporary",
              });
            }
            return {
              threadId: input.threadId!,
              projection: { runs: [], thread: { worktreePath: null } },
              resumed: false,
            };
          }),
      } as unknown as ThreadLaunchService.ThreadLaunchService["Service"];
      const deps = Layer.mergeAll(
        Layer.succeed(ThreadManagement.ThreadManagementService, threadStub),
        Layer.succeed(ThreadLaunchService.ThreadLaunchService, launcher),
        Layer.succeed(UsageService.UsageService, {} as UsageService.UsageService["Service"]),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.sync(() =>
            providerAvailable
              ? [
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
                ]
              : [],
          ),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
        Layer.succeed(ProjectStore.ProjectStoreV2, {
          get: (id: ProjectId) =>
            id === frontId
              ? Effect.succeedSome({ workspaceRoot: frontend, archivedAt: null })
              : id === backId
                ? Effect.succeedSome({ workspaceRoot: backendLink, archivedAt: null })
                : Effect.succeedNone,
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      ).pipe(
        Layer.provideMerge(GarrsStore.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GarrsStore.GarrsStore;
          const now = "2026-10-31T12:00:00.000Z";
          yield* store.saveBinding(
            0,
            {
              ...defaultProjectBinding(frontId),
              autonomy: "auto_read",
              enabled: true,
              linkedProjectIds: [backId],
              rulePaths: ["FRONT.md"],
              modelOverrides: (["garras", "asta", "pixi", "botas", "copito"] as const).map(
                (agentId) => ({
                  agentId,
                  candidates: [{ instanceId: ProviderInstanceId.make("codex"), model: "model" }],
                  allowFallback: false,
                }),
              ),
            },
            now,
          );
          yield* store.saveBinding(
            0,
            {
              ...defaultProjectBinding(backId),
              enabled: true,
              rulePaths: ["BACK.md"],
              modelOverrides: (["asta", "pixi", "botas", "copito"] as const).map((agentId) => ({
                agentId,
                candidates: [{ instanceId: ProviderInstanceId.make("codex"), model: "model" }],
                allowFallback: false,
              })),
            },
            now,
          );
          yield* store.registerThread(
            {
              threadId: garras,
              projectId: frontId,
              agentId: "garras",
              attemptId: null,
              readOnly: true,
              instructions: "",
              configRevision: 0,
            },
            now,
          );
          const service = Context.get(
            yield* Layer.build(GarrsService.layer),
            GarrsService.GarrsService,
          );
          const conversationInput = {
            commandId: CommandId.make("conversation-retry"),
            projectId: frontId,
          };
          expect((yield* Effect.flip(service.startConversation(conversationInput))).code).toBe(
            "unavailable",
          );
          providerAvailable = false;
          const restarted = Context.get(
            yield* Layer.build(GarrsService.layer),
            GarrsService.GarrsService,
          );
          const conversation = yield* restarted.startConversation(conversationInput);
          expect(conversation.decision.requested.model).toBe("model");
          expect((yield* restarted.startConversation(conversationInput)).threadId).toBe(
            conversation.threadId,
          );
          expect(
            launches
              .filter((entry) => entry.commandId === conversationInput.commandId)
              .map((entry) => entry.threadId),
          ).toEqual([conversation.threadId, conversation.threadId]);
          providerAvailable = true;
          const task = (
            key: string,
            agentId: "pixi" | "botas" | "copito",
            projectId: ProjectId,
            dependsOn: Array<string>,
          ) => ({
            key,
            agentId,
            projectId,
            title: key,
            objective: `Inspect ${key}`,
            reason: "Owner",
            inputs: [],
            deliverables: ["Evidence"],
            acceptanceCriteria: ["Verified"],
            dependsOn,
            capability: "read" as const,
          });
          const startInput = {
            title: "Diagnose both",
            objective: "Investigate the frontend and backend without changes",
            intent: "diagnose" as const,
            access: "read_only" as const,
            projectIds: [backId],
            clientRequestId: "work-retry",
            plan: {
              tasks: [
                task("frontend", "pixi", frontId, []),
                task("backend", "botas", backId, []),
                task("review-diagnosis", "copito", frontId, ["frontend", "backend"]),
              ],
            },
          };
          const started = yield* service.startWork({ threadId: garras }, startInput);
          expect((yield* restarted.startWork({ threadId: garras }, startInput)).workItemId).toBe(
            started.workItemId,
          );
          const id = started.workItemId!;
          yield* service.drain;
          const initial = (yield* store.loadAggregate(id))!;
          expect(initial.workItem.projectContexts?.map((context) => context.projectId)).toEqual([
            backId,
          ]);
          for (const agent of ["pixi", "botas"] as const) {
            const attempt = initial.attempts.find((entry) => entry.agentId === agent)!;
            expect(attempt.status).toBe("running");
            const launch = launches.find((entry) => entry.threadId === attempt.threadId)!;
            expect(launch.projectId).toBe(agent === "pixi" ? frontId : backId);
            expect(launch.initialMessage?.text).toContain(
              agent === "pixi" ? "FRONT.md" : "BACK.md",
            );
            yield* service.report(
              { threadId: attempt.threadId! },
              {
                outcome: "done",
                kind: "diagnosis",
                summary: agent,
                body: "Inspected",
                evidence: ["Read project files"],
              },
            );
            yield* service.drain;
          }
          const reviewing = (yield* store.loadAggregate(id))!;
          const copito = reviewing.attempts.find((entry) => entry.agentId === "copito")!;
          expect(copito.reviewSubjectHash).not.toBeNull();
          expect(
            launches.find((entry) => entry.threadId === copito.threadId)?.initialMessage?.text,
          ).toContain("BACK.md");
          const copitoBrief =
            launches.find((entry) => entry.threadId === copito.threadId)?.initialMessage?.text ??
            "";
          expect(copitoBrief).toContain(`Checkout: ${backendLink}`);
          expect(copitoBrief).toContain("Read each listed rule file in that checkout");
          expect(copitoBrief).toContain("Base commit:");
          yield* fs.writeFileString(path.join(backend, "BACK.md"), "changed backend rule");
          const result = yield* service.submitReview(
            { threadId: copito.threadId! },
            {
              verdict: "approved",
              criteria: [
                {
                  criterion: "Task requirements",
                  status: "verified",
                  evidence: "Checked the integrated result",
                },
              ],
              findings: [],
            },
          );
          expect(result.message).toContain("not counted");
          yield* service.drain;
          expect((yield* store.loadAggregate(id))?.reviews[0]?.status).toBe("invalidated");
          expect(yield* fs.readFileString(path.join(backend, "code.ts"))).toBe(
            "existing user change",
          );
          const afterInvalidation = (yield* store.loadAggregate(id))!;
          expect(
            afterInvalidation.attempts.filter((entry) => entry.agentId === "copito"),
          ).toHaveLength(1);
          const blockedDelivery = yield* Effect.flip(
            service.deliver({ threadId: garras }, { workItemId: id, summary: "Old result" }),
          );
          expect(blockedDelivery.message).toContain("replan");
          yield* fs.writeFileString(path.join(frontend, "code.ts"), "user changed frontend");
          yield* service.revise(
            { threadId: garras },
            { workItemId: id, feedback: "Recheck both projects" },
          );
          yield* service.drain;
          const revised = (yield* store.loadAggregate(id))!;
          expect(revised.workItem.revision).toBe(2);
          expect(
            revised.tasks
              .filter((entry) => entry.key === "frontend" || entry.key === "backend")
              .map((entry) => entry.status),
          ).toEqual(["cancelled", "cancelled"]);
          expect(revised.reviews.every((review) => review.status === "invalidated")).toBe(true);
          expect(revised.artifacts).toHaveLength(2);
          const afterRestart = Context.get(
            yield* Layer.build(GarrsService.layer),
            GarrsService.GarrsService,
          );
          const planner = revised.attempts.filter((entry) => entry.agentId === "asta").at(-1)!;
          const staleDependency = yield* Effect.flip(
            afterRestart.submitPlan(
              { threadId: planner.threadId! },
              {
                summary: "Bad plan",
                risks: [],
                tasks: [task("new-task", "botas", backId, ["backend"])],
              },
            ),
          );
          expect(staleDependency.message).toContain("unknown task");
          yield* afterRestart.submitPlan(
            { threadId: planner.threadId! },
            {
              summary: "Fresh plan",
              risks: [],
              tasks: [
                task("frontend-v2", "pixi", frontId, []),
                task("backend-v2", "botas", backId, []),
                task("review-v2", "copito", frontId, ["frontend-v2", "backend-v2"]),
              ],
            },
          );
          yield* afterRestart.drain;
          const newRun = (yield* store.loadAggregate(id))!;
          for (const key of ["frontend-v2", "backend-v2"]) {
            const nextTask = newRun.tasks.find((entry) => entry.key === key)!;
            const nextAttempt = newRun.attempts.find((entry) => entry.taskId === nextTask.id)!;
            yield* afterRestart.report(
              { threadId: nextAttempt.threadId! },
              {
                outcome: "done",
                kind: "diagnosis",
                summary: key,
                body: "Current result",
                evidence: ["Current state"],
              },
            );
          }
          const oldAttempt = initial.attempts.find((entry) => entry.agentId === "botas")!;
          expect(
            (yield* Effect.flip(
              service.report(
                { threadId: oldAttempt.threadId! },
                { outcome: "done", kind: "diagnosis", summary: "Old", body: "Stale", evidence: [] },
              ),
            )).code,
          ).toBe("conflict");
          const reloaded = (yield* store.loadAggregate(id))!;
          expect(reloaded.workItem.projectContexts?.[0]?.rules[0]?.sha256).not.toBe(
            initial.workItem.projectContexts?.[0]?.rules[0]?.sha256,
          );
          expect(reloaded.artifacts.filter((entry) => entry.summary.endsWith("-v2"))).toHaveLength(
            2,
          );
          backProviderEnabled = false;
          const unavailable = yield* service.startWork(
            { threadId: garras },
            {
              title: "Unavailable backend",
              objective: "Inspect the backend",
              intent: "diagnose",
              access: "read_only",
              projectIds: [backId],
              plan: { tasks: [task("backend-only", "botas", backId, [])] },
            },
          );
          yield* service.drain;
          const blocked = (yield* store.loadAggregate(unavailable.workItemId!))!;
          expect(blocked.attempts).toHaveLength(0);
          expect(blocked.tasks[0]?.statusReason).not.toBeNull();
          const replacement = path.join(temp, "replacement");
          yield* vcs.run({
            operation: "GarrsMultiProject.test.clone",
            command: "git",
            cwd: temp,
            args: ["clone", "--quiet", backend, replacement],
          });
          yield* fs.remove(backendLink);
          yield* fs.symlink(replacement, backendLink);
          const moved = yield* Effect.flip(
            service.revise({ threadId: garras }, { workItemId: id, feedback: "Recheck" }),
          );
          expect(moved.message).toContain("moved or is unavailable");
          const deliveryAfterSwap = yield* Effect.flip(
            service.deliver({ threadId: garras }, { workItemId: id, summary: "Old checkout" }),
          );
          expect(deliveryAfterSwap.message).toContain("checkout changed");
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
