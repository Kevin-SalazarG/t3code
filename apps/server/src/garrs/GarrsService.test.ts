import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { defaultProjectBinding, defaultTeamConfig, deliveryBlockers } from "./GarrsDomain.ts";
import * as GarrsService from "./GarrsService.ts";
import * as GarrsStore from "./GarrsStore.ts";
import * as Subject from "./GarrsSubject.ts";

const projectId = ProjectId.make("project:review");
const garras = ThreadId.make("garras:review");
const now = "2026-10-31T12:00:00.000Z";

it.effect.each([
  "modified",
  "deleted",
  "unreadable",
  "required-policy",
  "explicit-consult",
  "direct-approval",
] as const)("enforces Copito's read-only review for %s", (change) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-service-review-" });
    const rule = path.join(root, "RULES.md");
    const git = (args: ReadonlyArray<string>) =>
      vcs.run({ operation: "GarrsService.test", command: "git", cwd: root, args });
    yield* git(["init", "--quiet"]);
    yield* fs.writeFileString(rule, "original rule\n");
    yield* git(["add", "RULES.md"]);
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
    const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const threadStub = {
      isProviderInstanceEnabledForProject: () => Effect.succeed(true),
      getThreadShell: () => Effect.succeed({ worktreePath: null }),
      sendToThread: () => Effect.succeed({}),
    } as unknown as ThreadManagement.ThreadManagementService["Service"];
    const launcher = {
      launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
        Effect.sync(() => {
          launches.push(input);
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
    ).pipe(Layer.provideMerge(GarrsStore.layer), Layer.provideMerge(SqlitePersistence.layerMemory));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* GarrsStore.GarrsStore;
        if (change === "required-policy") {
          const config = defaultTeamConfig();
          yield* store.saveConfig(
            0,
            { ...config, review: { ...config.review, reviewDiagnoses: true } },
            now,
          );
        }
        yield* store.saveBinding(
          0,
          {
            ...defaultProjectBinding(projectId),
            enabled: true,
            rulePaths: ["RULES.md"],
            modelOverrides: (["garras", "asta", "pixi", "botas", "copito"] as const).map(
              (agentId) => ({
                agentId,
                candidates: [{ instanceId: ProviderInstanceId.make("codex"), model: "model" }],
                allowFallback: false,
              }),
            ),
            autonomy: change === "direct-approval" ? "approve_plan" : "auto_read",
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
        const context = yield* Layer.build(GarrsService.layer);
        const service = Context.get(context, GarrsService.GarrsService);
        const started = yield* service.startWork(
          { threadId: garras },
          {
            title: "Diagnose",
            objective: "Investigate without changes",
            intent: change === "explicit-consult" ? "consult" : "diagnose",
            access: "read_only",
            plan: {
              tasks: [
                {
                  key: "diagnose",
                  agentId: "botas",
                  title: "Diagnose",
                  objective: "Investigate",
                  reason: "Owner",
                  inputs: [],
                  deliverables: ["Diagnosis"],
                  acceptanceCriteria: ["Evidence"],
                  dependsOn: [],
                  capability: "read",
                },
                {
                  key:
                    change === "required-policy"
                      ? "ordinary-audit"
                      : change === "explicit-consult"
                        ? "copito-formal-review"
                        : "review-diagnosis",
                  agentId: change === "required-policy" ? "pixi" : "copito",
                  title: "Review diagnosis",
                  objective: "Review the answer",
                  reason: "Independent review",
                  inputs: [],
                  deliverables: ["Review"],
                  acceptanceCriteria: ["Evidence"],
                  dependsOn: ["diagnose"],
                  capability: "read",
                },
              ],
            },
          },
        );
        const workItemId = started.workItemId!;
        if (change === "direct-approval") {
          expect(started.status).toBe("awaiting_approval");
          yield* service.drain;
          const pending = (yield* store.loadAggregate(workItemId))!;
          expect(pending.attempts).toHaveLength(0);
          expect(launches).toHaveLength(0);
          expect(pending.plans[0]?.status).toBe("awaiting_approval");
          const wrong = yield* Effect.result(
            service.control({
              commandId: CommandId.make("wrong-direct-plan"),
              workItemId,
              action: { type: "approve_plan", planId: "other" as never },
            }),
          );
          expect(wrong._tag).toBe("Failure");
          yield* service.control({
            commandId: CommandId.make("approve-direct-plan"),
            workItemId,
            action: { type: "approve_plan", planId: pending.plans[0]!.id },
          });
        }
        yield* service.drain;
        const afterStart = (yield* store.loadAggregate(workItemId))!;
        const diagnostic = afterStart.attempts.find((attempt) => attempt.agentId === "botas")!;
        expect(diagnostic.status).toBe("running");
        yield* service.report(
          { threadId: diagnostic.threadId! },
          {
            outcome: "done",
            kind: "diagnosis",
            summary: "Diagnosis",
            body: "Evidence",
            evidence: ["Inspected the code"],
          },
        );
        yield* service.drain;
        const reviewing = (yield* store.loadAggregate(workItemId))!;
        const first = reviewing.attempts.find(
          (attempt) => attempt.agentId === (change === "required-policy" ? "pixi" : "copito"),
        )!;
        expect(first.status).toBe("running");
        if (change === "explicit-consult") {
          expect(first.reviewSubjectHash).not.toBeNull();
          const record = yield* store.getThread(first.threadId!);
          expect(record?.instructions).toContain("garrs action submit_review");
          const ordinaryReport = yield* Effect.result(
            service.report(
              { threadId: first.threadId! },
              {
                outcome: "done",
                kind: "diagnosis",
                summary: "Audit",
                body: "Evidence",
                evidence: [],
              },
            ),
          );
          expect(ordinaryReport._tag).toBe("Failure");
          const before = yield* Effect.result(
            service.deliver({ threadId: garras }, { workItemId, summary: "Done" }),
          );
          expect(before._tag).toBe("Failure");
          yield* service.submitReview(
            { threadId: first.threadId! },
            {
              verdict: "approved",
              criteria: [{ criterion: "Evidence", status: "verified", evidence: "Checked" }],
              findings: [],
            },
          );
          const reviewed = (yield* store.loadAggregate(workItemId))!;
          expect(reviewed.reviews[0]).toMatchObject({
            status: "valid",
            subjectHash: first.reviewSubjectHash,
          });
          const delivered = yield* service.deliver(
            { threadId: garras },
            { workItemId, summary: "Reviewed" },
          );
          expect(delivered.status).toBe("delivered");
          return;
        }
        if (change === "required-policy") {
          yield* service.report(
            { threadId: first.threadId! },
            {
              outcome: "done",
              kind: "diagnosis",
              summary: "Ordinary audit",
              body: "Evidence",
              evidence: ["Read the code"],
            },
          );
          const beforeReview = (yield* store.loadAggregate(workItemId))!;
          expect(beforeReview.reviews).toHaveLength(0);
          const detail = yield* service.subscribeWorkItem(workItemId).pipe(Stream.runHead);
          expect(Option.getOrThrow(detail).remaining).toContain(
            "Copito has not approved the current integrated changes.",
          );
          const premature = yield* Effect.result(
            service.deliver({ threadId: garras }, { workItemId, summary: "Done" }),
          );
          expect(premature._tag).toBe("Failure");
          yield* service.drain;
          const formal = (yield* store.loadAggregate(workItemId))!;
          const reviewAttempt = formal.attempts.find(
            (attempt) => attempt.reviewSubjectHash !== null,
          )!;
          expect(reviewAttempt.agentId).toBe("copito");
          yield* service.submitReview(
            { threadId: reviewAttempt.threadId! },
            {
              verdict: "approved",
              criteria: [{ criterion: "Evidence", status: "verified", evidence: "Inspected" }],
              findings: [],
            },
          );
          const approved = (yield* store.loadAggregate(workItemId))!;
          expect(approved.reviews[0]?.status).toBe("valid");
          const delivery = yield* service.deliver(
            { threadId: garras },
            { workItemId, summary: "Reviewed" },
          );
          expect(delivery).toMatchObject({ status: "delivered" });
          const delivered = (yield* store.loadAggregate(workItemId))!;
          const project = yield* service.subscribeProject(projectId).pipe(Stream.runHead);
          expect(
            Option.getOrThrow(project).workItems.find((entry) => entry.id === workItemId),
          ).toMatchObject({
            status: "delivered",
            taskCount: delivered.tasks.length,
            completedTaskCount: delivered.tasks.filter((task) => task.status === "completed")
              .length,
          });
          const sql = yield* SqlClient.SqlClient;
          const conversationRun = JSON.stringify({
            id: "garras-conversation-run",
            threadId: garras,
            ordinal: 1,
            providerInstanceId: "codex",
            modelSelection: { instanceId: "codex", model: "model" },
            providerThreadId: null,
            userMessageId: "garras-message",
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          });
          yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('garras-conversation-run',${garras},1,'codex','completed',${now},${conversationRun})`;
          const usage = yield* service.getUsage({ agentId: "garras" });
          expect(usage.rows).toEqual([]);
          expect(usage.conversations).toMatchObject([
            {
              threadId: garras,
              runId: "garras-conversation-run",
              projectId,
              agentId: "garras",
              effectiveModel: null,
              estimatedCostUsd: null,
              usage: { quality: "unknown", inputTokens: null, providerTurns: null },
            },
          ]);
          expect(usage.conversations?.[0]).not.toHaveProperty("workItemId");
          return;
        }
        expect(first.reviewSubjectHash).not.toBeNull();
        expect(first.reviewSubjectHash).toBe((yield* Subject.subjectOf(reviewing, root)).hash);
        expect(
          launches.find((launch) => launch.threadId === first.threadId)?.initialMessage?.text,
        ).toContain(first.reviewSubjectHash!.slice(0, 16));

        if (change === "modified" || change === "direct-approval")
          yield* fs.writeFileString(rule, "changed rule\n");
        else {
          yield* fs.remove(rule);
          if (change === "unreadable") yield* fs.makeDirectory(rule);
        }
        const current = yield* Subject.subjectOf(reviewing, root);
        expect(current.hash).not.toBe(first.reviewSubjectHash);
        const result = yield* service.submitReview(
          { threadId: first.threadId! },
          {
            verdict: "changes_requested",
            criteria: [{ criterion: "Evidence", status: "failed", evidence: "Problem" }],
            findings: [
              {
                description: "Finding",
                impact: "Impact",
                location: "test",
                severity: "major",
                suggestedOwner: "botas",
                resolutionCondition: "Fixed",
              },
            ],
          },
        );
        expect(result.message).toContain("not counted");
        yield* service.drain;
        const invalidated = (yield* store.loadAggregate(workItemId))!;
        expect(invalidated.reviews[0]).toMatchObject({
          subjectHash: first.reviewSubjectHash,
          status: "invalidated",
        });
        expect(invalidated.workItem.correctionCycles).toBe(0);
        expect(invalidated.tasks.some((task) => task.key.startsWith("fix-"))).toBe(false);
        expect(deliveryBlockers(invalidated, true, current.hash).length).toBeGreaterThan(0);
        const attempts = invalidated.attempts.filter((attempt) => attempt.agentId === "copito");
        if (change === "unreadable") {
          expect(current.hash).toBeNull();
          expect(attempts).toHaveLength(1);
          expect(invalidated.workItem.status).toBe("blocked");
          expect(invalidated.workItem.statusReason).toContain("review state is unavailable");
        } else {
          expect(attempts).toHaveLength(2);
          expect(attempts[1]?.reviewSubjectHash).toBe(current.hash);
        }
        expect(
          (yield* store.listActivity(workItemId, 100)).some(
            (event) => event.type === "review.invalidated",
          ),
        ).toBe(true);
        const delivery = yield* Effect.result(
          service.deliver({ threadId: garras }, { workItemId, summary: "Done" }),
        );
        expect(delivery._tag).toBe("Failure");
        if (change === "modified") {
          yield* service.submitReview(
            { threadId: attempts[1]!.threadId! },
            {
              verdict: "approved",
              criteria: [{ criterion: "Evidence", status: "verified", evidence: "Inspected" }],
              findings: [],
            },
          );
          const approved = (yield* store.loadAggregate(workItemId))!;
          expect(approved.reviews.at(-1)).toMatchObject({
            status: "valid",
            subjectHash: current.hash,
          });
          expect(
            yield* service.deliver({ threadId: garras }, { workItemId, summary: "Reviewed" }),
          ).toMatchObject({ status: "delivered" });
        }
        if (change === "unreadable") {
          yield* fs.remove(rule, { recursive: true });
          yield* fs.writeFileString(rule, "restored rule\n");
          yield* service.control({
            commandId: CommandId.make("retry-after-restoring-rule"),
            workItemId,
            action: { type: "resume" },
          });
          yield* service.drain;
          const restored = (yield* store.loadAggregate(workItemId))!;
          const retried = restored.attempts.filter((attempt) => attempt.agentId === "copito");
          expect(retried).toHaveLength(2);
          expect(retried[1]?.reviewSubjectHash).toBe(
            (yield* Subject.subjectOf(restored, root)).hash,
          );
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
