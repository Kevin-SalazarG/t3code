import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  GarrsAttemptId,
  GarrsArtifactId,
  GarrsReviewId,
  GarrsTaskId,
  GarrsWorkItemId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { taskFromSpec, unknownUsage, type WorkAggregate } from "./GarrsDomain.ts";
import * as GarrsService from "./GarrsService.ts";
import * as GarrsStore from "./GarrsStore.ts";
import * as Subject from "./GarrsSubject.ts";

it.effect("persists a reviewed commit proposal and approves only its unchanged tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-commit-service-" });
    const root = path.join(dir, "project");
    const checkout = path.join(dir, "checkout");
    yield* fs.makeDirectory(root);
    const gitAt = (cwd: string, args: ReadonlyArray<string>) =>
      vcs.run({ operation: "GarrsCommitService.test", command: "git", cwd, args });
    yield* gitAt(root, ["init", "--quiet", "--initial-branch=main"]);
    yield* gitAt(root, ["config", "user.name", "Test"]);
    yield* gitAt(root, ["config", "user.email", "test@example.com"]);
    yield* fs.writeFileString(path.join(root, "file"), "base");
    yield* fs.writeFileString(path.join(root, "RULES.md"), "original rule");
    yield* gitAt(root, ["add", "file", "RULES.md"]);
    yield* gitAt(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "base",
    ]);
    yield* gitAt(root, ["worktree", "add", "--quiet", "-b", "feature", checkout]);
    const git = (args: ReadonlyArray<string>) => gitAt(checkout, args);
    const file = path.join(checkout, "file");
    const head = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
    yield* fs.writeFileString(file, "reviewed");
    yield* git(["add", "file"]);
    const now = "2026-10-31T12:00:00.000Z";
    const projectId = ProjectId.make("project");
    const workItemId = GarrsWorkItemId.make("work");
    const attemptId = GarrsAttemptId.make("attempt");
    const threadId = ThreadId.make("garrs:kex");
    const workItem = {
      id: workItemId,
      projectId,
      garrasThreadId: ThreadId.make("garras"),
      title: "Work",
      objective: "Change",
      intent: "implement" as const,
      access: "write" as const,
      status: "active" as const,
      statusReason: null,
      configRevision: 0,
      bindingRevision: 0,
      revision: 1,
      correctionCycles: 0,
      rules: yield* Subject.readRules(root, ["RULES.md"]),
      workspace: { projectId, checkoutPath: checkout, isolated: true, baseSha: head },
      authorizations: [],
      createdAt: now,
      updatedAt: now,
      deliveredAt: null,
      acceptedAt: null,
    };
    const task = taskFromSpec({
      id: GarrsTaskId.make("task"),
      workItem,
      planRevision: 1,
      now,
      spec: {
        key: "prepare",
        agentId: "kex",
        title: "Prepare",
        objective: "Propose",
        reason: "Git",
        inputs: [],
        deliverables: ["Proposal"],
        acceptanceCriteria: ["Reviewed"],
        dependsOn: [],
        capability: "read",
      },
    });
    const writer = taskFromSpec({
      id: GarrsTaskId.make("writer"),
      workItem,
      planRevision: 1,
      now,
      spec: {
        key: "edit",
        agentId: "botas",
        title: "Edit",
        objective: "Change file",
        reason: "Backend",
        inputs: [],
        deliverables: ["Change"],
        acceptanceCriteria: ["Works"],
        dependsOn: [],
        capability: "write",
      },
    });
    const aggregate: WorkAggregate = {
      workItem,
      plans: [],
      tasks: [
        { ...writer, status: "completed" },
        { ...task, status: "running" },
      ],
      attempts: [
        {
          id: attemptId,
          taskId: task.id,
          workItemId,
          agentId: "kex",
          generation: 0,
          threadId,
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
          createdAt: now,
          startedAt: now,
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
    const subject = yield* Subject.subjectOf(aggregate, root);
    expect(subject.hash).not.toBeNull();
    const reviewed: WorkAggregate = {
      ...aggregate,
      reviews: [
        {
          id: GarrsReviewId.make("review"),
          workItemId,
          taskId: GarrsTaskId.make("review-task"),
          attemptId: GarrsAttemptId.make("review-attempt"),
          subjectHash: subject.hash!,
          verdict: "approved",
          criteria: [{ criterion: "Works", status: "verified", evidence: "checked" }],
          findings: [],
          status: "valid",
          invalidatedReason: null,
          createdAt: now,
        },
      ],
    };
    const sent: string[] = [];
    const deps = Layer.mergeAll(
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        sendToThread: (input: { text: string }) =>
          Effect.sync(() => {
            sent.push(input.text);
            return {};
          }),
        getThreadShell: () => Effect.succeed({ projectId, worktreePath: checkout }),
        getThreadProjection: () =>
          Effect.succeed({
            messages: [
              {
                id: "push-request",
                threadId: ThreadId.make("garras"),
                role: "user",
                createdBy: "user",
                text: "Push the reviewed commit to origin/reviewed.",
              },
            ],
          }),
        streamDomainEvents: Stream.never,
        isProviderInstanceEnabledForProject: () => Effect.succeed(true),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(
        ThreadLaunchService.ThreadLaunchService,
        {} as ThreadLaunchService.ThreadLaunchService["Service"],
      ),
      Layer.succeed(UsageService.UsageService, {} as UsageService.UsageService["Service"]),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      Layer.succeed(ProjectStore.ProjectStoreV2, {
        get: () => Effect.succeedSome({ workspaceRoot: root }),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    ).pipe(Layer.provideMerge(GarrsStore.layer), Layer.provideMerge(SqlitePersistence.layerMemory));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* GarrsStore.GarrsStore;
        yield* store.commit({ previous: null, next: reviewed, activity: [], effects: [], now });
        yield* store.registerThread(
          {
            threadId,
            projectId,
            agentId: "kex",
            attemptId,
            readOnly: true,
            instructions: "",
            configRevision: 0,
          },
          now,
        );
        const garras = ThreadId.make("garras");
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
        const automaticFile = path.join(checkout, "automatic-file");
        yield* fs.writeFileString(automaticFile, "stage this automatically");
        yield* store.commit({
          previous: reviewed,
          next: {
            ...reviewed,
            workItem: {
              ...reviewed.workItem,
              status: "paused",
              commitPreparation: {
                taskId: task.id,
                status: "pending",
                subjectHash: subject.hash,
                reason: null,
              },
            },
            tasks: reviewed.tasks.map((entry) =>
              entry.id === task.id ? { ...entry, status: "ready" as const } : entry,
            ),
            attempts: [],
            reviews: [],
          },
          activity: [],
          effects: [
            { id: "prepare-while-paused", effect: { kind: "prepare_commit", taskId: task.id } },
          ],
          now,
        });
        yield* service.control({
          commandId: CommandId.make("pause-before-prepare"),
          workItemId,
          action: { type: "pause" },
        });
        yield* service.drain;
        const pausedPreparation = (yield* store.loadAggregate(workItemId))!;
        expect(pausedPreparation.workItem.status).toBe("paused");
        expect(pausedPreparation.workItem.commitPreparation?.status).toBe("failed");
        expect((yield* git(["diff", "--cached", "--name-only"])).stdout).not.toContain(
          "automatic-file",
        );
        yield* service.control({
          commandId: CommandId.make("resume-prepare"),
          workItemId,
          action: { type: "resume" },
        });
        yield* service.drain;
        const automaticallyStaged = (yield* store.loadAggregate(workItemId))!;
        expect(automaticallyStaged.workItem.commitPreparation?.status).toBe("prepared");
        expect((yield* git(["diff", "--cached", "--name-only"])).stdout).toContain(
          "automatic-file",
        );
        expect((yield* git(["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
        yield* git(["reset", "--quiet", "HEAD", "--", "automatic-file"]);
        yield* fs.remove(automaticFile);
        yield* store.commit({
          previous: automaticallyStaged,
          next: reviewed,
          activity: [],
          effects: [],
          now,
        });
        const newFile = path.join(checkout, "new-file");
        yield* fs.writeFileString(newFile, "new content");
        const beforeStage = yield* Subject.subjectOf(reviewed, root);
        const withUntrackedReview = {
          ...reviewed,
          reviews: reviewed.reviews.map((review) => ({
            ...review,
            subjectHash: beforeStage.hash!,
          })),
        };
        yield* store.commit({
          previous: reviewed,
          next: withUntrackedReview,
          activity: [],
          effects: [],
          now,
        });
        yield* git(["add", "new-file"]);
        const retry = yield* service.proposeCommit(
          { threadId },
          { message: "fix: reviewed change" },
        );
        expect(retry.message).toContain("review");
        const afterStaging = (yield* store.loadAggregate(workItemId))!;
        expect(afterStaging.reviews[0]?.status).toBe("invalidated");
        expect(afterStaging.workItem.correctionCycles).toBe(0);
        expect(afterStaging.tasks.find((entry) => entry.id === task.id)?.status).toBe(
          "waiting_response",
        );
        expect(
          afterStaging.tasks.some(
            (entry) => entry.agentId === "copito" && entry.status !== "completed",
          ),
        ).toBe(true);
        yield* git(["reset", "--quiet", "HEAD", "--", "new-file"]);
        yield* fs.remove(newFile);
        yield* store.commit({
          previous: afterStaging,
          next: reviewed,
          activity: [],
          effects: [],
          now,
        });
        yield* store.commit({
          previous: reviewed,
          next: {
            ...reviewed,
            attempts: reviewed.attempts.map((entry) => ({
              ...entry,
              status: "cancel_requested" as const,
            })),
          },
          activity: [],
          effects: [],
          now,
        });
        const stoppedProposal = yield* Effect.result(
          service.proposeCommit({ threadId }, { message: "fix: reviewed change" }),
        );
        expect(stoppedProposal._tag).toBe("Failure");
        const stopped = (yield* store.loadAggregate(workItemId))!;
        yield* store.commit({ previous: stopped, next: reviewed, activity: [], effects: [], now });
        yield* service.proposeCommit({ threadId }, { message: "fix: reviewed change" });
        const afterProposal = (yield* store.loadAggregate(workItemId))!;
        const proposed = afterProposal.workItem.commitProposal!;
        expect(proposed).toMatchObject({
          branchRef: "refs/heads/feature",
          parentSha: head,
          reviewSubjectHash: subject.hash,
          status: "proposed",
        });
        yield* store.commit({
          previous: afterProposal,
          next: {
            ...afterProposal,
            attempts: afterProposal.attempts.map((entry) => ({
              ...entry,
              status: "cancel_requested" as const,
            })),
          },
          activity: [],
          effects: [],
          now,
        });
        const stoppedApproval = yield* Effect.result(
          service.control({
            commandId: CommandId.make("stopped"),
            workItemId,
            action: { type: "approve_commit", proposalId: proposed.id },
          }),
        );
        expect(stoppedApproval._tag).toBe("Failure");
        const afterStop = (yield* store.loadAggregate(workItemId))!;
        yield* store.commit({
          previous: afterStop,
          next: afterProposal,
          activity: [],
          effects: [],
          now,
        });
        const wrong = yield* Effect.result(
          service.control({
            commandId: CommandId.make("wrong"),
            workItemId,
            action: { type: "approve_commit", proposalId: "old" },
          }),
        );
        expect(wrong._tag).toBe("Failure");
        yield* git(["reset", "--quiet", "HEAD", "--", "file"]);
        const unstaged = yield* service.control({
          commandId: CommandId.make("unstaged"),
          workItemId,
          action: { type: "approve_commit", proposalId: proposed.id },
        });
        expect(unstaged.effect).toContain("not approved");
        const afterUnstage = (yield* store.loadAggregate(workItemId))!;
        expect(afterUnstage.workItem.commitProposal?.status).toBe("failed");
        expect(afterUnstage.tasks.find((entry) => entry.id === task.id)?.status).toBe("running");
        expect(afterUnstage.reviews[0]?.status).toBe("valid");
        yield* git(["add", "file"]);
        yield* store.commit({
          previous: afterUnstage,
          next: afterProposal,
          activity: [],
          effects: [],
          now,
        });
        yield* fs.writeFileString(file, "different");
        yield* git(["add", "file"]);
        const stale = yield* service.control({
          commandId: CommandId.make("stale"),
          workItemId,
          action: { type: "approve_commit", proposalId: proposed.id },
        });
        expect(stale.effect).toContain("not approved");
        const afterStale = (yield* store.loadAggregate(workItemId))!;
        expect(afterStale.workItem.commitProposal?.status).toBe("failed");
        expect(afterStale.reviews[0]?.status).toBe("invalidated");
        expect(afterStale.workItem.correctionCycles).toBe(0);
        expect(afterStale.tasks.find((entry) => entry.id === task.id)?.statusReason).toContain(
          "Copito",
        );
        expect(
          afterStale.tasks.some(
            (entry) => entry.agentId === "copito" && entry.status !== "completed",
          ),
        ).toBe(true);
        expect((yield* git(["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
        yield* fs.writeFileString(file, "reviewed");
        yield* git(["add", "file"]);
        yield* store.commit({
          previous: afterStale,
          next: afterProposal,
          activity: [],
          effects: [],
          now,
        });
        const approved = yield* service.control({
          commandId: CommandId.make("approve"),
          workItemId,
          action: { type: "approve_commit", proposalId: proposed.id },
        });
        expect(approved.workItem.commitProposal).toMatchObject({
          id: proposed.id,
          status: "approved",
        });
        yield* service.drain;
        const completed = (yield* store.loadAggregate(workItemId))!.workItem.commitProposal!;
        const committedState = (yield* store.loadAggregate(workItemId))!;
        expect((yield* Subject.subjectOf(committedState, root)).hash).toBe(
          proposed.reviewSubjectHash,
        );
        expect(committedState.reviews[0]?.status).toBe("valid");
        yield* fs.writeFileString(file, "changed after commit");
        expect((yield* Subject.subjectOf(committedState, root)).hash).not.toBe(
          proposed.reviewSubjectHash,
        );
        yield* fs.writeFileString(file, "reviewed");
        const remote = path.join(dir, "remote.git");
        yield* gitAt(root, ["init", "--quiet", "--bare", remote]);
        yield* git(["remote", "add", "origin", remote]);
        const pushInput = {
          remote: "origin",
          branch: "reviewed",
          userRequest: {
            messageId: MessageId.make("push-request"),
            quote: "Push the reviewed commit to origin/reviewed.",
          },
        };
        expect(
          (yield* Effect.result(
            service.proposePush(
              { threadId },
              {
                ...pushInput,
                userRequest: {
                  messageId: MessageId.make("forged"),
                  quote: pushInput.userRequest.quote,
                },
              },
            ),
          ))._tag,
        ).toBe("Failure");
        yield* service.proposePush({ threadId }, pushInput);
        const awaitingPush = (yield* store.loadAggregate(workItemId))!;
        const pushProposal = awaitingPush.workItem.pushProposal!;
        expect(pushProposal.status).toBe("proposed");
        expect((yield* gitAt(root, ["--git-dir", remote, "for-each-ref"])).stdout).toBe("");
        yield* service.control({
          commandId: CommandId.make("approve-push"),
          workItemId,
          action: { type: "approve_push", proposalId: pushProposal.id },
        });
        yield* service.drain;
        const pushed = (yield* store.loadAggregate(workItemId))!;
        expect(pushed.workItem.pushProposal?.status).toBe("pushed");
        const afterGitReport = {
          ...pushed,
          artifacts: [
            ...pushed.artifacts,
            {
              id: GarrsArtifactId.make("kex-result"),
              workItemId,
              taskId: task.id,
              attemptId,
              agentId: "kex" as const,
              kind: "summary" as const,
              summary: "Server confirmed push",
              body: "The approved commit was pushed.",
              evidence: ["Server confirmation"],
              contentHash: "git-result",
              workspace: null,
              createdAt: now,
            },
          ],
        };
        expect((yield* Subject.subjectOf(afterGitReport, root)).hash).toBe(
          proposed.reviewSubjectHash,
        );
        expect(
          (yield* gitAt(root, [
            "--git-dir",
            remote,
            "rev-parse",
            "refs/heads/reviewed",
          ])).stdout.trim(),
        ).toBe(completed.commitSha);
        expect(completed.status).toBe("committed");
        const recorded = yield* service.status({ threadId: garras }, { workItemId });
        expect(recorded.message).toContain(completed.id);
        expect(recorded.message).toContain(completed.approvedAt);
        expect(recorded.message).toContain(completed.commitSha);
        expect(recorded.message).toContain(completed.treeSha);
        expect((yield* git(["rev-parse", "HEAD"])).stdout.trim()).toBe(completed.commitSha);
        expect((yield* git(["rev-parse", "HEAD^{tree}"])).stdout.trim()).toBe(proposed.treeSha);
        const prepared = { ...completed, status: "prepared" as const };
        for (const stage of ["after_ref", "before_ref", "after_ref_stopped"] as const) {
          if (stage === "before_ref") {
            yield* git(["update-ref", proposed.branchRef, head, completed.commitSha!]);
          }
          const previous = (yield* store.loadAggregate(workItemId))!;
          yield* store.commit({
            previous,
            next: {
              ...previous,
              attempts: previous.attempts.map((entry) =>
                entry.id === attemptId
                  ? {
                      ...entry,
                      status:
                        stage === "after_ref_stopped"
                          ? ("cancel_requested" as const)
                          : ("running" as const),
                    }
                  : entry,
              ),
              tasks: previous.tasks.map((entry) =>
                entry.id === task.id ? { ...entry, status: "waiting_response" as const } : entry,
              ),
              ...(stage === "before_ref" ? { reviews: reviewed.reviews } : {}),
              workItem: { ...previous.workItem, commitProposal: prepared },
            },
            activity: [],
            effects: [
              {
                id: `recover-${stage}`,
                effect: { kind: "execute_commit", proposalId: proposed.id },
              },
            ],
            now,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restartedContext = yield* Layer.build(GarrsService.layer);
              const restarted = Context.get(restartedContext, GarrsService.GarrsService);
              const resumesBefore = yield* store.countEffects(attemptId, "resume_attempt");
              yield* restarted.start();
              yield* restarted.control({
                commandId: CommandId.make(`recovery-${stage}`),
                workItemId,
                action: { type: "pause" },
              });
              yield* restarted.drain;
              expect(
                (yield* store.loadAggregate(workItemId))?.workItem.commitProposal,
              ).toMatchObject({
                status: "committed",
                commitSha: completed.commitSha,
              });
              expect((yield* git(["rev-parse", "HEAD"])).stdout.trim()).toBe(completed.commitSha);
              if (stage === "after_ref_stopped") {
                expect(
                  (yield* store.loadAggregate(workItemId))!.tasks.find(
                    (entry) => entry.id === task.id,
                  )?.status,
                ).not.toBe("running");
                expect(yield* store.countEffects(attemptId, "resume_attempt")).toBe(resumesBefore);
                const previous = (yield* store.loadAggregate(workItemId))!;
                yield* store.commit({
                  previous,
                  next: {
                    ...previous,
                    tasks: previous.tasks.map((entry) =>
                      entry.id === task.id ? { ...entry, status: "running" as const } : entry,
                    ),
                  },
                  activity: [],
                  effects: [
                    {
                      id: "resume-stopped",
                      effect: {
                        kind: "resume_attempt",
                        attemptId,
                        text: "resume-stopped-sentinel",
                      },
                    },
                  ],
                  now,
                });
                yield* restarted.control({
                  commandId: CommandId.make("drain-stopped-resume"),
                  workItemId,
                  action: { type: "pause" },
                });
                yield* restarted.drain;
                expect(sent).not.toContain("resume-stopped-sentinel");
              }
            }),
          );
        }
        const recoveredStopped = (yield* store.loadAggregate(workItemId))!;
        const successful = {
          ...recoveredStopped,
          attempts: recoveredStopped.attempts.map((entry) =>
            entry.id === attemptId ? { ...entry, status: "running" as const } : entry,
          ),
          tasks: recoveredStopped.tasks.map((entry) =>
            entry.id === task.id ? { ...entry, status: "running" as const } : entry,
          ),
        };
        for (const change of ["index", "rules", "ref", "stopped", "persist_failure"] as const) {
          const currentRef = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
          if (currentRef !== head) yield* git(["update-ref", proposed.branchRef, head, currentRef]);
          yield* fs.writeFileString(file, "reviewed");
          yield* git(["add", "file"]);
          yield* fs.writeFileString(path.join(root, "RULES.md"), "original rule");
          let expectedRef = head;
          if (change === "index" || change === "persist_failure") {
            yield* fs.writeFileString(file, "changed after approval");
            yield* git(["add", "file"]);
          } else if (change === "rules") {
            yield* fs.writeFileString(path.join(root, "RULES.md"), "changed after approval");
          } else if (change === "ref") {
            expectedRef = (yield* git([
              "commit-tree",
              proposed.treeSha,
              "-p",
              head,
              "-m",
              "other commit",
            ])).stdout.trim();
            yield* git(["update-ref", proposed.branchRef, expectedRef, head]);
          }
          const previous = (yield* store.loadAggregate(workItemId))!;
          yield* store.commit({
            previous,
            next: {
              ...successful,
              attempts:
                change === "stopped"
                  ? successful.attempts.map((entry) =>
                      entry.id === attemptId
                        ? { ...entry, status: "cancel_requested" as const }
                        : entry,
                    )
                  : successful.attempts,
              tasks: successful.tasks.map((entry) =>
                entry.id === task.id ? { ...entry, status: "waiting_response" as const } : entry,
              ),
              reviews: reviewed.reviews,
              workItem: { ...successful.workItem, commitProposal: prepared },
            },
            activity: [],
            effects: [
              {
                id: `stale-${change}`,
                effect: { kind: "execute_commit", proposalId: proposed.id },
              },
            ],
            now,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const injected = GarrsStore.GarrsStore.of({
                ...store,
                commit: (input) =>
                  change === "persist_failure" &&
                  input.activity.some((entry) => entry.type === "commit.failed")
                    ? Effect.fail(
                        new GarrsStore.GarrsStoreError({
                          operation: "test failure",
                          cause: "unavailable",
                        }),
                      )
                    : store.commit(input),
              });
              const restart = Context.get(
                yield* Layer.build(GarrsService.layer).pipe(
                  Effect.provideService(GarrsStore.GarrsStore, injected),
                ),
                GarrsService.GarrsService,
              );
              yield* restart.start();
              for (let attempt = 0; attempt < 3; attempt++) {
                yield* restart.control({
                  commandId: CommandId.make(`stale-${change}-${attempt}`),
                  workItemId,
                  action: { type: "pause" },
                });
                yield* restart.drain;
              }
              const outcome = (yield* store.loadAggregate(workItemId))!.workItem.commitProposal!;
              if (change === "persist_failure") {
                expect(outcome.status).toBe("prepared");
                expect(
                  (yield* store.listPendingEffects()).find((row) => row.id === `stale-${change}`)
                    ?.tries,
                ).toBe(2);
              } else {
                expect(outcome.status).toBe("outcome_unknown");
                expect(outcome.failureReason).toContain("could not be confirmed");
              }
              expect((yield* git(["rev-parse", "HEAD"])).stdout.trim()).toBe(expectedRef);
            }),
          );
          if (change === "persist_failure")
            yield* store.finishEffect({ id: `stale-${change}`, status: "done", error: null, now });
        }
        const finalRef = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
        if (finalRef !== completed.commitSha)
          yield* git(["update-ref", proposed.branchRef, completed.commitSha!, finalRef]);
        yield* fs.writeFileString(file, "reviewed");
        yield* git(["add", "file"]);
        yield* fs.writeFileString(path.join(root, "RULES.md"), "original rule");
        const beforeRestore = (yield* store.loadAggregate(workItemId))!;
        yield* store.commit({
          previous: beforeRestore,
          next: {
            ...successful,
            tasks: successful.tasks.map((entry) =>
              entry.agentId === "copito" ? { ...entry, status: "cancelled" as const } : entry,
            ),
          },
          activity: [],
          effects: [],
          now,
        });
        const current = (yield* store.loadAggregate(workItemId))!;
        expect(current.reviews[0]?.status).toBe("valid");
        const early = yield* Effect.result(
          service.deliver({ threadId: garras }, { workItemId, summary: "Done" }),
        );
        expect(early._tag).toBe("Failure");
        yield* service.report(
          { threadId },
          {
            outcome: "done",
            kind: "summary",
            summary: "Commit created",
            body: "No push",
            evidence: [completed.commitSha!],
          },
        );
        const afterReport = (yield* store.loadAggregate(workItemId))!;
        expect(
          afterReport.tasks.some(
            (entry) =>
              entry.agentId === "copito" && !["completed", "cancelled"].includes(entry.status),
          ),
        ).toBe(false);
        yield* service.control({
          commandId: CommandId.make("finish-reviewed-work"),
          workItemId,
          action: { type: "resume" },
        });
        yield* service.drain;
        const delivered = yield* service.deliver(
          { threadId: garras },
          { workItemId, summary: "Approved commit and push confirmed." },
        );
        expect(delivered.message).toContain("Delivered");
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
