import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Bootstrap from "./GarrsBootstrap.ts";
import { defaultProjectBinding } from "./GarrsDomain.ts";
import type { CatalogInstance } from "./GarrsModels.ts";
import * as GarrsStore from "./GarrsStore.ts";
import * as GarrsService from "./GarrsService.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.ts";

it.effect.each([
  "alternative",
  "strict-policy",
  "permissions",
  "restart-after-accept",
  "attempt-limit",
  "manual-account",
  "manual-model",
  "manual-options",
  "unverifiable-selection",
  "composer-default-boolean",
  "composer-enabled-boolean",
  "composer-missing-boolean-descriptor",
  "composer-unknown-boolean-default",
  "composer-default-select",
  "composer-nondefault-select",
  "composer-select-without-default",
  "composer-select-current-override",
] as const)("recovers the Garras bootstrap with bounded retries: %s", (scenario) =>
  Effect.gen(function* () {
    const now = "2026-10-31T12:00:00.000Z";
    yield* TestClock.setTime(Date.parse(now));
    const projectId = ProjectId.make("bootstrap-project");
    const threadId = ThreadId.make("garras:bootstrap");
    const userMessageId = MessageId.make("human-request");
    const booleanScenario = [
      "composer-default-boolean",
      "composer-enabled-boolean",
      "composer-missing-boolean-descriptor",
      "composer-unknown-boolean-default",
    ].includes(scenario);
    const selectScenario = [
      "composer-default-select",
      "composer-nondefault-select",
      "composer-select-without-default",
      "composer-select-current-override",
    ].includes(scenario);
    const model =
      booleanScenario && scenario !== "composer-unknown-boolean-default"
        ? BUNDLED_CLAUDE_MODEL_CATALOG.models.find((entry) =>
            entry.model.capabilities?.optionDescriptors?.some(
              (descriptor) => descriptor.id === "fastMode" && descriptor.type === "boolean",
            ),
          )!.model.slug
        : "model";
    const first = { instanceId: ProviderInstanceId.make("account-a"), model };
    const second = { instanceId: ProviderInstanceId.make("account-b"), model };
    const descriptors: ReadonlyArray<ProviderOptionDescriptor> = booleanScenario
      ? scenario === "composer-missing-boolean-descriptor"
        ? []
        : [{ id: "fastMode", label: "Fast", type: "boolean" }]
      : selectScenario
        ? [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              ...(scenario === "composer-select-current-override" ? { currentValue: "high" } : {}),
              options: [
                {
                  id: "medium",
                  label: "Medium",
                  ...(scenario === "composer-select-without-default" ? {} : { isDefault: true }),
                },
                { id: "high", label: "High" },
              ],
            },
          ]
        : [];
    const catalog: ReadonlyArray<CatalogInstance> = [first, second].map((selection) => ({
      instanceId: selection.instanceId,
      driver: booleanScenario ? "claudeAgent" : "codex",
      displayName: selection.instanceId,
      allowed: true,
      available: true,
      unavailableReason: null,
      models:
        scenario === "manual-model" && selection.instanceId === first.instanceId
          ? [selection.model, "manual-model"]
          : [selection.model],
      defaultModel: selection.model,
      ...(booleanScenario || selectScenario
        ? {
            modelDetails: [
              {
                slug: selection.model,
                name: selection.model,
                isCustom: false,
                capabilities: { optionDescriptors: descriptors },
              },
            ],
          }
        : {}),
    }));
    const failure = {
      class: scenario === "permissions" ? ("permission_error" as const) : ("usage_limit" as const),
      message: "Provider reported a limit",
      code: null,
      retryable: false,
      resetAt: "2026-10-31T13:00:00.000Z",
    };
    const messages = [
      { id: userMessageId, threadId, text: "Inspect the project without changes", attachments: [] },
    ];
    const requested =
      scenario === "manual-account"
        ? second
        : scenario === "manual-model"
          ? { ...first, model: "manual-model" }
          : scenario === "manual-options"
            ? { ...first, options: [{ id: "reasoningEffort", value: "high" }] }
            : booleanScenario
              ? {
                  ...first,
                  options: [{ id: "fastMode", value: scenario === "composer-enabled-boolean" }],
                }
              : selectScenario
                ? {
                    ...first,
                    options: [
                      {
                        id: "effort",
                        value: scenario === "composer-nondefault-select" ? "high" : "medium",
                      },
                    ],
                  }
                : first;
    const runs = [
      {
        id: RunId.make("first-run"),
        ordinal: 1,
        status: "failed",
        userMessageId,
        modelSelection: requested,
      },
    ];
    const visibleTurnItems = [{ item: { type: "error", runId: runs[0]!.id, failure } }];
    const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
    let failAfterAccept = scenario === "restart-after-accept";
    const threads = {
      getThreadProjection: () => Effect.succeed({ messages, runs, visibleTurnItems }),
      sendToThread: (input: ThreadManagement.ThreadManagementSendInput) =>
        Effect.gen(function* () {
          sent.push(input);
          messages.push({ id: input.messageId!, threadId, text: input.text, attachments: [] });
          if (failAfterAccept) {
            return yield* new ThreadManagement.ThreadManagementThreadNotFoundError({
              projectId,
              threadId,
            });
          }
          if (scenario === "attempt-limit") {
            const next = {
              id: RunId.make("retry-run"),
              ordinal: 2,
              status: "failed",
              userMessageId: input.messageId!,
              modelSelection: input.modelSelection!,
            };
            runs.push(next);
            visibleTurnItems.push({ item: { type: "error", runId: next.id, failure } });
          }
          return {};
        }),
    } as unknown as ThreadManagement.ThreadManagementService["Service"];
    const deps = Layer.mergeAll(
      Layer.succeed(ThreadManagement.ThreadManagementService, threads),
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
            ...(scenario === "strict-policy"
              ? {
                  modelOverrides: [
                    { agentId: "garras", candidates: [first], allowFallback: false },
                  ],
                }
              : {}),
          },
          now,
        );
        yield* store.registerThread(
          {
            threadId,
            projectId,
            agentId: "garras",
            attemptId: null,
            readOnly: true,
            instructions: "",
            configRevision: 0,
          },
          now,
        );
        if (scenario !== "unverifiable-selection") {
          yield* store.putReceipt(
            "start-conversation:bootstrap:prepared",
            JSON.stringify({
              threadId,
              decision: {
                source: "bootstrap",
                candidates: [],
                requested: first,
                reason: "Initial automatic bootstrap",
                fallbackUsed: false,
                constraints: [],
                effectiveModel: null,
                effectiveModelSource: "pending",
              },
            }),
            now,
          );
        }
        const recover = Bootstrap.recoverRun({ threadId, catalog, failures: [] });
        if (scenario === "restart-after-accept") {
          expect((yield* Effect.result(recover))._tag).toBe("Failure");
          expect((yield* store.listBootstrapDecisions(threadId))[0]?.status).toBe("selected");
          failAfterAccept = false;
        } else {
          yield* recover;
        }
        yield* recover;
        const decisions = yield* store.listBootstrapDecisions(threadId);
        expect(yield* store.listBootstrapDecisions(ThreadId.make("garras"))).toEqual([]);
        if (scenario === "permissions") {
          expect(sent).toEqual([]);
          expect(decisions).toEqual([]);
          return;
        }
        if (scenario === "strict-policy") {
          expect(sent).toEqual([]);
          expect(decisions[0]).toMatchObject({ status: "blocked", decision: null });
          expect(decisions[0]?.reason).toContain("fallback is off");
          return;
        }
        if (
          scenario === "manual-account" ||
          scenario === "manual-model" ||
          scenario === "manual-options" ||
          scenario === "unverifiable-selection" ||
          scenario === "composer-enabled-boolean" ||
          scenario === "composer-missing-boolean-descriptor" ||
          scenario === "composer-unknown-boolean-default" ||
          scenario === "composer-nondefault-select" ||
          scenario === "composer-select-without-default" ||
          scenario === "composer-select-current-override"
        ) {
          expect(sent).toEqual([]);
          expect(decisions[0]).toMatchObject({
            status: "blocked",
            decision: null,
            failedSelection: requested,
          });
          expect(decisions[0]?.reason).toContain(
            scenario === "unverifiable-selection" ? "cannot be verified" : "manual",
          );
          return;
        }
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          threadId,
          projectId,
          modelSelection: second,
          commandId: CommandId.make("garrs:bootstrap-retry:first-run"),
          createdBy: "system",
        });
        expect(sent[0]?.text).toContain("Inspect the project without changes");
        expect(decisions.find((entry) => entry.runId === "first-run")).toMatchObject({
          status: "queued",
          userMessageId,
          failedSelection: first,
          failure: { class: "usage_limit" },
          decision: {
            source: "bootstrap",
            requested: second,
            fallbackUsed: true,
            effectiveModel: null,
          },
        });
        if (scenario === "attempt-limit") {
          expect(decisions.find((entry) => entry.runId === "retry-run")).toMatchObject({
            status: "blocked",
            decision: null,
          });
          expect(decisions.find((entry) => entry.runId === "retry-run")?.reason).toContain(
            "limit (2)",
          );
        }
      }).pipe(Effect.provide(deps)),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["event", "restart", "accepted-restart"] as const)(
  "connects Garras bootstrap recovery to %s and project state",
  (source) =>
    Effect.gen(function* () {
      const now = "2026-10-31T12:00:00.000Z";
      yield* TestClock.setTime(Date.parse(now));
      const projectId = ProjectId.make("wired-bootstrap");
      const threadId = ThreadId.make("garras:wired-bootstrap");
      const first = { instanceId: ProviderInstanceId.make("account-a"), model: "model" };
      const run = {
        id: RunId.make("wired-failure"),
        ordinal: 1,
        status: "failed" as const,
        userMessageId: MessageId.make("wired-human"),
        modelSelection: first,
      };
      const event = { type: "run.updated" as const, threadId, payload: run };
      const events = yield* Queue.unbounded<typeof event>();
      const queued = yield* Deferred.make<void>();
      const sends: Array<ThreadManagement.ThreadManagementSendInput> = [];
      const deps = Layer.mergeAll(
        Layer.succeed(ThreadManagement.ThreadManagementService, {
          streamDomainEvents: Stream.fromQueue(events),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadProjection: () =>
            Effect.succeed({
              runs:
                source === "accepted-restart"
                  ? [
                      { ...run, id: RunId.make("already-accepted"), ordinal: 2, status: "queued" },
                      run,
                    ]
                  : [run],
              messages: [
                { id: run.userMessageId, threadId, text: "A question", attachments: [] },
                ...(source === "accepted-restart"
                  ? [
                      {
                        id: MessageId.make(`garrs-bootstrap:${run.id}`),
                        threadId,
                        text: "Accepted retry",
                        attachments: [],
                      },
                    ]
                  : []),
              ],
              visibleTurnItems: [
                {
                  item: {
                    type: "error",
                    runId: run.id,
                    failure: {
                      class: "usage_limit",
                      message: "Limit reached",
                      code: null,
                      retryable: false,
                    },
                  },
                },
              ],
            }),
          sendToThread: (input: ThreadManagement.ThreadManagementSendInput) =>
            Effect.sync(() => {
              sends.push(input);
              return {};
            }),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Layer.succeed(
          ThreadLaunchService.ThreadLaunchService,
          {} as ThreadLaunchService.ThreadLaunchService["Service"],
        ),
        Layer.succeed(UsageService.UsageService, {} as UsageService.UsageService["Service"]),
        Layer.succeed(ProjectStore.ProjectStoreV2, {
          get: () => Effect.succeedSome({ workspaceRoot: "/fixture", archivedAt: null }),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed(
            ["account-a", "account-b"].map((instanceId) => ({
              instanceId: ProviderInstanceId.make(instanceId),
              driver: "codex",
              displayName: instanceId,
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
      ).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(VcsProcess.layer),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* GarrsStore.GarrsStore;
          yield* store.saveBinding(0, { ...defaultProjectBinding(projectId), enabled: true }, now);
          yield* store.registerThread(
            {
              threadId,
              projectId,
              agentId: "garras",
              attemptId: null,
              readOnly: true,
              instructions: "",
              configRevision: 0,
            },
            now,
            {
              key: "start-conversation:wired-bootstrap:prepared",
              json: JSON.stringify({
                threadId,
                decision: {
                  source: "bootstrap",
                  candidates: [],
                  requested: first,
                  reason: "Initial bootstrap",
                  fallbackUsed: false,
                  constraints: [],
                  effectiveModel: null,
                  effectiveModelSource: "pending",
                },
              }),
            },
          );
          if (source !== "event") {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
          VALUES (${run.id},${threadId},1,'account-a','failed',${now},'{}')`;
            if (source === "accepted-restart") {
              yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
                VALUES ('already-accepted',${threadId},2,'account-b','queued',${now},'{}')`;
              yield* store.saveBootstrapDecision(threadId, {
                runId: run.id,
                userMessageId: run.userMessageId,
                failedSelection: first,
                failure: {
                  class: "usage_limit",
                  message: "Limit reached",
                  code: null,
                  retryable: false,
                },
                observedAt: now,
                attemptNumber: 2,
                status: "selected",
                reason: "Pending acceptance",
                queuedAt: null,
                decision: {
                  source: "bootstrap",
                  candidates: [],
                  requested: { ...first, instanceId: ProviderInstanceId.make("account-b") },
                  reason: "Allowed alternative",
                  fallbackUsed: true,
                  constraints: [],
                  effectiveModel: null,
                  effectiveModelSource: "pending",
                },
              });
              expect(yield* store.listFailedGarrasThreads()).toContain(threadId);
            }
          }
          const observedStore: GarrsStore.GarrsStore["Service"] = {
            ...store,
            saveBootstrapDecision: (id, decision) =>
              store
                .saveBootstrapDecision(id, decision)
                .pipe(
                  Effect.tap(() =>
                    decision.status === "queued"
                      ? Deferred.succeed(queued, undefined)
                      : Effect.void,
                  ),
                ),
          };
          const context = yield* Layer.build(GarrsService.layer).pipe(
            Effect.provideService(GarrsStore.GarrsStore, observedStore),
          );
          const service = Context.get(context, GarrsService.GarrsService);
          yield* service.start();
          if (source === "event") yield* Queue.offer(events, event);
          yield* Deferred.await(queued);
          const state = yield* service
            .subscribeProject(projectId)
            .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
          expect(state.garrasConversations?.[0]?.bootstrapDecisions?.[0]).toMatchObject({
            status: "queued",
            decision: { source: "bootstrap", requested: { instanceId: "account-b" } },
          });
          expect(sends).toHaveLength(source === "accepted-restart" ? 0 : 1);
        }).pipe(Effect.provide(deps)),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
