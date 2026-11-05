import { applyRunEnded, applyRunStarted } from "./GarrsAttempts.ts";
import {
  CommandId,
  GarrsAgentStatus,
  GarrsAttemptId,
  GarrsArtifactId,
  type GarrsConfigSnapshot,
  type GarrsControlInput,
  GarrsControlResult,
  type GarrsDeliverInput,
  GarrsError,
  type GarrsImportConfigInput,
  type GarrsImportConfigResult,
  type GarrsImportIssue,
  GarrsMemoryId,
  type GarrsMemoryListResult,
  type GarrsMemoryMutation,
  type GarrsModelsInput,
  type GarrsSelectModelInput,
  GarrsMessageId,
  GarrsPlanRevisionId,
  GarrsPortableConfig,
  type GarrsProjectBindingSnapshot,
  type GarrsProjectState,
  type GarrsProposeCommitInput,
  type GarrsProposePushInput,
  type GarrsPushProposal,
  type GarrsReportInput,
  type GarrsRequestHelperInput,
  type GarrsReviseInput,
  GarrsReviewId,
  type GarrsSendMessageInput,
  type GarrsStartConversationInput,
  GarrsStartConversationResult,
  type GarrsStartWorkInput,
  type GarrsStatusInput,
  type GarrsSubmitPlanInput,
  type GarrsSubmitReviewInput,
  GarrsTaskId,
  type GarrsTeamConfig,
  GarrsToolResult,
  type GarrsUpdateConfigInput,
  type GarrsUpdateProjectBindingInput,
  type GarrsUsageInput,
  type GarrsUsageResult,
  type GarrsWorkItem,
  type GarrsWorkItemDetail,
  GarrsWorkItemId,
  GarrsWorkItemSummary,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageService from "../usage/UsageService.ts";
import { forkParked } from "../serverActivation.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Decider from "./GarrsDecider.ts";
import * as Commit from "./GarrsCommit.ts";
import * as Push from "./GarrsPush.ts";
import * as Checkout from "./GarrsCheckout.ts";
import * as TurnSafety from "./GarrsTurnSafety.ts";
import * as Preparation from "./GarrsPreparation.ts";
import {
  type Decision,
  GarrsRejection,
  type GarrsEffect,
  type WorkAggregate,
  agentStatuses,
  currentAttempt,
  deliveryBlockers,
  GIT_OPERATION_UNAVAILABLE,
  KEX_WAITING_FOR_REVIEW,
  isAttemptActive,
  isReviewTask,
  isWorkTerminal,
  invalidateStaleReviews,
  ROLE_RULES,
  normalizeTeamConfig,
  planTaskSpec,
  planRequiresApproval,
  reconcile,
  replaceAttempt,
  taskProjectContext,
  taskFromSpec,
  validatePlan,
  validateLinkedProjects,
  validateProjectScope,
} from "./GarrsDomain.ts";
import { selectModel, modelCandidates, type CatalogInstance } from "./GarrsModels.ts";
import * as Instructions from "./GarrsInstructions.ts";
import * as Helpers from "./GarrsHelpers.ts";
import * as GarrsStore from "./GarrsStore.ts";
import * as Subject from "./GarrsSubject.ts";
import * as Bootstrap from "./GarrsBootstrap.ts";
import { canEstimateUsage, confirmedUsageModel, estimateUsage, usageFrom } from "./GarrsUsage.ts";
import { conversationUsage } from "./GarrsConversationUsage.ts";

const ATTEMPT_THREAD_PREFIX = "garrs:";

/** Who is calling a Garrs tool: the MCP caller's thread. */
export interface GarrsCaller {
  readonly threadId: ThreadId;
}

type GarrsFailure =
  | GarrsError
  | GarrsStore.GarrsStoreError
  | GarrsStore.GarrsRevisionConflict
  | GarrsRejection;

const toGarrsError = (error: GarrsFailure): GarrsError => {
  switch (error._tag) {
    case "GarrsError":
      return error;
    case "GarrsRejection":
      return new GarrsError({ code: error.code, message: error.message });
    case "GarrsRevisionConflict":
      return new GarrsError({ code: "conflict", message: error.message });
    case "GarrsStoreError":
      return new GarrsError({
        code: "persistence",
        message: "Garrs could not read or save its state.",
      });
  }
};

/** Run a pure decision; a rejection becomes a typed failure. */
const pure = <D>(run: () => D) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof GarrsRejection
        ? new GarrsError({ code: error.code, message: error.message })
        : new GarrsError({ code: "invalid", message: "Garrs could not apply that change." }),
  });

const jsonText = <A, I>(schema: Schema.Codec<A, I>) => {
  const json = Schema.fromJsonString(schema);
  return {
    encode: (value: A) =>
      Schema.encodeEffect(json)(value).pipe(
        Effect.mapError(
          () => new GarrsError({ code: "persistence", message: "Could not encode a result." }),
        ),
      ),
    decode: (text: string) =>
      Schema.decodeEffect(json)(text).pipe(
        Effect.mapError(
          () =>
            new GarrsError({ code: "persistence", message: "Could not decode a stored result." }),
        ),
      ),
  };
};
const toolResultJson = jsonText(GarrsToolResult);
const controlResultJson = jsonText(GarrsControlResult);
const startConversationJson = jsonText(GarrsStartConversationResult);
const decodePortableConfig = Schema.decodeUnknownOption(GarrsPortableConfig);
const unknownJson = jsonText(Schema.Unknown);
const isProjectionThreadNotFound = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);
const statusJson = jsonText(
  Schema.Struct({
    workItems: Schema.Array(GarrsWorkItemSummary),
    agents: Schema.Array(GarrsAgentStatus),
    relatedProjects: Schema.Array(
      Schema.Struct({ projectId: Schema.String, title: Schema.String }),
    ),
  }),
);

interface Ids {
  readonly newTaskId: () => GarrsTaskId;
  readonly newAttemptId: () => GarrsAttemptId;
}

/** Task and attempt ids derive from the work item, so a replay produces the same ones. */
const idsFor = (workItemId: GarrsWorkItemId, aggregate: WorkAggregate | null): Ids => {
  let tasks = aggregate?.tasks.length ?? 0;
  let attempts = aggregate?.attempts.length ?? 0;
  return {
    newTaskId: () => GarrsTaskId.make(`${workItemId}-t${++tasks}`),
    newAttemptId: () => GarrsAttemptId.make(`${workItemId}-a${++attempts}`),
  };
};

type MutationDecision<A> = Decision & { readonly result: (next: WorkAggregate) => A };

export class GarrsService extends Context.Service<
  GarrsService,
  {
    readonly getConfig: () => Effect.Effect<GarrsConfigSnapshot, GarrsError>;
    readonly updateConfig: (
      input: GarrsUpdateConfigInput,
    ) => Effect.Effect<GarrsConfigSnapshot, GarrsError>;
    readonly getProjectBinding: (
      projectId: ProjectId,
    ) => Effect.Effect<GarrsProjectBindingSnapshot, GarrsError>;
    readonly updateProjectBinding: (
      input: GarrsUpdateProjectBindingInput,
    ) => Effect.Effect<GarrsProjectBindingSnapshot, GarrsError>;
    readonly startConversation: (
      input: GarrsStartConversationInput,
    ) => Effect.Effect<GarrsStartConversationResult, GarrsError>;
    readonly subscribeProject: (
      projectId: ProjectId,
    ) => Stream.Stream<GarrsProjectState, GarrsError>;
    readonly subscribeWorkItem: (
      workItemId: GarrsWorkItemId,
    ) => Stream.Stream<GarrsWorkItemDetail, GarrsError>;
    readonly control: (input: GarrsControlInput) => Effect.Effect<GarrsControlResult, GarrsError>;
    readonly exportConfig: (
      projectId: ProjectId | undefined,
    ) => Effect.Effect<GarrsPortableConfig, GarrsError>;
    readonly importConfig: (
      input: GarrsImportConfigInput,
    ) => Effect.Effect<GarrsImportConfigResult, GarrsError>;
    readonly getUsage: (input: GarrsUsageInput) => Effect.Effect<GarrsUsageResult, GarrsError>;
    readonly listMemory: (projectId: ProjectId) => Effect.Effect<GarrsMemoryListResult, GarrsError>;
    readonly mutateMemory: (
      input: GarrsMemoryMutation,
    ) => Effect.Effect<GarrsMemoryListResult, GarrsError>;
    // Agent tools; the caller's thread decides its role.
    readonly startWork: (
      caller: GarrsCaller,
      input: GarrsStartWorkInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly status: (
      caller: GarrsCaller,
      input: GarrsStatusInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly models: (
      caller: GarrsCaller,
      input: GarrsModelsInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly selectTaskModel: (
      caller: GarrsCaller,
      input: GarrsSelectModelInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly resume: (
      caller: GarrsCaller,
      input: GarrsStatusInput & { readonly workItemId: GarrsWorkItemId },
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly revise: (
      caller: GarrsCaller,
      input: GarrsReviseInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly deliver: (
      caller: GarrsCaller,
      input: GarrsDeliverInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly submitPlan: (
      caller: GarrsCaller,
      input: GarrsSubmitPlanInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly report: (
      caller: GarrsCaller,
      input: GarrsReportInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly requestHelper: (
      caller: GarrsCaller,
      input: GarrsRequestHelperInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly proposeCommit: (
      caller: GarrsCaller,
      input: GarrsProposeCommitInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly proposePush: (
      caller: GarrsCaller,
      input: GarrsProposePushInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly sendMessage: (
      caller: GarrsCaller,
      input: GarrsSendMessageInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    readonly submitReview: (
      caller: GarrsCaller,
      input: GarrsSubmitReviewInput,
    ) => Effect.Effect<GarrsToolResult, GarrsError>;
    /** Outbox effects, the run-end reactor, timeouts and restart recovery. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Wait until queued effects have run. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/garrs/GarrsService") {}

const make = Effect.gen(function* () {
  const store = yield* GarrsStore.GarrsStore;
  const usageService = yield* UsageService.UsageService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const bootstrapContext = yield* Effect.context<
    GarrsStore.GarrsStore | ThreadManagement.ThreadManagementService
  >();
  const digests = yield* Digest.Digest;
  const secureRandom = yield* SecureRandom.SecureRandom;
  // Garrs mutations are rare and small; one lock keeps limits, ids and receipts consistent.
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<string>(256);
  // Effects run after commit; suspended so the worker can reference functions defined below.
  const effectsWorker = yield* makeDrainableWorker(() => Effect.suspend(() => processEffects));

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = secureRandom.uuidV4();
  const digest = (bytes: Uint8Array) => digests.digestHex(Digest.sha256, bytes);
  const sha256 = (text: string) => digest(new TextEncoder().encode(text));
  const publish = (...keys: ReadonlyArray<string>) =>
    Effect.forEach(keys, (key) => PubSub.publish(changes, key), { discard: true });

  // ── Catalog and workspace ────────────────────────────────────────────────

  const catalogFor = Effect.fn("GarrsService.catalogFor")(function* (projectId: ProjectId) {
    const binding = (yield* store.getBinding(projectId)).binding;
    const snapshot = yield* providers.getProviders;
    return yield* Effect.forEach(snapshot, (provider) =>
      threads
        .isProviderInstanceEnabledForProject({ projectId, instanceId: provider.instanceId })
        .pipe(
          Effect.map((enabledForProject): CatalogInstance => {
            const allowedByBinding =
              binding.allowedProviderInstanceIds === null ||
              binding.allowedProviderInstanceIds.includes(provider.instanceId);
            const reason = !provider.installed
              ? "Not installed."
              : provider.auth.status === "unauthenticated"
                ? "Not signed in."
                : provider.availability === "unavailable"
                  ? (provider.unavailableReason ?? "Unavailable.")
                  : provider.status === "error" || provider.status === "disabled"
                    ? (provider.message ?? `Status: ${provider.status}.`)
                    : null;
            const models = provider.models.map((model) => model.slug);
            return {
              instanceId: provider.instanceId,
              driver: provider.driver,
              displayName: provider.displayName ?? provider.instanceId,
              allowed: binding.enabled && provider.enabled && enabledForProject && allowedByBinding,
              available: reason === null,
              unavailableReason: reason,
              models,
              modelDetails: provider.models,
              ...(provider.usageLimits === undefined ? {} : { usageLimits: provider.usageLimits }),
              defaultModel:
                provider.models.find((model) => model.isDefault)?.slug ?? models[0] ?? null,
            };
          }),
        ),
    );
  });

  const modelFailures = Effect.fn("GarrsService.modelFailures")(function* () {
    const attempts = yield* store.listModelFailures();
    return attempts.flatMap((attempt) =>
      attempt.failure === undefined
        ? []
        : [
            {
              selection: attempt.decision.requested,
              at: attempt.endedAt ?? attempt.createdAt,
              failure: attempt.failure,
            },
          ],
    );
  });

  const workspaceRoot = Effect.fn("GarrsService.workspaceRoot")(function* (projectId: ProjectId) {
    const project = yield* projects.get(projectId).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project) || project.value.archivedAt != null) {
      return yield* new GarrsError({
        code: "not_found",
        message: "The project is unavailable or archived in this environment.",
      });
    }
    return project.value.workspaceRoot;
  });

  const linkedWorkspaceRoot = Effect.fn("GarrsService.linkedWorkspaceRoot")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.get(projectId).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project) || project.value.archivedAt != null) {
      return yield* new GarrsError({
        code: "not_found",
        message: `Project ${projectId} is unavailable in this environment.`,
      });
    }
    return project.value.workspaceRoot;
  });

  const subjectContext = yield* Effect.context<
    VcsProcess.VcsProcess | FileSystem.FileSystem | Path.Path | Digest.Digest
  >();
  const headSha = (cwd: string) => Subject.headSha(cwd).pipe(Effect.provide(subjectContext));
  const workspaceState = (checkout: string, baseSha: string | null) =>
    Subject.workspaceState(checkout, baseSha).pipe(Effect.provide(subjectContext));
  const readRules = (root: string, rulePaths: ReadonlyArray<string>) =>
    Subject.readRules(root, rulePaths).pipe(Effect.provide(subjectContext));
  const matchesRepository = Effect.fn("GarrsService.matchesRepository")(function* (
    root: string,
    expectedRoot: string | undefined,
    expectedIdentity: string | undefined,
  ) {
    if (expectedRoot === undefined || expectedIdentity === undefined) return false;
    const canonical = yield* Context.get(subjectContext, FileSystem.FileSystem)
      .realPath(root)
      .pipe(Effect.option);
    const identity = yield* Subject.repositoryIdentity(root).pipe(Effect.provide(subjectContext));
    return (
      Option.isSome(canonical) &&
      canonical.value === expectedRoot &&
      Option.isSome(identity) &&
      identity.value === expectedIdentity
    );
  });
  const unfinishedWriteTurns = (aggregate: WorkAggregate) =>
    TurnSafety.unfinishedWriteTurns(aggregate, (threadId) =>
      threads.getThreadProjection(threadId).pipe(Effect.orElseSucceed(() => null)),
    );
  const subjectOf = Effect.fn("GarrsService.subjectOf")(function* (aggregate: WorkAggregate) {
    if (yield* unfinishedWriteTurns(aggregate))
      return { hash: null, state: null, reason: "A writer's provider turn has not finished." };
    const root = yield* workspaceRoot(aggregate.workItem.projectId).pipe(
      Effect.orElseSucceed(() => null),
    );
    const fs = Context.get(subjectContext, FileSystem.FileSystem);
    if (aggregate.workItem.repositoryIdentity !== undefined) {
      if (root === null)
        return { hash: null, state: null, reason: "The primary project is unavailable." };
      const canonical = yield* fs.realPath(root).pipe(Effect.option);
      const identity = yield* Subject.repositoryIdentity(root).pipe(Effect.provide(subjectContext));
      if (
        Option.isNone(canonical) ||
        canonical.value !== aggregate.workItem.projectRoot ||
        Option.isNone(identity) ||
        identity.value !== aggregate.workItem.repositoryIdentity
      ) {
        return {
          hash: null,
          state: null,
          reason: "The primary project's repository or path changed.",
        };
      }
    }
    for (const context of aggregate.workItem.projectContexts ?? []) {
      const currentRoot = yield* linkedWorkspaceRoot(context.projectId).pipe(
        Effect.orElseSucceed(() => null),
      );
      const expectedRoot = context.projectRoot ?? context.workspace.checkoutPath;
      const canonical =
        currentRoot === null
          ? Option.none<string>()
          : yield* fs.realPath(currentRoot).pipe(Effect.option);
      const identity =
        currentRoot === null
          ? Option.none<string>()
          : yield* Subject.repositoryIdentity(currentRoot).pipe(Effect.provide(subjectContext));
      if (
        currentRoot === null ||
        expectedRoot === null ||
        Option.isNone(canonical) ||
        canonical.value !== expectedRoot ||
        context.repositoryIdentity === undefined ||
        Option.isNone(identity) ||
        identity.value !== context.repositoryIdentity
      ) {
        return {
          hash: null,
          state: null,
          reason: `Project ${context.projectId} is unavailable or its checkout changed.`,
        };
      }
    }
    return yield* Subject.subjectOf(aggregate, root).pipe(Effect.provide(subjectContext));
  });
  const isolatedCheckout = Effect.fn("GarrsService.isolatedCheckout")(function* (
    projectId: ProjectId,
    checkout: string,
  ) {
    const root = yield* workspaceRoot(projectId).pipe(Effect.orElseSucceed(() => null));
    if (root === null) return false;
    const fs = Context.get(subjectContext, FileSystem.FileSystem);
    const rootPath = yield* fs.realPath(root).pipe(Effect.option);
    const checkoutPath = yield* fs.realPath(checkout).pipe(Effect.option);
    if (
      Option.isNone(rootPath) ||
      Option.isNone(checkoutPath) ||
      rootPath.value === checkoutPath.value
    )
      return false;
    return yield* Subject.isIsolatedCheckout(rootPath.value, checkoutPath.value).pipe(
      Effect.provide(subjectContext),
    );
  });

  const captureCheckout = Effect.fn("GarrsService.captureCheckout")(function* (
    aggregate: WorkAggregate,
    attemptId: GarrsAttemptId,
    threadId: ThreadId,
  ) {
    const attempt = aggregate.attempts.find((entry) => entry.id === attemptId);
    const task = aggregate.tasks.find((entry) => entry.id === attempt?.taskId);
    if (task === undefined || aggregate.workItem.access !== "write") return aggregate;
    const projectId = task.projectId;
    const context = taskProjectContext(aggregate.workItem, projectId);
    const member = yield* store.getThread(threadId);
    if (
      attempt?.threadId !== threadId ||
      member?.attemptId !== attemptId ||
      member.projectId !== projectId
    ) {
      return yield* new GarrsError({
        code: "unavailable",
        message: "The checkout's task, thread and project association could not be verified.",
      });
    }
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    const root = yield* (
      projectId === aggregate.workItem.projectId
        ? workspaceRoot(projectId)
        : linkedWorkspaceRoot(projectId)
    ).pipe(Effect.orElseSucceed(() => null));
    if (
      context === null ||
      shell?.worktreePath == null ||
      shell.projectId !== projectId ||
      root === null
    )
      return yield* new GarrsError({
        code: "unavailable",
        message: "The task's isolated checkout could not be verified.",
      });
    if ((aggregate.workItem.projectContexts?.length ?? 0) > 0) {
      const expectedRoot =
        projectId === aggregate.workItem.projectId
          ? aggregate.workItem.projectRoot
          : context.projectRoot;
      const expectedIdentity =
        projectId === aggregate.workItem.projectId
          ? aggregate.workItem.repositoryIdentity
          : context.repositoryIdentity;
      if (!(yield* matchesRepository(root, expectedRoot, expectedIdentity)))
        return yield* new GarrsError({
          code: "unavailable",
          message: "The task's project repository or path changed.",
        });
    }
    const binding = yield* Checkout.bind(root, shell.worktreePath, context.workspace).pipe(
      Effect.provide(subjectContext),
    );
    if (binding === null)
      return yield* new GarrsError({
        code: "unavailable",
        message: "The task's isolated checkout could not be verified.",
      });
    return {
      ...aggregate,
      workItem:
        projectId === aggregate.workItem.projectId
          ? { ...aggregate.workItem, workspace: binding }
          : {
              ...aggregate.workItem,
              projectContexts: aggregate.workItem.projectContexts?.map((entry) =>
                entry.projectId === projectId ? { ...entry, workspace: binding } : entry,
              ),
            },
    };
  });

  const recoverCheckouts = Effect.fn("GarrsService.recoverCheckouts")(function* (
    aggregate: WorkAggregate,
  ) {
    if (aggregate.workItem.access !== "write" || isWorkTerminal(aggregate.workItem))
      return aggregate;
    const projectIds = [
      aggregate.workItem.projectId,
      ...(aggregate.workItem.projectContexts ?? []).map((entry) => entry.projectId),
    ].filter(
      (projectId) =>
        taskProjectContext(aggregate.workItem, projectId)?.workspace.checkoutPath === null,
    );
    let next = aggregate;
    for (const projectId of projectIds) {
      for (const attempt of aggregate.attempts.toReversed()) {
        if (
          attempt.threadId === null ||
          !aggregate.tasks.some(
            (task) => task.id === attempt.taskId && task.projectId === projectId,
          )
        )
          continue;
        const shell = yield* threads.getThreadShell(attempt.threadId).pipe(
          Effect.mapError(
            () =>
              new GarrsError({
                code: "unavailable",
                message:
                  "A historical task's checkout could not be verified; restore its thread before retrying.",
              }),
          ),
        );
        if (shell === null || shell.projectId !== projectId) {
          return yield* new GarrsError({
            code: "unavailable",
            message: "A historical checkout is unavailable or belongs to a different project.",
          });
        }
        if (shell.worktreePath === null) continue;
        next = yield* captureCheckout(next, attempt.id, attempt.threadId);
      }
    }
    return next;
  });

  const recoverCheckoutState = Effect.fn("GarrsService.recoverCheckoutState")(function* (
    aggregate: WorkAggregate,
  ) {
    const recovered = yield* Effect.result(recoverCheckouts(aggregate));
    if (Result.isSuccess(recovered)) {
      return {
        aggregate: recovered.success,
        activity:
          recovered.success === aggregate
            ? []
            : [
                {
                  type: "workspace.recovered",
                  summary:
                    "Recovered prepared checkout bindings from verified task threads; existing files were preserved.",
                  agentId: null,
                  taskId: null,
                  attemptId: null,
                },
              ],
      };
    }
    const reason = `Prepared checkout recovery is blocked: ${recovered.failure.message}`.slice(
      0,
      2_000,
    );
    return {
      aggregate: {
        ...aggregate,
        workItem: { ...aggregate.workItem, status: "blocked" as const, statusReason: reason },
      },
      activity:
        aggregate.workItem.statusReason === reason
          ? []
          : [
              {
                type: "workspace.recovery_blocked",
                summary: reason,
                agentId: null,
                taskId: null,
                attemptId: null,
              },
            ],
    };
  });

  const reviewBlockers = (
    aggregate: WorkAggregate,
    requireReviewForWrites: boolean,
    reviewDiagnoses: boolean,
    subject: { readonly hash: string | null; readonly reason: string | null },
  ) => {
    const blockers = deliveryBlockers(
      aggregate,
      requireReviewForWrites,
      subject.hash,
      reviewDiagnoses,
    ).map((blocker) =>
      subject.reason !== null && blocker.startsWith("The review state is unavailable")
        ? `The review state is unavailable: ${subject.reason}`
        : blocker,
    );
    if (
      subject.reason === "A writer's provider turn has not finished." &&
      !blockers.some((entry) => entry.includes(subject.reason!))
    )
      blockers.push(subject.reason);
    return blockers;
  };

  // ── Commit pipeline ──────────────────────────────────────────────────────

  const loadOrFail = (workItemId: GarrsWorkItemId) =>
    store.loadAggregate(workItemId).pipe(
      Effect.filterOrFail(
        (aggregate): aggregate is WorkAggregate => aggregate !== null,
        () => new GarrsError({ code: "not_found", message: "Work item not found." }),
      ),
    );

  const usageTokens = (aggregate: WorkAggregate) => {
    const known = aggregate.attempts.filter((attempt) => attempt.usage.quality !== "unknown");
    if (known.length === 0) return null;
    return known.reduce(
      (sum, attempt) => sum + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0),
      0,
    );
  };

  const reconcileAndCommit: (input: {
    readonly previous: WorkAggregate | null;
    readonly decision: Decision;
    readonly ids: Ids;
    readonly receipt?: (
      next: WorkAggregate,
    ) => Effect.Effect<{ readonly key: string; readonly json: string }, GarrsError>;
  }) => Effect.Effect<WorkAggregate, GarrsError | GarrsStore.GarrsStoreError> = Effect.fn(
    "GarrsService.reconcileAndCommit",
  )(function* (input) {
    const now = yield* nowIso;
    const checkoutState = yield* recoverCheckoutState(input.decision.aggregate);
    const aggregate = checkoutState.aggregate;
    const config = yield* store.getConfigRevision(aggregate.workItem.configRevision);
    const binding = (yield* store.getBinding(aggregate.workItem.projectId)).binding;
    const catalog = yield* catalogFor(aggregate.workItem.projectId);
    const failures = [
      ...(yield* modelFailures()),
      ...aggregate.attempts.flatMap((attempt) =>
        attempt.failure === undefined
          ? []
          : [
              {
                selection: attempt.decision.requested,
                at: attempt.endedAt ?? attempt.createdAt,
                failure: attempt.failure,
              },
            ],
      ),
    ];
    const modelConfig = (yield* store.getConfig()).config;
    const projectCatalogs = new Map([[aggregate.workItem.projectId, { binding, catalog }]]);
    for (const context of aggregate.workItem.projectContexts ?? []) {
      if (projectCatalogs.has(context.projectId)) continue;
      const otherBinding = (yield* store.getBinding(context.projectId)).binding;
      const otherCatalog = yield* catalogFor(context.projectId);
      projectCatalogs.set(context.projectId, { binding: otherBinding, catalog: otherCatalog });
    }
    const active = yield* store.listActiveAttempts();
    const ownIds = new Set(aggregate.attempts.map((attempt) => attempt.id));
    const elsewhere = active.filter((attempt) => !ownIds.has(attempt.id));
    const runningByInstance = new Map<string, number>();
    for (const attempt of [...elsewhere, ...aggregate.attempts.filter(isAttemptActive)]) {
      const instance = attempt.decision.requested.instanceId;
      runningByInstance.set(instance, (runningByInstance.get(instance) ?? 0) + 1);
    }
    const subject = yield* subjectOf(aggregate);
    const reconciled = reconcile(aggregate, {
      now,
      limits: config.limits,
      requireReviewForWrites: config.review.requireReviewForWrites,
      reviewDiagnoses: config.review.reviewDiagnoses,
      runningGlobal: elsewhere.length,
      runningByInstance,
      newTaskId: input.ids.newTaskId,
      newAttemptId: input.ids.newAttemptId,
      subjectHash: subject.hash,
      tokensUsed: usageTokens(aggregate),
      holdLaunches: yield* unfinishedWriteTurns(aggregate),
      select: (task) => {
        const projectCatalog = projectCatalogs.get(task.projectId);
        if (projectCatalog === undefined) {
          return {
            ok: false,
            reason: "The task's project is unavailable in this work item.",
            candidates: [],
          };
        }
        return selectModel({
          agentId: task.agentId,
          pinned:
            task.pinnedSelection === null
              ? null
              : {
                  selection: task.pinnedSelection,
                  by: task.pinnedBy ?? "coordinator",
                  reason: task.selectionReason,
                  fallbacks: task.fallbackSelections,
                  userInstruction: task.modelInstruction,
                },
          projectOverrides: projectCatalog.binding.modelOverrides,
          teamPolicy: modelConfig.modelPolicy,
          catalog: projectCatalog.catalog,
          requirements: { readOnly: task.capability === "read", coordinatorRequired: true },
          failures,
          now,
        });
      },
    });
    const effects = [
      ...input.decision.effects,
      ...reconciled.effects,
      ...Helpers.deliveries(reconciled.aggregate),
    ];
    const effectIds = yield* Effect.forEach(effects, () => uuid);
    const receipt =
      input.receipt === undefined ? undefined : yield* input.receipt(reconciled.aggregate);
    yield* store.commit({
      previous: input.previous,
      next: reconciled.aggregate,
      activity: [...input.decision.activity, ...checkoutState.activity, ...reconciled.activity],
      effects: effects.map((effect, index) => ({ id: effectIds[index]!, effect })),
      ...(receipt === undefined ? {} : { receipt }),
      now,
    });
    yield* publish(
      `work:${reconciled.aggregate.workItem.id}`,
      `project:${reconciled.aggregate.workItem.projectId}`,
    );
    yield* effectsWorker.enqueue(undefined);
    return reconciled.aggregate;
  });

  /** Apply a decision to a work item under the lock. A receipt key makes it idempotent. */
  const mutate = <A, I>(
    workItemId: GarrsWorkItemId,
    receipt: { readonly key: string; readonly json: ReturnType<typeof jsonText<A, I>> } | null,
    decide: (
      aggregate: WorkAggregate,
      ids: Ids,
    ) => Effect.Effect<MutationDecision<A>, GarrsFailure>,
  ): Effect.Effect<A, GarrsError> =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          if (receipt !== null) {
            const stored = yield* store.getReceipt(receipt.key);
            if (stored !== null) return yield* receipt.json.decode(stored);
          }
          const previous = yield* loadOrFail(workItemId);
          const ids = idsFor(workItemId, previous);
          const decision = yield* decide(previous, ids);
          const next = yield* reconcileAndCommit({
            previous,
            decision,
            ids,
            ...(receipt === null
              ? {}
              : {
                  receipt: (next: WorkAggregate) =>
                    receipt.json
                      .encode(decision.result(next))
                      .pipe(Effect.map((json) => ({ key: receipt.key, json }))),
                }),
          });
          const result = decision.result(next);
          return result;
        }),
      )
      .pipe(Effect.mapError(toGarrsError));

  // ── Detail and project state ─────────────────────────────────────────────

  const getWorkItem = Effect.fn("GarrsService.getWorkItem")(function* (
    workItemId: GarrsWorkItemId,
  ) {
    const aggregate = yield* loadOrFail(workItemId);
    const config = yield* store.getConfigRevision(aggregate.workItem.configRevision);
    const activity = yield* store.listActivity(workItemId, 200);
    const subject = yield* subjectOf(aggregate);
    const remaining = isWorkTerminal(aggregate.workItem)
      ? []
      : reviewBlockers(
          aggregate,
          config.review.requireReviewForWrites,
          config.review.reviewDiagnoses,
          subject,
        );
    return {
      workItem:
        aggregate.workItem.status === "ready_to_deliver" && remaining.length > 0
          ? { ...aggregate.workItem, status: "blocked", statusReason: remaining[0] ?? null }
          : aggregate.workItem,
      plans: aggregate.plans,
      tasks: aggregate.tasks,
      attempts: aggregate.attempts,
      messages: aggregate.messages.slice(-200),
      artifacts: aggregate.artifacts,
      reviews: invalidateStaleReviews(aggregate, subject.hash).aggregate.reviews,
      activity,
      remaining,
      preparation: (yield* Effect.forEach(
        [
          {
            projectId: aggregate.workItem.projectId,
            checkout:
              aggregate.workItem.access === "write"
                ? (aggregate.workItem.workspace?.checkoutPath ?? null)
                : (aggregate.workItem.projectRoot ??
                  (yield* workspaceRoot(aggregate.workItem.projectId).pipe(
                    Effect.orElseSucceed(() => null),
                  ))),
          },
          ...(aggregate.workItem.projectContexts ?? []).map((context) => ({
            projectId: context.projectId,
            checkout: context.workspace.checkoutPath,
          })),
        ],
        (entry) =>
          Preparation.inspect(entry.projectId, entry.checkout).pipe(Effect.provide(subjectContext)),
      )).flat(),
    } satisfies GarrsWorkItemDetail;
  }, Effect.mapError(toGarrsError));

  const projectState = Effect.fn("GarrsService.projectState")(function* (projectId: ProjectId) {
    const binding = (yield* store.getBinding(projectId)).binding;
    const workItems = yield* store.listWorkItems(projectId, 50);
    const taskCounts = yield* store.listTaskCounts(workItems.map((workItem) => workItem.id));
    const garrasThreadIds = yield* store.listGarrasThreads(projectId);
    const garrasConversations = yield* Effect.forEach(garrasThreadIds, (threadId) =>
      Effect.gen(function* () {
        const receipt = yield* store.getReceipt(
          `start-conversation:${threadId.slice("garras:".length)}:prepared`,
        );
        if (receipt === null) return null;
        const conversation = yield* startConversationJson.decode(receipt);
        return {
          ...conversation,
          bootstrapDecisions: (yield* store.listBootstrapDecisions(threadId)).slice(-10),
        };
      }),
    );
    const aggregates = yield* Effect.forEach(
      workItems.filter((workItem) => !isWorkTerminal(workItem)),
      (workItem) => store.loadAggregate(workItem.id),
    );
    const open = aggregates.filter((entry): entry is WorkAggregate => entry !== null);
    const countsByWorkItem = new Map(taskCounts.map((entry) => [entry.workItemId, entry]));
    return {
      projectId,
      enabled: binding.enabled,
      garrasThreadIds,
      garrasConversations: garrasConversations.filter((entry) => entry !== null),
      agents: agentStatuses(open),
      workItems: workItems.map((workItem) => {
        const counts = countsByWorkItem.get(workItem.id);
        return {
          id: workItem.id,
          garrasThreadId: workItem.garrasThreadId,
          title: workItem.title,
          intent: workItem.intent,
          access: workItem.access,
          status: workItem.status,
          statusReason: workItem.statusReason,
          taskCount: counts?.taskCount ?? 0,
          completedTaskCount: counts?.completedTaskCount ?? 0,
          updatedAt: workItem.updatedAt,
        };
      }),
    } satisfies GarrsProjectState;
  }, Effect.mapError(toGarrsError));

  const live = <A>(key: string, read: Effect.Effect<A, GarrsError>): Stream.Stream<A, GarrsError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the first read so no change slips between them.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(read),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === key),
            // A burst of changes becomes one read.
            Stream.debounce("150 millis"),
            Stream.mapEffect(() => read),
          ),
        );
      }),
    );

  // ── Settings ─────────────────────────────────────────────────────────────

  const getConfig = () => store.getConfig().pipe(Effect.mapError(toGarrsError));

  const updateConfig = Effect.fn("GarrsService.updateConfig")(function* (
    input: GarrsUpdateConfigInput,
  ) {
    const result = yield* store.saveConfig(input.expectedRevision, input.config, yield* nowIso);
    yield* publish("config");
    return result;
  }, Effect.mapError(toGarrsError));

  const getProjectBinding = (projectId: ProjectId) =>
    store.getBinding(projectId).pipe(Effect.mapError(toGarrsError));

  const updateProjectBinding = Effect.fn("GarrsService.updateProjectBinding")(function* (
    input: GarrsUpdateProjectBindingInput,
  ) {
    yield* workspaceRoot(input.binding.projectId);
    const linked =
      input.binding.linkedProjectIds.length === 0
        ? []
        : yield* projects.list({ projectIds: input.binding.linkedProjectIds }).pipe(
            Effect.mapError(
              () =>
                new GarrsError({
                  code: "persistence",
                  message: "Could not load associated projects.",
                }),
            ),
          );
    const linkError = validateLinkedProjects(
      input.binding.projectId,
      input.binding.linkedProjectIds,
      new Set(
        linked.filter((project) => project.archivedAt === null).map((project) => project.projectId),
      ),
    );
    if (linkError !== null) return yield* new GarrsError({ code: "invalid", message: linkError });
    const result = yield* store.saveBinding(input.expectedRevision, input.binding, yield* nowIso);
    yield* publish(`project:${input.binding.projectId}`);
    return result;
  }, Effect.mapError(toGarrsError));

  // ── Garras conversation ──────────────────────────────────────────────────

  const startConversation = Effect.fn("GarrsService.startConversation")(function* (
    input: GarrsStartConversationInput,
  ) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const receiptKey = `start-conversation:${input.commandId}`;
        const preparedKey = `${receiptKey}:prepared`;
        const stored = yield* store.getReceipt(receiptKey);
        if (stored !== null) {
          const prior = yield* startConversationJson.decode(stored);
          const record = yield* store.getThread(prior.threadId);
          if (record === null || record.projectId !== input.projectId) {
            return yield* new GarrsError({
              code: "conflict",
              message: "This conversation command belongs to another project.",
            });
          }
          return prior;
        }
        const prepared = yield* store.getReceipt(preparedKey);
        let result: GarrsStartConversationResult;
        if (prepared !== null) {
          result = yield* startConversationJson.decode(prepared);
        } else {
          const binding = (yield* store.getBinding(input.projectId)).binding;
          if (!binding.enabled)
            return yield* new GarrsError({
              code: "disabled",
              message: "Garrs is not enabled for this project.",
            });
          const config = yield* store.getConfig();
          const catalog = yield* catalogFor(input.projectId);
          const failures = yield* modelFailures();
          const selected = selectModel({
            agentId: "garras",
            pinned: null,
            projectOverrides: binding.modelOverrides,
            teamPolicy: config.config.modelPolicy,
            catalog,
            requirements: { readOnly: true },
            bootstrap: true,
            failures,
            now: yield* nowIso,
          });
          if (!selected.ok)
            return yield* new GarrsError({
              code: "unavailable",
              message: `Garras cannot start: ${selected.reason}`,
            });
          const threadId = ThreadId.make(`garras:${input.commandId}`);
          result = { threadId, decision: selected.decision };
          yield* store.registerThread(
            {
              threadId,
              projectId: input.projectId,
              agentId: "garras",
              attemptId: null,
              readOnly: true,
              instructions: Instructions.garrasInstructions(config.config),
              configRevision: config.revision,
            },
            yield* nowIso,
            { key: preparedKey, json: yield* startConversationJson.encode(result) },
          );
        }
        const record = yield* store.getThread(result.threadId);
        if (record === null || record.projectId !== input.projectId) {
          return yield* new GarrsError({
            code: "conflict",
            message: "This conversation command belongs to another project.",
          });
        }
        const config = yield* store.getConfigRevision(record.configRevision);
        const message = input.message?.trim() ?? "";
        yield* launcher
          .launch({
            commandId: input.commandId,
            threadId: result.threadId,
            projectId: input.projectId,
            title:
              config.profiles.find((profile) => profile.agentId === "garras")?.displayName ??
              "Garras",
            modelSelection: result.decision.requested,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            ...(message.length === 0 ? {} : { initialMessage: { text: message, attachments: [] } }),
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new GarrsError({
                  code: "unavailable",
                  message: `Garras's thread could not start: ${cause.message}`,
                }),
            ),
          );
        yield* store.putReceipt(
          receiptKey,
          yield* startConversationJson.encode(result),
          yield* nowIso,
        );
        yield* publish(`project:${input.projectId}`);
        return result;
      }),
    );
  }, Effect.mapError(toGarrsError));

  const resolveMember = Effect.fn("GarrsService.resolveMember")(function* (caller: GarrsCaller) {
    const member = yield* store.getThread(caller.threadId);
    if (member === null) {
      return yield* new GarrsError({
        code: "forbidden",
        message: "This thread is not part of a Garrs team.",
      });
    }
    return member;
  });

  const requireGarras = Effect.fn("GarrsService.requireGarras")(function* (caller: GarrsCaller) {
    const member = yield* resolveMember(caller);
    if (member.agentId !== "garras") {
      return yield* new GarrsError({
        code: "forbidden",
        message: "Only Garras coordinates work items.",
      });
    }
    return member;
  });

  const requireAttempt = Effect.fn("GarrsService.requireAttempt")(function* (caller: GarrsCaller) {
    const member = yield* resolveMember(caller);
    const attempt =
      member.attemptId === null ? null : yield* store.findAttemptByThread(caller.threadId);
    if (attempt === null) {
      return yield* new GarrsError({
        code: "forbidden",
        message: "Only a team member's task thread can report.",
      });
    }
    return attempt;
  });

  const garrasOwns = (workItem: GarrsWorkItem, caller: GarrsCaller) =>
    workItem.garrasThreadId === caller.threadId
      ? Effect.void
      : Effect.fail(
          new GarrsError({
            code: "forbidden",
            message: "This work item belongs to another Garras conversation.",
          }),
        );

  const latestHumanMessage = Effect.fn("GarrsService.latestHumanMessage")(function* (
    threadId: ThreadId,
  ) {
    const projection = yield* threads.getThreadProjection(threadId).pipe(
      Effect.mapError(
        () =>
          new GarrsError({
            code: "unavailable",
            message: "The latest human message could not be verified.",
          }),
      ),
    );
    return (
      projection.messages.findLast(
        (message) =>
          message.threadId === threadId && message.role === "user" && message.createdBy === "user",
      ) ?? null
    );
  });

  const models = Effect.fn("GarrsService.models")(function* (
    caller: GarrsCaller,
    input: GarrsModelsInput,
  ) {
    const member = yield* resolveMember(caller);
    const projectId = input.projectId ?? member.projectId;
    const origin = (yield* store.getBinding(member.projectId)).binding;
    if (projectId !== member.projectId && !origin.linkedProjectIds.includes(projectId)) {
      return yield* new GarrsError({
        code: "forbidden",
        message: "Model discovery is limited to this project and its associated projects.",
      });
    }
    if (
      input.capability === "git" ||
      (input.agentId !== "garras" &&
        !ROLE_RULES[input.agentId].capabilities.includes(input.capability))
    ) {
      return yield* new GarrsError({
        code: "invalid",
        message: "This role cannot hold the requested capability.",
      });
    }
    const binding = (yield* store.getBinding(projectId)).binding;
    const config = (yield* store.getConfig()).config;
    const catalog = yield* catalogFor(projectId);
    const candidates = modelCandidates({
      agentId: input.agentId,
      pinned: null,
      projectOverrides: binding.modelOverrides,
      teamPolicy: config.modelPolicy,
      catalog,
      requirements: { readOnly: input.capability === "read" },
      failures: yield* modelFailures(),
      now: yield* nowIso,
    });
    const search = input.search?.trim().toLowerCase() ?? "";
    const matches = candidates.filter((candidate) =>
      `${candidate.selection.instanceId} ${candidate.selection.model}`
        .toLowerCase()
        .includes(search),
    );
    const offset = input.offset ?? 0;
    const page = matches.slice(offset, offset + 24).map((candidate) => {
      const instance = catalog.find(
        (entry) => entry.instanceId === candidate.selection.instanceId,
      )!;
      const model = instance.modelDetails?.find(
        (entry) => entry.slug === candidate.selection.model,
      );
      return {
        ...candidate,
        driver: instance.driver,
        accountLabel: instance.displayName,
        legacy: model?.isLegacy ?? null,
        catalogDefault: instance.defaultModel === candidate.selection.model,
        options: model?.capabilities?.optionDescriptors ?? [],
        usageLimits: instance.usageLimits ?? null,
        shellCommands:
          candidate.available && (input.capability === "write" || instance.driver === "codex")
            ? "sandboxed; no network"
            : "unavailable",
        contextWindow: "unknown",
        taskSuitability:
          "Coordinator assessment required; catalog presence does not prove task quality.",
      };
    });
    const latestUser =
      member.agentId === "garras"
        ? yield* latestHumanMessage(caller.threadId).pipe(Effect.orElseSucceed(() => null))
        : null;
    return {
      ok: true,
      message: yield* unknownJson.encode({
        projectId,
        agentId: input.agentId,
        capability: input.capability,
        guidance: config.modelGuidance ?? "",
        projectPolicy:
          binding.modelOverrides.find((entry) => entry.agentId === input.agentId) ?? null,
        teamPolicy: config.modelPolicy.find((entry) => entry.agentId === input.agentId) ?? null,
        allowedProviderInstanceIds: binding.allowedProviderInstanceIds,
        precedence:
          "A verified latest human model instruction or task-specific user pin > configured model policy > Garras choice > permitted alternatives. Project provider allowlist always applies. A quote proves its source, not its interpretation. Textual guidance is a preference, not a sandbox.",
        latestUserMessage:
          latestUser === null
            ? null
            : {
                id: latestUser.id,
                text: latestUser.text.slice(0, 2_000),
                truncated: latestUser.text.length > 2_000,
              },
        candidates: page,
        total: matches.length,
        nextOffset: offset + page.length < matches.length ? offset + page.length : null,
        facts:
          "Eligibility is checked again at launch. Quota reports have timestamps; absent or failed reports are unknown. Provider model identity is unconfirmed until reported. Claude read-only roles have file-reading tools but no shell; choose Codex when a read-only task must execute tests or Git inspection. Choose using task difficulty, tools, context, user guidance and these constraints; record uncertainty and a concrete reason.",
      }),
    } satisfies GarrsToolResult;
  }, Effect.mapError(toGarrsError));

  const selectTaskModel = Effect.fn("GarrsService.selectTaskModel")(function* (
    caller: GarrsCaller,
    input: GarrsSelectModelInput,
  ) {
    yield* requireGarras(caller);
    return yield* mutate(input.workItemId, null, (aggregate) =>
      Effect.gen(function* () {
        yield* garrasOwns(aggregate.workItem, caller);
        const task = aggregate.tasks.find((entry) => entry.id === input.taskId);
        if (task === undefined)
          return yield* new GarrsError({
            code: "not_found",
            message: "The task is not part of this work item.",
          });
        if (
          isWorkTerminal(aggregate.workItem) ||
          !["pending", "ready", "waiting_dependency"].includes(task.status) ||
          aggregate.attempts.some(
            (attempt) => attempt.taskId === task.id && isAttemptActive(attempt),
          )
        ) {
          return yield* new GarrsError({
            code: "conflict",
            message:
              "Only an unstarted or retry-ready task can receive a model decision. Stop running work first; attempt limits still apply.",
          });
        }
        const userInstruction = input.userInstruction;
        const latestUser =
          userInstruction === undefined ? null : yield* latestHumanMessage(caller.threadId);
        if (
          userInstruction !== undefined &&
          (userInstruction.quote.trim().length === 0 ||
            latestUser?.id !== userInstruction.messageId ||
            !latestUser.text.includes(userInstruction.quote))
        ) {
          return yield* new GarrsError({
            code: "forbidden",
            message:
              "A model instruction must quote the latest human message in this Garras conversation exactly.",
          });
        }
        if (userInstruction !== undefined && (input.fallbackSelections?.length ?? 0) > 0) {
          return yield* new GarrsError({
            code: "invalid",
            message: "A task-specific user model instruction cannot authorize fallback models.",
          });
        }
        if (
          task.pinnedBy === "user" &&
          (latestUser === null ||
            DateTime.toEpochMillis(latestUser.createdAt) <= Date.parse(task.updatedAt) ||
            !Number.isFinite(Date.parse(task.updatedAt)))
        ) {
          return yield* new GarrsError({
            code: "forbidden",
            message:
              "Replacing a task-specific user model pin requires a verified human instruction newer than that pin.",
          });
        }
        const pinnedBy =
          userInstruction === undefined ? ("coordinator" as const) : ("user" as const);
        const binding = (yield* store.getBinding(task.projectId)).binding;
        const config = (yield* store.getConfig()).config;
        const selected = selectModel({
          agentId: task.agentId,
          pinned: {
            selection: input.selection,
            by: pinnedBy,
            reason: input.reason,
            fallbacks: input.fallbackSelections,
            ...(userInstruction === undefined ? {} : { userInstruction }),
          },
          projectOverrides: binding.modelOverrides,
          teamPolicy: config.modelPolicy,
          catalog: yield* catalogFor(task.projectId),
          requirements: { readOnly: task.capability === "read", coordinatorRequired: true },
          failures: yield* modelFailures(),
          now: yield* nowIso,
        });
        if (!selected.ok)
          return yield* new GarrsError({ code: "unavailable", message: selected.reason });
        const now = yield* nowIso;
        return {
          aggregate: {
            ...aggregate,
            workItem: {
              ...aggregate.workItem,
              ...(aggregate.workItem.status === "blocked"
                ? { status: "active" as const, statusReason: null }
                : {}),
              updatedAt: now,
            },
            tasks: aggregate.tasks.map((entry) =>
              entry.id === task.id
                ? {
                    ...entry,
                    pinnedSelection: input.selection,
                    pinnedBy,
                    ...(userInstruction === undefined ? {} : { modelInstruction: userInstruction }),
                    selectionReason: input.reason,
                    fallbackSelections: input.fallbackSelections ?? [],
                    statusReason: null,
                    updatedAt: now,
                  }
                : entry,
            ),
          },
          activity: [
            {
              type: "model.selected",
              summary:
                `${task.agentId}: ${selected.decision.requested.instanceId} / ${selected.decision.requested.model}. ${userInstruction === undefined ? "Garras assessment" : `Human instruction from ${userInstruction.messageId}`}. ${input.reason}`.slice(
                  0,
                  2_000,
                ),
              agentId: task.agentId,
              taskId: task.id,
              attemptId: null,
            },
          ],
          effects: [],
          result: (): GarrsToolResult => ({
            ok: true,
            workItemId: aggregate.workItem.id,
            message: `Model decision recorded. ${selected.decision.reason}`,
          }),
        };
      }),
    );
  }, Effect.mapError(toGarrsError));

  const startWork = Effect.fn("GarrsService.startWork")(function* (
    caller: GarrsCaller,
    input: GarrsStartWorkInput,
  ) {
    const member = yield* requireGarras(caller);
    const receiptKey =
      input.clientRequestId === undefined
        ? null
        : `start-work:${caller.threadId}:${input.clientRequestId}`;
    const workItemId = GarrsWorkItemId.make(yield* uuid);
    const planId = GarrsPlanRevisionId.make(yield* uuid);
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (receiptKey !== null) {
          const stored = yield* store.getReceipt(receiptKey);
          if (stored !== null) return yield* toolResultJson.decode(stored);
        }
        const config = yield* store.getConfig();
        const bindingSnapshot = yield* store.getBinding(member.projectId);
        if (!bindingSnapshot.binding.enabled) {
          return yield* new GarrsError({
            code: "disabled",
            message: "Garrs is disabled for this project.",
          });
        }
        const projectScopeError = validateProjectScope(
          member.projectId,
          input.projectIds,
          bindingSnapshot.binding.linkedProjectIds,
        );
        if (projectScopeError !== null) {
          return yield* new GarrsError({ code: "invalid", message: projectScopeError });
        }
        const root = yield* workspaceRoot(member.projectId);
        const now = yield* nowIso;
        const rules = yield* readRules(root, bindingSnapshot.binding.rulePaths);
        const baseSha = input.access === "write" ? yield* headSha(root) : null;
        if (
          input.access === "write" &&
          (input.projectIds?.some((id) => id !== member.projectId) ?? false) &&
          baseSha === null
        ) {
          return yield* new GarrsError({
            code: "unavailable",
            message: "The primary project needs a readable Git commit for cross-project work.",
          });
        }
        const repositories = new Set<string>();
        let primaryIdentity: string | undefined;
        let primaryRoot: string | undefined;
        if (input.projectIds?.some((id) => id !== member.projectId) ?? false) {
          const identity = yield* Subject.repositoryIdentity(root).pipe(
            Effect.provide(subjectContext),
          );
          if (Option.isNone(identity))
            return yield* new GarrsError({
              code: "unavailable",
              message: "Cannot verify the primary Git repository identity.",
            });
          primaryIdentity = identity.value;
          const canonical = yield* Context.get(subjectContext, FileSystem.FileSystem)
            .realPath(root)
            .pipe(Effect.option);
          if (Option.isNone(canonical))
            return yield* new GarrsError({
              code: "unavailable",
              message: "Cannot verify the primary project path.",
            });
          primaryRoot = canonical.value;
          repositories.add(identity.value);
        }
        const linkedContexts = yield* Effect.forEach(
          [...new Set(input.projectIds ?? [])].filter((id) => id !== member.projectId),
          (projectId) =>
            Effect.gen(function* () {
              if (!bindingSnapshot.binding.linkedProjectIds.includes(projectId)) {
                return yield* new GarrsError({
                  code: "forbidden",
                  message: `Project ${projectId} is not associated with this project.`,
                });
              }
              const target = yield* store.getBinding(projectId);
              if (!target.binding.enabled) {
                return yield* new GarrsError({
                  code: "disabled",
                  message: `Garrs is not enabled for project ${projectId}.`,
                });
              }
              const checkoutPath = yield* linkedWorkspaceRoot(projectId);
              const identity = yield* Subject.repositoryIdentity(checkoutPath).pipe(
                Effect.provide(subjectContext),
              );
              if (Option.isNone(identity))
                return yield* new GarrsError({
                  code: "unavailable",
                  message: `Cannot verify Git repository identity for project ${projectId}.`,
                });
              const canonical = yield* Context.get(subjectContext, FileSystem.FileSystem)
                .realPath(checkoutPath)
                .pipe(Effect.option);
              if (Option.isNone(canonical))
                return yield* new GarrsError({
                  code: "unavailable",
                  message: `Cannot verify project ${projectId}'s path.`,
                });
              if (input.access === "write") {
                if (repositories.has(identity.value))
                  return yield* new GarrsError({
                    code: "invalid",
                    message: "Cross-project write work requires distinct Git repositories.",
                  });
                repositories.add(identity.value);
              }
              const targetRules = yield* readRules(checkoutPath, target.binding.rulePaths);
              const unavailableRule = targetRules.find(
                (rule) => rule.status !== "read" && rule.status !== "missing",
              );
              if (unavailableRule !== undefined) {
                return yield* new GarrsError({
                  code: "unavailable",
                  message: `Rule ${unavailableRule.path} is ${unavailableRule.status} in project ${projectId}.`,
                });
              }
              const state = yield* workspaceState(checkoutPath, null);
              if (state.diffHash === null || state.headSha === null) {
                return yield* new GarrsError({
                  code: "unavailable",
                  message: `Project ${projectId} cannot be verified: ${state.unavailableReason ?? "checkout unavailable"}`,
                });
              }
              return {
                projectId,
                projectRoot: canonical.value,
                repositoryIdentity: identity.value,
                bindingRevision: target.revision,
                rules: targetRules,
                baselineDiffHash: state.diffHash,
                workspace: {
                  projectId,
                  checkoutPath: input.access === "write" ? null : checkoutPath,
                  isolated: input.access === "write",
                  baseSha: state.headSha,
                },
              };
            }),
        );
        const primaryState =
          linkedContexts.length === 0 || input.access !== "read_only"
            ? null
            : yield* workspaceState(root, null);
        if (
          primaryState !== null &&
          (primaryState.headSha === null || primaryState.diffHash === null)
        ) {
          return yield* new GarrsError({
            code: "unavailable",
            message: `Primary project cannot be verified: ${primaryState.unavailableReason ?? "checkout unavailable"}`,
          });
        }
        const directAwaitingApproval =
          input.plan !== "asta" &&
          planRequiresApproval(bindingSnapshot.binding.autonomy, input.plan.tasks);
        const workItem: GarrsWorkItem = {
          id: workItemId,
          projectId: member.projectId,
          garrasThreadId: caller.threadId,
          title: input.title,
          objective: input.objective,
          intent: input.intent,
          access: input.access,
          status:
            input.plan === "asta"
              ? "planning"
              : directAwaitingApproval
                ? "awaiting_approval"
                : "active",
          statusReason: directAwaitingApproval ? "The plan awaits the user's approval." : null,
          configRevision: config.revision,
          bindingRevision: bindingSnapshot.revision,
          revision: 1,
          correctionCycles: 0,
          rules,
          workspace:
            input.access === "write"
              ? { projectId: member.projectId, checkoutPath: null, isolated: true, baseSha }
              : { projectId: member.projectId, checkoutPath: root, isolated: false, baseSha: null },
          ...(linkedContexts.length === 0 ? {} : { projectContexts: linkedContexts }),
          ...(primaryIdentity === undefined ? {} : { repositoryIdentity: primaryIdentity }),
          ...(primaryRoot === undefined ? {} : { projectRoot: primaryRoot }),
          ...(primaryState?.headSha == null || primaryState.diffHash === null
            ? {}
            : {
                readOnlyBaseline: {
                  headSha: primaryState.headSha,
                  diffHash: primaryState.diffHash,
                },
              }),
          authorizations: [],
          createdAt: now,
          updatedAt: now,
          deliveredAt: null,
          acceptedAt: null,
        };
        const specs =
          input.plan === "asta"
            ? [
                {
                  ...planTaskSpec(input.objective),
                  ...(input.plannerSelection === undefined
                    ? {}
                    : { selection: input.plannerSelection }),
                  ...(input.plannerSelectionReason === undefined
                    ? {}
                    : { selectionReason: input.plannerSelectionReason }),
                  ...(input.plannerFallbackSelections === undefined
                    ? {}
                    : { fallbackSelections: input.plannerFallbackSelections }),
                },
              ]
            : input.plan.tasks;
        if (input.plan !== "asta") {
          const errors = validatePlan(specs, {
            projectId: member.projectId,
            additionalProjectIds: linkedContexts.map((context) => context.projectId),
            access: input.access,
            authorizations: [],
            completedKeys: new Set(),
            ...(input.access === "write" && linkedContexts.length > 0
              ? {
                  requiredCheckoutProjectIds: [
                    member.projectId,
                    ...linkedContexts.map((context) => context.projectId),
                  ],
                }
              : {}),
          });
          if (errors.length > 0) {
            return yield* new GarrsError({
              code: "invalid",
              message: `Plan rejected:\n- ${errors.join("\n- ")}`,
            });
          }
        }
        const ids = idsFor(workItemId, null);
        const tasks = specs.map((spec) =>
          taskFromSpec({
            id: ids.newTaskId(),
            workItem,
            planRevision: input.plan === "asta" ? 0 : 1,
            spec,
            now,
          }),
        );
        const plans =
          input.plan === "asta"
            ? []
            : [
                {
                  id: planId,
                  workItemId,
                  revision: 1,
                  authorAttemptId: null,
                  summary: "Direct assignment by Garras.",
                  risks: [],
                  tasks: specs,
                  status: directAwaitingApproval
                    ? ("awaiting_approval" as const)
                    : ("active" as const),
                  createdAt: now,
                },
              ];
        const workResult = (next: WorkAggregate): GarrsToolResult => ({
          ok: true,
          message:
            input.plan === "asta"
              ? "Work item opened; Asta is planning. End your turn; the server wakes you when there is something to act on."
              : directAwaitingApproval
                ? "Work item opened; the plan awaits the user's approval in the Team panel. End your turn."
                : "Work item opened with your tasks. End your turn; the server wakes you when there is something to act on.",
          workItemId: next.workItem.id,
          status: next.workItem.status,
        });
        const next = yield* reconcileAndCommit({
          previous: null,
          ids,
          ...(receiptKey === null
            ? {}
            : {
                receipt: (next: WorkAggregate) =>
                  toolResultJson
                    .encode(workResult(next))
                    .pipe(Effect.map((json) => ({ key: receiptKey, json }))),
              }),
          decision: {
            aggregate: {
              workItem,
              plans,
              tasks,
              attempts: [],
              artifacts: [],
              reviews: [],
              messages: [],
            },
            activity: [
              {
                type: "work.created",
                summary: `Garras opened "${input.title}" (${input.intent}, ${input.access}).`,
                agentId: "garras",
                taskId: null,
                attemptId: null,
              },
              ...rules
                .filter((rule) => rule.status !== "read")
                .map((rule) => ({
                  type: "rules.unavailable",
                  summary: `Rule file ${rule.path} is ${rule.status}; it is not treated as read.`,
                  agentId: null,
                  taskId: null,
                  attemptId: null,
                })),
            ],
            effects: [],
          },
        });
        return workResult(next);
      }),
    );
  }, Effect.mapError(toGarrsError));

  const memberStatusDigest = Effect.fn("GarrsService.memberStatusDigest")(function* (
    detail: GarrsWorkItemDetail,
    agentId: string,
  ) {
    const latest =
      agentId === "kex" ? yield* latestHumanMessage(detail.workItem.garrasThreadId) : null;
    return (
      Instructions.statusDigest(detail) +
      (latest === null
        ? ""
        : `\nLatest verified human request: ${yield* unknownJson.encode({ messageId: latest.id, text: latest.text })}`)
    );
  });

  const status = Effect.fn("GarrsService.status")(function* (
    caller: GarrsCaller,
    input: GarrsStatusInput,
  ) {
    const member = yield* resolveMember(caller);
    if (input.workItemId === undefined) {
      const attempt =
        member.attemptId === null ? null : yield* store.findAttemptByThread(caller.threadId);
      if (attempt !== null) {
        const detail = yield* getWorkItem(attempt.workItemId);
        return {
          ok: true,
          workItemId: detail.workItem.id,
          status: detail.workItem.status,
          remaining: detail.remaining,
          message: yield* memberStatusDigest(detail, member.agentId),
        } satisfies GarrsToolResult;
      }
      const state = yield* projectState(member.projectId);
      const binding = (yield* store.getBinding(member.projectId)).binding;
      const related =
        binding.linkedProjectIds.length === 0
          ? []
          : yield* projects.list({ projectIds: binding.linkedProjectIds }).pipe(
              Effect.mapError(
                () =>
                  new GarrsError({
                    code: "persistence",
                    message: "Could not load associated projects.",
                  }),
              ),
            );
      const own = state.workItems.filter(
        (workItem) => member.agentId !== "garras" || workItem.garrasThreadId === caller.threadId,
      );
      return {
        ok: true,
        message: yield* statusJson.encode({
          workItems: own,
          agents: state.agents,
          relatedProjects: related
            .filter((project) => project.archivedAt === null)
            .map((project) => ({ projectId: project.projectId, title: project.title })),
        }),
      } satisfies GarrsToolResult;
    }
    const detail = yield* getWorkItem(input.workItemId);
    if (
      detail.workItem.projectId !== member.projectId &&
      !detail.attempts.some(
        (attempt) => attempt.id === member.attemptId && attempt.threadId === caller.threadId,
      )
    ) {
      return yield* new GarrsError({
        code: "forbidden",
        message: "That work item belongs to another project.",
      });
    }
    return {
      ok: true,
      workItemId: detail.workItem.id,
      status: detail.workItem.status,
      remaining: detail.remaining,
      message: yield* memberStatusDigest(detail, member.agentId),
    } satisfies GarrsToolResult;
  }, Effect.mapError(toGarrsError));

  const toolResult =
    (message: string) =>
    (next: WorkAggregate): GarrsToolResult => ({
      ok: true,
      message,
      workItemId: next.workItem.id,
      status: next.workItem.status,
    });

  const resume = Effect.fn("GarrsService.resume")(function* (
    caller: GarrsCaller,
    input: { readonly workItemId: GarrsWorkItemId },
  ) {
    yield* requireGarras(caller);
    return yield* mutate(input.workItemId, null, (aggregate) =>
      Effect.gen(function* () {
        yield* garrasOwns(aggregate.workItem, caller);
        const now = yield* nowIso;
        const decision = yield* pure(() => Decider.control(aggregate, { type: "resume" }, now));
        return { ...decision, result: toolResult(decision.effect) };
      }),
    );
  }, Effect.mapError(toGarrsError));

  const revise = Effect.fn("GarrsService.revise")(function* (
    caller: GarrsCaller,
    input: GarrsReviseInput,
  ) {
    yield* requireGarras(caller);
    return yield* mutate(input.workItemId, null, (aggregate, ids) =>
      Effect.gen(function* () {
        yield* garrasOwns(aggregate.workItem, caller);
        const now = yield* nowIso;
        let refreshed = aggregate;
        let invalidatePrevious = false;
        if (
          aggregate.workItem.access === "read_only" &&
          (aggregate.workItem.projectContexts?.length ?? 0) > 0
        ) {
          const root = yield* workspaceRoot(aggregate.workItem.projectId);
          if (
            !(yield* matchesRepository(
              root,
              aggregate.workItem.projectRoot,
              aggregate.workItem.repositoryIdentity,
            ))
          ) {
            return yield* new GarrsError({
              code: "unavailable",
              message:
                "Cannot replan: the primary project repository or path changed, or its identity was not recorded.",
            });
          }
          const current = yield* workspaceState(root, null);
          if (current.headSha === null || current.diffHash === null) {
            return yield* new GarrsError({
              code: "unavailable",
              message: `Cannot replan: ${current.unavailableReason ?? "primary project state is unavailable"}`,
            });
          }
          const rules = yield* readRules(
            root,
            aggregate.workItem.rules.map((rule) => rule.path),
          );
          const invalidRule = rules.find(
            (rule) => rule.status !== "read" && rule.status !== "missing",
          );
          if (invalidRule !== undefined)
            return yield* new GarrsError({
              code: "unavailable",
              message: `Cannot replan: rule ${invalidRule.path} is ${invalidRule.status}.`,
            });
          const sameRules = (
            previous: ReadonlyArray<(typeof rules)[number]>,
            next: ReadonlyArray<(typeof rules)[number]>,
          ) =>
            previous.length === next.length &&
            previous.every(
              (rule, i) =>
                rule.path === next[i]?.path &&
                rule.status === next[i]?.status &&
                rule.sha256 === next[i]?.sha256,
            );
          invalidatePrevious =
            aggregate.workItem.readOnlyBaseline?.headSha !== current.headSha ||
            aggregate.workItem.readOnlyBaseline.diffHash !== current.diffHash ||
            !sameRules(aggregate.workItem.rules, rules);
          const contexts = yield* Effect.forEach(
            aggregate.workItem.projectContexts ?? [],
            (project) =>
              Effect.gen(function* () {
                const checkout = yield* linkedWorkspaceRoot(project.projectId);
                if (
                  !(yield* matchesRepository(
                    checkout,
                    project.projectRoot,
                    project.repositoryIdentity,
                  ))
                ) {
                  return yield* new GarrsError({
                    code: "unavailable",
                    message: `Cannot replan: project ${project.projectId} has moved or is unavailable.`,
                  });
                }
                const state = yield* workspaceState(checkout, null);
                if (state.headSha === null || state.diffHash === null) {
                  return yield* new GarrsError({
                    code: "unavailable",
                    message: `Cannot replan project ${project.projectId}: ${state.unavailableReason ?? "checkout unavailable"}`,
                  });
                }
                const currentRules = yield* readRules(
                  checkout,
                  project.rules.map((rule) => rule.path),
                );
                const invalid = currentRules.find(
                  (rule) => rule.status !== "read" && rule.status !== "missing",
                );
                if (invalid !== undefined)
                  return yield* new GarrsError({
                    code: "unavailable",
                    message: `Cannot replan: rule ${invalid.path} is ${invalid.status} in project ${project.projectId}.`,
                  });
                if (
                  project.workspace.baseSha !== state.headSha ||
                  project.baselineDiffHash !== state.diffHash ||
                  !sameRules(project.rules, currentRules)
                )
                  invalidatePrevious = true;
                return {
                  ...project,
                  rules: currentRules,
                  baselineDiffHash: state.diffHash,
                  workspace: { ...project.workspace, baseSha: state.headSha },
                };
              }),
          );
          refreshed = {
            ...aggregate,
            workItem: {
              ...aggregate.workItem,
              rules,
              projectContexts: contexts,
              readOnlyBaseline: { headSha: current.headSha, diffHash: current.diffHash },
            },
          };
        }
        const decision = yield* pure(() =>
          Decider.revise(refreshed, {
            feedback: input.feedback,
            access: input.access,
            invalidatePrevious,
            newTaskId: ids.newTaskId,
            now,
          }),
        );
        return {
          ...decision,
          result: toolResult(
            "Revision started; Asta replans and keeps valid completed work. End your turn.",
          ),
        };
      }),
    );
  }, Effect.mapError(toGarrsError));

  const deliver = Effect.fn("GarrsService.deliver")(function* (
    caller: GarrsCaller,
    input: GarrsDeliverInput,
  ) {
    yield* requireGarras(caller);
    return yield* mutate(input.workItemId, null, (aggregate, ids) =>
      Effect.gen(function* () {
        yield* garrasOwns(aggregate.workItem, caller);
        const config = yield* store.getConfigRevision(aggregate.workItem.configRevision);
        const subject = yield* subjectOf(aggregate);
        const blockers = reviewBlockers(
          aggregate,
          config.review.requireReviewForWrites,
          config.review.reviewDiagnoses,
          subject,
        );
        const now = yield* nowIso;
        if (blockers.length > 0) {
          yield* reconcileAndCommit({
            previous: aggregate,
            ids,
            decision: { aggregate, activity: [], effects: [] },
          });
        }
        const decision = yield* pure(() => Decider.deliver(aggregate, { blockers, now }));
        return {
          ...decision,
          activity: [
            ...decision.activity,
            {
              type: "work.summary",
              summary: input.summary.slice(0, 2_000),
              agentId: "garras" as const,
              taskId: null,
              attemptId: null,
            },
          ],
          result: toolResult("Delivered. Present the summary and its evidence to the user."),
        };
      }),
    );
  }, Effect.mapError(toGarrsError));

  // ── Member tools ─────────────────────────────────────────────────────────

  const pushInputFor = Effect.fn("GarrsService.pushInputFor")(function* (
    aggregate: WorkAggregate,
    proposal: GarrsPushProposal,
  ) {
    const commit = aggregate.workItem.commitProposal;
    const workspace = aggregate.workItem.workspace;
    const requester = currentAttempt(aggregate, proposal.attemptId);
    if (
      isWorkTerminal(aggregate.workItem) ||
      aggregate.workItem.status === "paused" ||
      commit?.status !== "committed" ||
      commit.id !== proposal.commitProposalId ||
      commit.commitSha !== proposal.commitSha ||
      workspace?.isolated !== true ||
      workspace.checkoutPath !== commit.checkoutPath ||
      (aggregate.workItem.projectContexts?.length ?? 0) > 0 ||
      requester?.task.agentId !== "kex" ||
      requester.attempt.status !== "running" ||
      requester.task.status !== "waiting_response" ||
      !(yield* isolatedCheckout(commit.projectId, commit.checkoutPath))
    )
      return null;
    const input = {
      checkoutPath: commit.checkoutPath,
      localBranchRef: commit.branchRef,
      commitSha: proposal.commitSha,
      remote: proposal.remote,
      branchRef: proposal.branchRef,
      destinationHash: proposal.destinationHash,
      expectedRemoteSha: proposal.expectedRemoteSha,
    };
    const subject = yield* subjectOf(aggregate);
    const target = yield* Push.inspect(input).pipe(Effect.provide(subjectContext));
    const after = yield* subjectOf(aggregate);
    return subject.hash === proposal.subjectHash &&
      after.hash === subject.hash &&
      target?.destinationHash === proposal.destinationHash &&
      target.expectedRemoteSha === proposal.expectedRemoteSha
      ? input
      : null;
  });

  const proposePush = Effect.fn("GarrsService.proposePush")(function* (
    caller: GarrsCaller,
    input: GarrsProposePushInput,
  ) {
    const attempt = yield* requireAttempt(caller);
    const id = yield* uuid;
    return yield* mutate(attempt.workItemId, null, (aggregate) =>
      Effect.gen(function* () {
        const current = currentAttempt(aggregate, attempt.id);
        const commit = aggregate.workItem.commitProposal;
        const workspace = aggregate.workItem.workspace;
        if (
          current?.task.agentId !== "kex" ||
          current.task.capability !== "read" ||
          current.attempt.status !== "running" ||
          current.task.status !== "running" ||
          commit?.status !== "committed" ||
          commit.commitSha == null ||
          workspace?.isolated !== true ||
          workspace.checkoutPath !== commit.checkoutPath ||
          (aggregate.workItem.projectContexts?.length ?? 0) > 0 ||
          !(yield* isolatedCheckout(commit.projectId, commit.checkoutPath))
        )
          return yield* new GarrsError({
            code: "forbidden",
            message:
              "Only an active read-only Kex task can propose pushing this work item's approved commit.",
          });
        const latest = yield* latestHumanMessage(aggregate.workItem.garrasThreadId);
        if (
          latest?.id !== input.userRequest.messageId ||
          input.userRequest.quote.trim().length === 0 ||
          !latest.text.includes(input.userRequest.quote)
        )
          return yield* new GarrsError({
            code: "forbidden",
            message: "Quote the latest verified human request for this push.",
          });
        const subject = yield* subjectOf(aggregate);
        const target = yield* Push.inspect({
          checkoutPath: commit.checkoutPath,
          localBranchRef: commit.branchRef,
          commitSha: commit.commitSha,
          remote: input.remote,
          branchRef: `refs/heads/${input.branch}`,
        }).pipe(Effect.provide(subjectContext));
        if (
          subject.hash === null ||
          target === null ||
          (yield* subjectOf(aggregate)).hash !== subject.hash
        )
          return yield* new GarrsError({
            code: "unavailable",
            message:
              "Cannot verify a clean approved commit and one fast-forward push destination. Check the remote, authentication, branch and local history.",
          });
        const now = yield* nowIso;
        const waiting = yield* pure(() =>
          Decider.report(aggregate, {
            attemptId: attempt.id,
            report: {
              outcome: "needs_input",
              kind: "summary",
              summary: "Push proposal awaits user approval.",
              body: "",
              evidence: [],
              question: "Approve the exact commit and destination in the Garrs team panel.",
            },
            artifactId: GarrsArtifactId.make(id),
            contentHash: "",
            workspace: null,
            now,
          }),
        );
        const proposal: GarrsPushProposal = {
          id,
          commitProposalId: commit.id,
          commitSha: commit.commitSha,
          remote: input.remote,
          ...target,
          branchRef: `refs/heads/${input.branch}`,
          subjectHash: subject.hash,
          userRequest: input.userRequest,
          attemptId: attempt.id,
          status: "proposed",
          createdAt: now,
          approvedAt: null,
        };
        return {
          ...waiting,
          aggregate: {
            ...waiting.aggregate,
            workItem: {
              ...waiting.aggregate.workItem,
              pushProposal: proposal,
              pushProposalHistory: [
                ...(aggregate.workItem.pushProposalHistory ?? []),
                ...(aggregate.workItem.pushProposal === undefined
                  ? []
                  : [aggregate.workItem.pushProposal]),
              ],
              updatedAt: now,
            },
          },
          activity: [
            ...waiting.activity,
            {
              type: "push.proposed",
              summary:
                "Kex proposed a push; the exact commit and destination require separate user approval.",
              agentId: "kex" as const,
              taskId: current.task.id,
              attemptId: attempt.id,
            },
          ],
          result: toolResult(
            "Push proposal recorded. End your turn and wait for the user's separate approval in the team panel.",
          ),
        };
      }),
    );
  }, Effect.mapError(toGarrsError));

  const proposeCommit = Effect.fn("GarrsService.proposeCommit")(function* (
    caller: GarrsCaller,
    input: GarrsProposeCommitInput,
  ) {
    const attempt = yield* requireAttempt(caller);
    const id = yield* uuid;
    return yield* mutate(attempt.workItemId, null, (aggregate) =>
      Effect.gen(function* () {
        const current = currentAttempt(aggregate, attempt.id);
        const workspace = aggregate.workItem.workspace;
        if (
          current === null ||
          current.task.agentId !== "kex" ||
          current.task.capability !== "read" ||
          current.attempt.status !== "running" ||
          current.task.status !== "running"
        ) {
          return yield* new GarrsError({
            code: "forbidden",
            message: "Only an active read-only Kex task may propose a commit.",
          });
        }
        if (
          aggregate.workItem.access !== "write" ||
          workspace?.isolated !== true ||
          workspace.checkoutPath === null ||
          (aggregate.workItem.projectContexts?.length ?? 0) > 0
        ) {
          return yield* new GarrsError({
            code: "unavailable",
            message: "A commit proposal requires one isolated write checkout.",
          });
        }
        if (!(yield* isolatedCheckout(aggregate.workItem.projectId, workspace.checkoutPath))) {
          return yield* new GarrsError({
            code: "forbidden",
            message: "The checkout is not a separate worktree of this project.",
          });
        }
        const subject = yield* subjectOf(aggregate);
        if (
          subject.hash === null ||
          !aggregate.reviews.some(
            (review) =>
              review.status === "valid" &&
              review.verdict === "approved" &&
              review.subjectHash === subject.hash,
          )
        ) {
          if (
            subject.hash !== null &&
            aggregate.reviews.some(
              (review) => review.status === "valid" && review.verdict === "approved",
            )
          ) {
            const now = yield* nowIso;
            const waiting = yield* pure(() =>
              Decider.report(aggregate, {
                attemptId: attempt.id,
                report: {
                  outcome: "needs_input",
                  kind: "summary",
                  summary: KEX_WAITING_FOR_REVIEW,
                  body: "",
                  evidence: [],
                  question: KEX_WAITING_FOR_REVIEW,
                },
                artifactId: GarrsArtifactId.make(id),
                contentHash: "",
                workspace: null,
                now,
              }),
            );
            return {
              ...waiting,
              result: toolResult(
                "The staged state changed after review. Copito will review it again; end your turn and wait for the result.",
              ),
            };
          }
          return yield* new GarrsError({
            code: "conflict",
            message: "Copito must approve the current state before a commit is proposed.",
          });
        }
        const inspected = yield* Commit.inspect(workspace.checkoutPath).pipe(
          Effect.provide(subjectContext),
        );
        if (inspected === null) {
          return yield* new GarrsError({
            code: "unavailable",
            message:
              "The prepared tree is incomplete, empty, unreadable or exceeds 64,000 characters. Check the isolated checkout before proposing again.",
          });
        }
        const subjectAfterInspection = yield* subjectOf(aggregate);
        if (subjectAfterInspection.hash !== subject.hash)
          return yield* new GarrsError({
            code: "conflict",
            message: "The reviewed state changed while inspecting the staged tree.",
          });
        const now = yield* nowIso;
        const proposal = {
          id,
          projectId: aggregate.workItem.projectId,
          checkoutPath: workspace.checkoutPath,
          ...inspected,
          reviewSubjectHash: subject.hash,
          message: input.message,
          attemptId: attempt.id,
          status: "proposed" as const,
          createdAt: now,
          approvedAt: null,
        };
        const waiting = yield* pure(() =>
          Decider.report(aggregate, {
            attemptId: attempt.id,
            report: {
              outcome: "needs_input",
              kind: "summary",
              summary: "Commit proposal awaits user approval.",
              body: "",
              evidence: [],
              question: "Review the exact commit proposal in the team panel.",
            },
            artifactId: GarrsArtifactId.make(id),
            contentHash: "",
            workspace: null,
            now,
          }),
        );
        return {
          aggregate: {
            ...waiting.aggregate,
            workItem: {
              ...waiting.aggregate.workItem,
              commitProposal: proposal,
              commitProposalHistory: [
                ...(aggregate.workItem.commitProposalHistory ?? []),
                ...(aggregate.workItem.commitProposal === undefined
                  ? []
                  : [aggregate.workItem.commitProposal]),
              ],
              updatedAt: now,
            },
          },
          activity: [
            ...waiting.activity,
            {
              type: "commit.proposed",
              summary: "Kex proposed a commit for the reviewed checkout; it requires approval.",
              agentId: "kex" as const,
              taskId: current.task.id,
              attemptId: attempt.id,
            },
          ],
          effects: waiting.effects,
          result: toolResult(
            "Commit proposal recorded. End your turn. The user must approve its exact tree before the server creates the commit. A requested push needs its own proposal and approval afterward.",
          ),
        };
      }),
    );
  }, Effect.mapError(toGarrsError));

  const requestHelper = Effect.fn("GarrsService.requestHelper")(function* (
    caller: GarrsCaller,
    input: GarrsRequestHelperInput,
  ) {
    const attempt = yield* requireAttempt(caller);
    const receipt =
      input.clientRequestId === undefined
        ? null
        : {
            key: `helper:${caller.threadId}:${input.clientRequestId}`,
            json: toolResultJson,
          };
    return yield* mutate(attempt.workItemId, receipt, (aggregate, ids) =>
      Effect.gen(function* () {
        const config = yield* store.getConfigRevision(aggregate.workItem.configRevision);
        if (
          config.limits.maxConcurrentAttemptsPerWorkItem < 2 ||
          config.limits.maxConcurrentAttempts < 2
        ) {
          return yield* new GarrsError({
            code: "unavailable",
            message:
              "A temporary helper needs a concurrency limit of at least two, including the requesting attempt.",
          });
        }
        const now = yield* DateTime.now;
        const decision = yield* pure(() =>
          Helpers.request(aggregate, {
            attemptId: attempt.id,
            taskId: ids.newTaskId(),
            objective: input.objective,
            reason: input.reason,
            deadline: DateTime.formatIso(
              DateTime.addDuration(now, Duration.minutes(input.minutes)),
            ),
            now: DateTime.formatIso(now),
          }),
        );
        return {
          ...decision,
          result: toolResult(
            "Temporary read-only helper requested. End your turn; its result will be sent to this task when ready or when its deadline expires.",
          ),
        };
      }),
    );
  }, Effect.mapError(toGarrsError));

  const submitPlan = Effect.fn("GarrsService.submitPlan")(function* (
    caller: GarrsCaller,
    input: GarrsSubmitPlanInput,
  ) {
    const attempt = yield* requireAttempt(caller);
    const planId = GarrsPlanRevisionId.make(yield* uuid);
    return yield* mutate(attempt.workItemId, null, (aggregate, ids) =>
      Effect.gen(function* () {
        const prepared = yield* captureCheckout(aggregate, attempt.id, caller.threadId);
        const binding = (yield* store.getBinding(aggregate.workItem.projectId)).binding;
        const now = yield* nowIso;
        const decision = yield* pure(() =>
          Decider.submitPlan(prepared, {
            attemptId: attempt.id,
            plan: input,
            planId,
            newTaskId: ids.newTaskId,
            autonomy: binding.autonomy,
            now,
          }),
        );
        return {
          ...decision,
          result: (next: WorkAggregate) =>
            toolResult(
              next.workItem.status === "awaiting_approval"
                ? "Plan accepted by the server; it waits for the user's approval. Your task is complete. End your turn."
                : "Plan accepted and active. Your task is complete. End your turn.",
            )(next),
        };
      }),
    );
  }, Effect.mapError(toGarrsError));

  const report = Effect.fn("GarrsService.report")(function* (
    caller: GarrsCaller,
    input: GarrsReportInput,
  ) {
    const attempt = yield* requireAttempt(caller);
    const artifactId = GarrsArtifactId.make(yield* uuid);
    const contentHash = yield* sha256(yield* unknownJson.encode(input));
    return yield* mutate(attempt.workItemId, null, (aggregate) =>
      Effect.gen(function* () {
        const next = yield* captureCheckout(aggregate, attempt.id, caller.threadId);
        const current = currentAttempt(next, attempt.id);
        const shell = yield* threads
          .getThreadShell(caller.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        const workspaceBinding =
          current === null
            ? null
            : (taskProjectContext(next.workItem, current.task.projectId)?.workspace ?? null);
        const checkout = shell?.worktreePath ?? workspaceBinding?.checkoutPath ?? null;
        // Writers record the integrated diff; read-only work proves it changed nothing.
        const workspace =
          checkout === null || current === null
            ? null
            : current.task.capability === "read"
              ? next.workItem.access === "read_only"
                ? yield* workspaceState(checkout, null)
                : null
              : yield* workspaceState(checkout, workspaceBinding?.baseSha ?? null);
        const now = yield* nowIso;
        const decision = yield* pure(() =>
          Decider.report(next, {
            attemptId: attempt.id,
            report: input,
            artifactId,
            contentHash,
            workspace,
            now,
          }),
        );
        return {
          ...decision,
          result: toolResult(
            input.outcome === "done"
              ? "Report recorded. Your task is complete. End your turn."
              : "Recorded. End your turn; you will be resumed when there is an answer.",
          ),
        };
      }),
    );
  }, Effect.mapError(toGarrsError));

  const submitReview = Effect.fn("GarrsService.submitReview")(function* (
    caller: GarrsCaller,
    input: GarrsSubmitReviewInput,
  ) {
    const attempt = yield* requireAttempt(caller);
    const reviewId = GarrsReviewId.make(yield* uuid);
    return yield* mutate(attempt.workItemId, null, (aggregate, ids) =>
      Effect.gen(function* () {
        const config = yield* store.getConfigRevision(aggregate.workItem.configRevision);
        const subject = yield* subjectOf(aggregate);
        const now = yield* nowIso;
        const decision = yield* pure(() =>
          Decider.submitReview(aggregate, {
            attemptId: attempt.id,
            review: input,
            reviewId,
            currentSubjectHash: subject.hash,
            newTaskId: ids.newTaskId,
            maxCorrectionCycles: config.limits.maxCorrectionCycles,
            now,
          }),
        );
        const recorded = decision.aggregate.reviews.find((review) => review.id === reviewId);
        return {
          ...decision,
          result: toolResult(
            recorded?.status === "valid"
              ? `Review recorded against subject ${recorded.subjectHash.slice(0, 12)}. Your task is complete. End your turn.`
              : `Review recorded but not counted: ${recorded?.invalidatedReason ?? "the subject changed"} A new review of the current state is scheduled. End your turn.`,
          ),
        };
      }),
    );
  }, Effect.mapError(toGarrsError));

  const sendMessage = Effect.fn("GarrsService.sendMessage")(function* (
    caller: GarrsCaller,
    input: GarrsSendMessageInput,
  ) {
    const member = yield* resolveMember(caller);
    const attempt =
      member.attemptId === null ? null : yield* store.findAttemptByThread(caller.threadId);
    const workItemId = attempt?.workItemId ?? input.workItemId;
    if (workItemId === undefined) {
      return yield* new GarrsError({
        code: "invalid",
        message: "Name the workItemId the message belongs to.",
      });
    }
    const messageId = GarrsMessageId.make(yield* uuid);
    const receipt =
      input.clientRequestId === undefined
        ? null
        : { key: `message:${caller.threadId}:${input.clientRequestId}`, json: toolResultJson };
    return yield* mutate(workItemId, receipt, (aggregate) =>
      Effect.gen(function* () {
        if (member.agentId === "garras") yield* garrasOwns(aggregate.workItem, caller);
        if (attempt !== null && currentAttempt(aggregate, attempt.id) === null) {
          return yield* new GarrsError({
            code: "conflict",
            message: "This attempt is no longer current.",
          });
        }
        const config = yield* store.getConfigRevision(aggregate.workItem.configRevision);
        const now = yield* nowIso;
        const decision = yield* pure(() =>
          Decider.sendMessage(aggregate, {
            from: member.agentId,
            fromTaskId: attempt?.taskId ?? null,
            message: input,
            messageId,
            maxMessagesPerTask: config.limits.maxMessagesPerTask,
            now,
          }),
        );
        return {
          ...decision,
          result: (next: WorkAggregate): GarrsToolResult => {
            const sent = next.messages.find((message) => message.id === messageId);
            return {
              ok: true,
              message: `Message ${messageId} stored; delivery status is ${sent?.deliveryStatus ?? "pending"}.`,
              workItemId: next.workItem.id,
            };
          },
        };
      }),
    );
  }, Effect.mapError(toGarrsError));

  // ── User controls ────────────────────────────────────────────────────────

  const control = Effect.fn("GarrsService.control")(function* (input: GarrsControlInput) {
    return yield* mutate(
      input.workItemId,
      { key: `control:${input.commandId}`, json: controlResultJson },
      (aggregate) =>
        Effect.gen(function* () {
          const action = input.action;
          if (action.type === "approve_push") {
            const proposal = aggregate.workItem.pushProposal;
            if (
              proposal?.id !== action.proposalId ||
              proposal.status !== "proposed" ||
              (yield* pushInputFor(aggregate, proposal)) === null
            )
              return yield* new GarrsError({
                code: "conflict",
                message:
                  "The push proposal, checkout or remote changed. Ask Kex for a new proposal.",
              });
          }
          if (action.type === "approve_commit") {
            const proposal = aggregate.workItem.commitProposal;
            const workspace = aggregate.workItem.workspace;
            if (
              proposal === undefined ||
              proposal.id !== action.proposalId ||
              proposal.status !== "proposed" ||
              !proposal.diff ||
              workspace?.isolated !== true ||
              workspace.checkoutPath !== proposal.checkoutPath ||
              aggregate.workItem.projectId !== proposal.projectId
            ) {
              return yield* new GarrsError({
                code: "conflict",
                message: "The commit proposal changed; review the current proposal first.",
              });
            }
            if (!(yield* isolatedCheckout(proposal.projectId, proposal.checkoutPath))) {
              return yield* new GarrsError({
                code: "conflict",
                message: "The isolated checkout is no longer available.",
              });
            }
            const requester = currentAttempt(aggregate, proposal.attemptId);
            if (
              requester?.attempt.status !== "running" ||
              requester.task.status !== "waiting_response"
            ) {
              return yield* new GarrsError({
                code: "conflict",
                message: "The Kex attempt is no longer awaiting approval.",
              });
            }
            const subject = yield* subjectOf(aggregate);
            const inspected = yield* Commit.inspect(proposal.checkoutPath).pipe(
              Effect.provide(subjectContext),
            );
            const subjectAfterInspection = yield* subjectOf(aggregate);
            if (
              subjectAfterInspection.hash !== subject.hash ||
              subject.hash !== proposal.reviewSubjectHash ||
              !aggregate.reviews.some(
                (review) =>
                  review.status === "valid" &&
                  review.verdict === "approved" &&
                  review.subjectHash === subject.hash,
              ) ||
              inspected === null ||
              inspected.branchRef !== proposal.branchRef ||
              inspected.parentSha !== proposal.parentSha ||
              inspected.treeSha !== proposal.treeSha ||
              inspected.diff !== proposal.diff
            ) {
              const now = yield* nowIso;
              const reviewChanged =
                subjectAfterInspection.hash !== null &&
                subjectAfterInspection.hash !== proposal.reviewSubjectHash;
              const reason = reviewChanged
                ? "The commit was not approved because the reviewed state changed. Copito will review the new state before Kex can propose again."
                : "The commit was not approved because the staged tree or checkout cannot be verified. Kex will report the problem; correct it before requesting a new proposal.";
              return {
                aggregate: {
                  ...aggregate,
                  workItem: {
                    ...aggregate.workItem,
                    commitProposal: {
                      ...proposal,
                      status: "failed" as const,
                      failureReason: reason,
                    },
                    updatedAt: now,
                  },
                  tasks: aggregate.tasks.map((entry) =>
                    entry.id === requester.task.id
                      ? {
                          ...entry,
                          status: reviewChanged
                            ? ("waiting_response" as const)
                            : ("running" as const),
                          statusReason: reviewChanged ? KEX_WAITING_FOR_REVIEW : null,
                          updatedAt: now,
                        }
                      : entry,
                  ),
                },
                activity: [
                  {
                    type: "commit.invalidated",
                    summary: reason,
                    agentId: "kex" as const,
                    taskId: requester.task.id,
                    attemptId: requester.attempt.id,
                  },
                ],
                effects: reviewChanged
                  ? []
                  : [
                      {
                        kind: "resume_attempt" as const,
                        attemptId: requester.attempt.id,
                        text: reason,
                      },
                    ],
                result: (next: WorkAggregate): GarrsControlResult => ({
                  workItem: next.workItem,
                  effect: reason,
                }),
              };
            }
          }
          if (action.type === "reassign_task") {
            const task = aggregate.tasks.find((entry) => entry.id === action.taskId);
            const catalog = yield* catalogFor(task?.projectId ?? aggregate.workItem.projectId);
            const check = selectModel({
              agentId: task?.agentId ?? "botas",
              pinned: { selection: action.selection, by: "user" },
              projectOverrides: [],
              teamPolicy: [],
              catalog,
              requirements: { readOnly: task?.capability === "read" },
              failures: yield* modelFailures(),
              now: yield* nowIso,
            });
            if (!check.ok) {
              return yield* new GarrsError({ code: "invalid", message: check.reason });
            }
          }
          const now = yield* nowIso;
          const decision = yield* pure(() => Decider.control(aggregate, action, now));
          return {
            ...decision,
            result: (next: WorkAggregate): GarrsControlResult => ({
              workItem: next.workItem,
              effect: decision.effect,
            }),
          };
        }),
    );
  }, Effect.mapError(toGarrsError));

  // ── Portable config ──────────────────────────────────────────────────────

  const exportConfig = Effect.fn("GarrsService.exportConfig")(function* (
    projectId: ProjectId | undefined,
  ) {
    const config = yield* store.getConfig();
    const binding = projectId === undefined ? null : (yield* store.getBinding(projectId)).binding;
    return {
      format: "t3code.garrs.config",
      schemaVersion: 1,
      exportedAt: yield* nowIso,
      team: config.config,
      ...(binding === null
        ? {}
        : {
            project: {
              rulePaths: binding.rulePaths,
              autonomy: binding.autonomy,
              allowedProviderInstanceIds: binding.allowedProviderInstanceIds,
              modelOverrides: binding.modelOverrides,
            },
          }),
    } satisfies GarrsPortableConfig;
  }, Effect.mapError(toGarrsError));

  const importConfig = Effect.fn("GarrsService.importConfig")(function* (
    input: GarrsImportConfigInput,
  ) {
    const issues: Array<GarrsImportIssue> = [];
    const parsed = yield* Effect.result(unknownJson.decode(input.document));
    if (Result.isFailure(parsed)) {
      return {
        applied: false,
        issues: [{ severity: "error", path: "$", message: "Not valid JSON." }],
        changes: [],
      } satisfies GarrsImportConfigResult;
    }
    const header = parsed.success as {
      readonly format?: unknown;
      readonly schemaVersion?: unknown;
    } | null;
    if (header?.format !== "t3code.garrs.config") {
      issues.push({
        severity: "error",
        path: "format",
        message: "Not a Garrs configuration export.",
      });
    } else if (header.schemaVersion !== 1) {
      issues.push({
        severity: "error",
        path: "schemaVersion",
        message: `Unsupported version ${String(header.schemaVersion)}; this server reads version 1.`,
      });
    }
    const decoded = decodePortableConfig(parsed.success);
    if (issues.length === 0 && Option.isNone(decoded)) {
      issues.push({
        severity: "error",
        path: "$",
        message: "The document does not match the Garrs configuration schema.",
      });
    }
    if (Option.isNone(decoded) || issues.some((issue) => issue.severity === "error")) {
      return { applied: false, issues, changes: [] } satisfies GarrsImportConfigResult;
    }
    const document = decoded.value;
    const catalog = input.projectId === undefined ? [] : yield* catalogFor(input.projectId);
    const known = new Set(
      (yield* providers.getProviders).map((provider): string => provider.instanceId),
    );
    const checkSelections = (where: string, selections: ReadonlyArray<ModelSelection>) => {
      for (const selection of selections) {
        if (!known.has(selection.instanceId)) {
          issues.push({
            severity: "warning",
            path: where,
            message: `Provider instance ${selection.instanceId} does not exist here.`,
          });
          continue;
        }
        const instance = catalog.find((entry) => entry.instanceId === selection.instanceId);
        if (instance !== undefined && !instance.models.includes(selection.model)) {
          issues.push({
            severity: "warning",
            path: where,
            message: `Model ${selection.model} is not offered by ${selection.instanceId}.`,
          });
        }
      }
    };
    document.team.modelPolicy.forEach((policy, index) =>
      checkSelections(`team.modelPolicy[${index}]`, policy.candidates),
    );
    document.project?.modelOverrides.forEach((policy, index) =>
      checkSelections(`project.modelOverrides[${index}]`, policy.candidates),
    );
    if (document.project !== undefined && input.projectId === undefined) {
      issues.push({
        severity: "warning",
        path: "project",
        message: "Project settings are ignored without a target project.",
      });
    }
    if (document.project !== undefined && input.projectId !== undefined) {
      const root = yield* workspaceRoot(input.projectId);
      const rules = yield* readRules(root, document.project.rulePaths);
      for (const rule of rules.filter((entry) => entry.status !== "read")) {
        issues.push({
          severity: "warning",
          path: "project.rulePaths",
          message: `${rule.path} is ${rule.status} in this project.`,
        });
      }
    }
    const current = yield* store.getConfig();
    const imported = normalizeTeamConfig(document.team);
    const changes: Array<string> = [];
    for (const key of Object.keys(imported) as Array<keyof GarrsTeamConfig>) {
      const before = yield* unknownJson.encode(current.config[key]);
      const after = yield* unknownJson.encode(imported[key]);
      if (before !== after) changes.push(`team.${key}`);
    }
    if (!input.apply) {
      return { applied: false, issues, changes } satisfies GarrsImportConfigResult;
    }
    // Applying never overwrites silently: the caller names the revision it previewed.
    yield* store.saveConfig(input.expectedRevision, imported, yield* nowIso);
    if (document.project !== undefined && input.projectId !== undefined) {
      const binding = yield* store.getBinding(input.projectId);
      yield* store.saveBinding(
        binding.revision,
        { ...binding.binding, ...document.project },
        yield* nowIso,
      );
      yield* publish(`project:${input.projectId}`);
    }
    yield* publish("config");
    return { applied: true, issues, changes } satisfies GarrsImportConfigResult;
  }, Effect.mapError(toGarrsError));

  // ── Usage and memory ─────────────────────────────────────────────────────

  const getUsage = Effect.fn("GarrsService.getUsage")(function* (input: GarrsUsageInput) {
    const limit = input.limit ?? 1_000;
    const rows = yield* store.listUsageAttempts({
      projectId: input.projectId,
      agentId: input.agentId,
      providerInstanceId: input.providerInstanceId,
      model: input.model,
      since: input.since,
      until: input.until,
      limit: limit + 1,
    });
    const conversationRecords = yield* store.listConversationUsage({
      projectId: input.projectId,
      agentId: input.agentId,
      providerInstanceId: input.providerInstanceId,
      model: input.model,
      since: input.since,
      until: input.until,
      limit: limit + 1,
    });
    const conversations = conversationUsage(
      conversationRecords.candidates.slice(0, limit),
      conversationRecords.turns,
      conversationRecords.turnsTruncated,
    );
    const priceContext =
      !rows.some(({ attempt }) => canEstimateUsage(attempt.usage)) &&
      !conversations.some(({ usage }) => canEstimateUsage(usage))
        ? null
        : yield* usageService.readPriceContext.pipe(Effect.orElseSucceed(() => null));
    return {
      truncated: rows.length > limit,
      conversationsTruncated: conversationRecords.candidates.length > limit,
      conversationEvidenceTruncated: conversationRecords.turnsTruncated,
      conversations: conversations.map(({ threadId, projectId, run, usage }) => {
        const estimatedCostUsd =
          priceContext === null
            ? null
            : estimateUsage(
                usage,
                run.modelSelection.model,
                priceContext.rates,
                priceContext.overrides,
                confirmedUsageModel(usage),
              );
        const estimatePriceSource =
          estimatedCostUsd === null || priceContext === null
            ? null
            : priceContext.overrides.has(run.modelSelection.model.trim())
              ? ("override" as const)
              : priceContext.pricing.status === "unavailable"
                ? null
                : priceContext.pricing.status;
        return {
          threadId,
          projectId,
          runId: run.id,
          agentId: "garras" as const,
          providerInstanceId: run.providerInstanceId,
          model: run.modelSelection.model,
          effectiveModel: confirmedUsageModel(usage),
          status: run.status,
          createdAt: DateTime.formatIso(run.requestedAt),
          startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
          endedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
          usage: {
            ...usage,
            providerTurns:
              usage.quality === "unknown" && usage.providerTurns === 0 ? null : usage.providerTurns,
          },
          estimatedCostUsd,
          estimatePriceSource,
        };
      }),
      rows: rows.slice(0, limit).map(({ attempt, workItem, task }) => {
        const estimatedCostUsd =
          priceContext === null
            ? null
            : estimateUsage(
                attempt.usage,
                attempt.decision.requested.model,
                priceContext.rates,
                priceContext.overrides,
                attempt.decision.effectiveModelSource === "provider_session" ||
                  attempt.decision.effectiveModelSource === "provider_response"
                  ? attempt.decision.effectiveModel
                  : null,
              );
        const estimatePriceSource =
          estimatedCostUsd === null || priceContext === null
            ? null
            : priceContext.overrides.has(attempt.decision.requested.model.trim())
              ? ("override" as const)
              : priceContext.pricing.status === "unavailable"
                ? null
                : priceContext.pricing.status;
        return {
          attemptId: attempt.id,
          workItemId: workItem.id,
          workItemTitle: workItem.title,
          projectId: task?.projectId ?? workItem.projectId,
          taskId: attempt.taskId,
          ...(task?.helper === undefined ? {} : { helper: task.helper }),
          agentId: attempt.agentId,
          providerInstanceId: attempt.decision.requested.instanceId,
          model: attempt.decision.requested.model,
          effectiveModel:
            attempt.decision.effectiveModelSource === "provider_session" ||
            attempt.decision.effectiveModelSource === "provider_response"
              ? attempt.decision.effectiveModel
              : null,
          estimatedCostUsd,
          estimatePriceSource,
          status: attempt.status,
          createdAt: attempt.createdAt,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt,
          usage: attempt.usage,
        };
      }),
    } satisfies GarrsUsageResult;
  }, Effect.mapError(toGarrsError));

  const listMemory = Effect.fn("GarrsService.listMemory")(function* (projectId: ProjectId) {
    return { entries: yield* store.listMemory(projectId) } satisfies GarrsMemoryListResult;
  }, Effect.mapError(toGarrsError));

  const mutateMemory = Effect.fn("GarrsService.mutateMemory")(function* (
    input: GarrsMemoryMutation,
  ) {
    const now = yield* nowIso;
    if (input.type === "delete") {
      if (!(yield* store.deleteMemory(input.id, input.projectId))) {
        return yield* new GarrsError({
          code: "not_found",
          message: "Memory entry not found in this project.",
        });
      }
      return { entries: yield* store.listMemory(input.projectId) };
    }
    const existing =
      input.id === undefined
        ? undefined
        : (yield* store.listMemory(input.projectId)).find((entry) => entry.id === input.id);
    yield* store.putMemory({
      id: input.id ?? GarrsMemoryId.make(yield* uuid),
      projectId: input.projectId,
      kind: input.kind,
      body: input.body,
      provenance: input.provenance,
      scope: input.scope,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { entries: yield* store.listMemory(input.projectId) };
  }, Effect.mapError(toGarrsError));

  // ── Effects ──────────────────────────────────────────────────────────────

  const sendText = (projectId: ProjectId, threadId: ThreadId, key: string, text: string) =>
    threads.sendToThread({
      projectId,
      commandId: CommandId.make(`garrs:send:${key}`),
      threadId,
      messageId: MessageId.make(`garrs-message:${key}`),
      text,
      attachments: [],
      mode: "auto",
      createdBy: "system",
      creationSource: "server",
    });

  const stopThread = Effect.fn("GarrsService.stopThread")(function* (
    threadId: ThreadId,
    attemptId: GarrsAttemptId,
  ) {
    yield* threads.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`garrs:stop:${attemptId}`),
      threadId,
      reason: "Stopped by Garrs.",
    });
    const projection = yield* threads.getThreadProjection(threadId);
    const run = ThreadManagement.latestRun(projection);
    if (run === undefined || ThreadManagement.isTerminalRunStatus(run.status))
      yield* onRunEnded(threadId, run?.status ?? "cancelled", run?.id);
  });

  const launchAttempt = Effect.fn("GarrsService.launchAttempt")(function* (
    attemptId: GarrsAttemptId,
    workItemId: GarrsWorkItemId,
  ) {
    const aggregate = yield* loadOrFail(workItemId);
    const current = currentAttempt(aggregate, attemptId);
    if (current === null || current.attempt.status !== "launching") return;
    const { attempt, task } = current;
    if (task.helper !== undefined && task.helper.deadline <= (yield* nowIso)) {
      yield* mutate(workItemId, null, (latest) =>
        Effect.map(nowIso, (now) => ({
          ...Helpers.expire(latest, now),
          result: () => undefined,
        })),
      );
      return;
    }
    const config = yield* store.getConfigRevision(aggregate.workItem.configRevision);
    const projectContext = taskProjectContext(aggregate.workItem, task.projectId);
    if (task.projectId !== aggregate.workItem.projectId && projectContext === null) {
      return yield* new GarrsError({
        code: "invalid",
        message: "The task's project context is unavailable.",
      });
    }
    const rootResult = yield* Effect.result(
      task.projectId === aggregate.workItem.projectId
        ? workspaceRoot(task.projectId)
        : linkedWorkspaceRoot(task.projectId),
    );
    const recordedIdentity =
      projectContext?.repositoryIdentity ?? aggregate.workItem.repositoryIdentity;
    const recordedRoot = projectContext?.projectRoot ?? aggregate.workItem.projectRoot;
    const hasProjectBindings = (aggregate.workItem.projectContexts?.length ?? 0) > 0;
    const matches =
      Result.isSuccess(rootResult) &&
      (!hasProjectBindings ||
        (yield* matchesRepository(rootResult.success, recordedRoot, recordedIdentity)));
    if (!matches || Result.isFailure(rootResult)) {
      yield* mutate(workItemId, null, (latest) =>
        Effect.map(nowIso, (now) => {
          const active = currentAttempt(latest, attempt.id);
          if (active === null || active.attempt.status !== "launching") {
            return { aggregate: latest, activity: [], effects: [], result: () => undefined };
          }
          const reason =
            "The task's project is unavailable, or its recorded repository or path changed.";
          const next = replaceAttempt(latest, {
            ...active.attempt,
            status: "failed",
            error: reason,
            endedAt: now,
          });
          return {
            aggregate: {
              ...next,
              tasks: next.tasks.map((entry) =>
                entry.id === active.task.id
                  ? { ...entry, status: "failed" as const, statusReason: reason, updatedAt: now }
                  : entry,
              ),
            },
            activity: [
              {
                type: "attempt.launch_failed",
                summary: reason,
                agentId: task.agentId,
                taskId: task.id,
                attemptId: attempt.id,
              },
            ],
            effects: [],
            result: () => undefined,
          };
        }),
      );
      return;
    }
    const root = rootResult.success;
    const workspace = projectContext?.workspace ?? aggregate.workItem.workspace;
    const threadId = ThreadId.make(`${ATTEMPT_THREAD_PREFIX}${attempt.id}`);
    const checkout = workspace?.checkoutPath ?? null;
    // Write work shares one isolated checkout; read-only work reads the project as it is.
    const workspaceStrategy: ThreadLaunchService.ThreadLaunchWorkspaceStrategy =
      checkout !== null && checkout !== root
        ? { type: "existing_worktree", worktreePath: checkout }
        : aggregate.workItem.access === "write" && workspace?.baseSha != null
          ? {
              type: "worktree",
              baseRef: workspace.baseSha,
              branch: `garrs/${aggregate.workItem.id.slice(0, 8)}`,
            }
          : { type: "root" };
    const dependencies = aggregate.artifacts.filter((artifact) =>
      aggregate.tasks.some(
        (entry) =>
          entry.status === "completed" &&
          task.dependsOn.includes(entry.key) &&
          entry.completionArtifactId === artifact.id,
      ),
    );
    const plan = aggregate.plans.find((entry) => entry.status === "active");
    const memory = yield* store.listMemory(task.projectId);
    const currentRules = yield* readRules(
      root,
      (projectContext?.rules ?? aggregate.workItem.rules).map((rule) => rule.path),
    );
    let brief = Instructions.taskBrief({
      workItem: aggregate.workItem,
      task,
      dependencies,
      planSummary: plan?.summary ?? null,
      memory,
      rules: currentRules,
      checkoutPath: workspaceStrategy.type === "worktree" ? null : (checkout ?? root),
      rulesRoot: root,
      attemptNumber: task.attemptCount,
    });
    if (isReviewTask(task)) {
      const subject = yield* subjectOf(aggregate);
      const reviewProjects = yield* Effect.forEach(
        aggregate.workItem.projectContexts ?? [],
        (project) =>
          Effect.gen(function* () {
            const projectCheckout = project.workspace.checkoutPath;
            if (projectCheckout === null) return null;
            const rules = yield* readRules(
              projectCheckout,
              project.rules.map((rule) => rule.path),
            );
            const state = yield* workspaceState(
              projectCheckout,
              aggregate.workItem.access === "write" ? project.workspace.baseSha : null,
            );
            return {
              projectId: project.projectId,
              checkout: projectCheckout,
              rulesRoot: project.projectRoot ?? projectCheckout,
              baseSha: project.workspace.baseSha,
              rules,
              changedFiles: state.changedFiles,
            };
          }),
      );
      // Copito is told the subject it was scheduled against; a mismatch here already means drift.
      brief += Instructions.reviewBrief({
        subjectHash: attempt.reviewSubjectHash ?? "unavailable",
        changedFiles: subject.state?.changedFiles ?? [],
        baseSha: workspace?.baseSha ?? null,
        projects: reviewProjects.filter((project) => project !== null),
      });
      brief += Instructions.teamWork(
        aggregate.artifacts.filter((artifact) =>
          aggregate.tasks.some(
            (entry) => entry.id === artifact.taskId && entry.status !== "cancelled",
          ),
        ),
        aggregate.tasks,
        aggregate.workItem.access,
      );
    }
    yield* store.registerThread(
      {
        threadId,
        projectId: task.projectId,
        agentId: task.agentId,
        attemptId: attempt.id,
        readOnly: task.capability === "read",
        instructions: Instructions.memberInstructions(config, task),
        configRevision: aggregate.workItem.configRevision,
      },
      yield* nowIso,
    );
    const profile = config.profiles.find((entry) => entry.agentId === task.agentId);
    const launchBinding = (yield* store.getBinding(task.projectId)).binding;
    const launchConfig = (yield* store.getConfig()).config;
    const checkedSelection = selectModel({
      agentId: task.agentId,
      pinned: {
        selection: attempt.decision.requested,
        by: task.pinnedBy ?? "coordinator",
        reason: attempt.decision.reason,
      },
      projectOverrides: launchBinding.modelOverrides,
      teamPolicy: launchConfig.modelPolicy,
      catalog: yield* catalogFor(task.projectId),
      requirements: { readOnly: task.capability === "read" },
      failures: yield* modelFailures(),
      now: yield* nowIso,
    });
    const launched = !checkedSelection.ok
      ? Result.fail(new GarrsError({ code: "unavailable", message: checkedSelection.reason }))
      : task.capability === "git"
        ? Result.fail(new GarrsError({ code: "unavailable", message: GIT_OPERATION_UNAVAILABLE }))
        : yield* launcher
            .launch({
              commandId: CommandId.make(`garrs:launch:${attempt.id}`),
              threadId,
              parentThreadId: aggregate.workItem.garrasThreadId,
              projectId: task.projectId,
              title: `${profile?.displayName ?? task.agentId}: ${task.title}`.slice(0, 120),
              modelSelection: attempt.decision.requested,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy,
              initialMessage: { text: brief, attachments: [] },
              createdBy: "agent",
              creationSource: "server",
            })
            .pipe(
              Effect.mapError(
                (cause) => new GarrsError({ code: "unavailable", message: cause.message }),
              ),
              Effect.result,
            );
    let stopNow = false;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const latest = yield* loadOrFail(workItemId);
        const live = latest.attempts.find((entry) => entry.id === attempt.id);
        if (live === undefined) return;
        const at = yield* nowIso;
        let next: WorkAggregate;
        if (Result.isFailure(launched)) {
          const failedTask = latest.tasks.find((entry) => entry.id === task.id);
          next = replaceAttempt(latest, {
            ...live,
            status: "failed",
            error: `Launch failed: ${launched.failure.message}`.slice(0, 2_000),
            endedAt: at,
          });
          if (failedTask?.status === "running" && failedTask.generation === live.generation) {
            next = {
              ...next,
              tasks: next.tasks.map((entry) =>
                entry.id === failedTask.id
                  ? {
                      ...entry,
                      status: "ready" as const,
                      statusReason: "Launch failed; retrying within the attempt limit.",
                      updatedAt: at,
                    }
                  : entry,
              ),
            };
          }
        } else {
          const run = ThreadManagement.latestRun(launched.success.projection);
          next = replaceAttempt(latest, {
            ...live,
            threadId,
            runId: run?.id ?? null,
            status: live.status === "launching" ? "running" : live.status,
            startedAt: at,
          });
          const worktree = launched.success.projection.thread.worktreePath;
          const binding = next.workItem.workspace;
          if (
            task.projectId === next.workItem.projectId &&
            binding !== null &&
            binding.checkoutPath === null &&
            worktree !== null
          ) {
            next = {
              ...next,
              workItem: { ...next.workItem, workspace: { ...binding, checkoutPath: worktree } },
            };
          }
          if (
            task.projectId !== next.workItem.projectId &&
            worktree !== null &&
            next.workItem.projectContexts !== undefined
          ) {
            next = {
              ...next,
              workItem: {
                ...next.workItem,
                projectContexts: next.workItem.projectContexts.map((context) =>
                  context.projectId === task.projectId && context.workspace.checkoutPath === null
                    ? { ...context, workspace: { ...context.workspace, checkoutPath: worktree } }
                    : context,
                ),
              },
            };
          }
          // A stop requested while launching applies now that the thread exists.
          stopNow = live.status === "cancel_requested";
        }
        yield* reconcileAndCommit({
          previous: latest,
          ids: idsFor(workItemId, latest),
          decision: {
            aggregate: next,
            activity: [
              Result.isFailure(launched)
                ? {
                    type: "attempt.launch_failed",
                    summary: `Launch failed: ${launched.failure.message}`.slice(0, 2_000),
                    agentId: task.agentId,
                    taskId: task.id,
                    attemptId: attempt.id,
                  }
                : {
                    type: "attempt.started",
                    summary: `${task.agentId} is working in thread ${threadId}.`,
                    agentId: task.agentId,
                    taskId: task.id,
                    attemptId: attempt.id,
                  },
            ],
            effects:
              Result.isFailure(launched) || stopNow
                ? []
                : Decider.pendingMessageEffects(next, attempt.id),
          },
        });
      }),
    );
    if (stopNow) yield* stopThread(threadId, attempt.id);
  });

  const runEffect = Effect.fn("GarrsService.runEffect")(function* (row: GarrsStore.OutboxRow) {
    const effect: GarrsEffect = row.effect;
    switch (effect.kind) {
      case "execute_push":
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            let aggregate = yield* loadOrFail(row.workItemId);
            let proposal = aggregate.workItem.pushProposal;
            if (
              proposal?.id !== effect.proposalId ||
              !["approved", "sending"].includes(proposal.status)
            )
              return;
            const commit = aggregate.workItem.commitProposal;
            let status: GarrsPushProposal["status"] = "failed";
            let reason: string | null =
              "The approved checkout, commit, task or destination changed; no push was started.";
            if (
              commit?.id === proposal.commitProposalId &&
              commit.commitSha === proposal.commitSha &&
              (yield* isolatedCheckout(commit.projectId, commit.checkoutPath))
            ) {
              const recoveryInput = {
                checkoutPath: commit.checkoutPath,
                localBranchRef: commit.branchRef,
                commitSha: proposal.commitSha,
                remote: proposal.remote,
                branchRef: proposal.branchRef,
                destinationHash: proposal.destinationHash,
                expectedRemoteSha: proposal.expectedRemoteSha,
              };
              const recovering = proposal.status === "sending";
              const input = recovering ? null : yield* pushInputFor(aggregate, proposal);
              if (recovering || input !== null) {
                if (!recovering && input !== null) {
                  const now = yield* nowIso;
                  aggregate = yield* reconcileAndCommit({
                    previous: aggregate,
                    ids: idsFor(row.workItemId, aggregate),
                    decision: {
                      aggregate: {
                        ...aggregate,
                        workItem: {
                          ...aggregate.workItem,
                          pushProposal: { ...proposal, status: "sending" },
                          updatedAt: now,
                        },
                      },
                      activity: [],
                      effects: [],
                    },
                  });
                  proposal = aggregate.workItem.pushProposal!;
                  yield* Push.execute(input).pipe(Effect.provide(subjectContext));
                }
                const remote = yield* Push.remoteSha(recoveryInput).pipe(
                  Effect.provide(subjectContext),
                );
                if (remote?.sha === proposal.commitSha) {
                  status = "pushed";
                  reason = null;
                } else if (recovering || remote === null) {
                  status = "outcome_unknown";
                  reason =
                    "The push outcome could not be confirmed. Inspect the approved remote branch before requesting another push.";
                } else
                  reason =
                    "The approved commit was not observed on the remote. Check authentication, remote policy and branch history before requesting a new proposal.";
              }
            }
            const now = yield* nowIso;
            const requester = currentAttempt(aggregate, proposal.attemptId);
            const resume =
              requester?.attempt.status === "running" &&
              requester.task.status === "waiting_response" &&
              !isWorkTerminal(aggregate.workItem);
            const text =
              status === "pushed"
                ? `The server confirmed push of ${proposal.commitSha} to ${proposal.remote} ${proposal.branchRef}. Report the result.`
                : reason!;
            yield* reconcileAndCommit({
              previous: aggregate,
              ids: idsFor(row.workItemId, aggregate),
              decision: {
                aggregate: {
                  ...aggregate,
                  workItem: {
                    ...aggregate.workItem,
                    pushProposal: { ...proposal, status, failureReason: reason },
                    updatedAt: now,
                  },
                  tasks: resume
                    ? aggregate.tasks.map((task) =>
                        task.id === requester!.task.id
                          ? {
                              ...task,
                              status: "running" as const,
                              statusReason: null,
                              updatedAt: now,
                            }
                          : task,
                      )
                    : aggregate.tasks,
                },
                activity: [
                  {
                    type: `push.${status}`,
                    summary: text,
                    agentId: "kex",
                    taskId: requester?.task.id ?? null,
                    attemptId: proposal.attemptId,
                  },
                ],
                effects: [
                  { kind: "notify_garras", text },
                  ...(resume
                    ? [{ kind: "resume_attempt" as const, attemptId: proposal.attemptId, text }]
                    : []),
                ],
              },
            });
          }),
        );
      case "prepare_commit":
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const aggregate = yield* loadOrFail(row.workItemId);
            const preparation = aggregate.workItem.commitPreparation;
            if (preparation?.status !== "pending" || preparation.taskId !== effect.taskId) return;
            const workspace = aggregate.workItem.workspace;
            if (isWorkTerminal(aggregate.workItem)) return;
            const task = aggregate.tasks.find((entry) => entry.id === effect.taskId);
            let reason: string | null = "The isolated checkout or Kex task is no longer available.";
            if (
              task !== undefined &&
              ["pending", "waiting_dependency", "ready"].includes(task.status) &&
              aggregate.workItem.status !== "paused" &&
              aggregate.tasks.every(
                (entry) =>
                  entry.agentId === "kex" ||
                  isReviewTask(entry) ||
                  entry.helper !== undefined ||
                  ["completed", "cancelled"].includes(entry.status),
              ) &&
              !(yield* unfinishedWriteTurns(aggregate)) &&
              workspace?.isolated === true &&
              workspace.checkoutPath !== null &&
              (aggregate.workItem.projectContexts?.length ?? 0) === 0 &&
              (yield* isolatedCheckout(aggregate.workItem.projectId, workspace.checkoutPath))
            ) {
              reason = yield* Commit.prepare(workspace.checkoutPath).pipe(
                Effect.provide(subjectContext),
              );
            }
            const subject = yield* subjectOf(aggregate);
            if (reason === null && subject.hash === null)
              reason = "The prepared changes cannot be verified for review.";
            const now = yield* nowIso;
            yield* reconcileAndCommit({
              previous: aggregate,
              ids: idsFor(row.workItemId, aggregate),
              decision: {
                aggregate: {
                  ...aggregate,
                  workItem: {
                    ...aggregate.workItem,
                    commitPreparation: {
                      ...preparation,
                      status: reason === null ? "prepared" : "failed",
                      subjectHash: subject.hash,
                      reason,
                    },
                    ...(reason === null || aggregate.workItem.status === "paused"
                      ? {}
                      : { status: "blocked" as const, statusReason: reason }),
                    updatedAt: now,
                  },
                },
                activity: [
                  {
                    type: reason === null ? "commit.staged" : "commit.staging_failed",
                    summary:
                      reason ??
                      "The server staged the isolated changes for Copito's independent review.",
                    agentId: "kex",
                    taskId: effect.taskId,
                    attemptId: null,
                  },
                ],
                effects: [],
              },
            });
          }),
        );
      case "execute_commit":
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            let aggregate = yield* loadOrFail(row.workItemId);
            let proposal = aggregate.workItem.commitProposal;
            if (
              proposal === undefined ||
              proposal.id !== effect.proposalId ||
              proposal.status === "committed"
            )
              return;
            if (proposal.status !== "approved" && proposal.status !== "prepared") {
              return yield* new GarrsError({
                code: "conflict",
                message: "The commit proposal is no longer approved.",
              });
            }
            if (!(yield* isolatedCheckout(proposal.projectId, proposal.checkoutPath))) {
              return yield* new GarrsError({
                code: "conflict",
                message: "The isolated checkout is no longer available.",
              });
            }
            const completedDecision = (
              state: WorkAggregate,
              sha: string,
              now: string,
            ): Decision => {
              const current = currentAttempt(state, proposal!.attemptId);
              const resume =
                current?.task.status === "waiting_response" &&
                current.attempt.status === "running" &&
                current.attempt.threadId !== null;
              return {
                aggregate: {
                  ...state,
                  tasks: resume
                    ? state.tasks.map((task) =>
                        task.id === current!.task.id
                          ? {
                              ...task,
                              status: "running" as const,
                              statusReason: null,
                              updatedAt: now,
                            }
                          : task,
                      )
                    : state.tasks,
                  workItem: {
                    ...state.workItem,
                    commitProposal: { ...proposal!, status: "committed", commitSha: sha },
                    updatedAt: now,
                  },
                },
                activity: [
                  {
                    type: "commit.created",
                    summary: `Commit ${sha} was created.`,
                    agentId: "kex",
                    taskId: null,
                    attemptId: proposal!.attemptId,
                  },
                ],
                effects: [
                  {
                    kind: "notify_garras",
                    text: `Commit ${sha} was created from the approved proposal. No push was performed.`,
                  },
                  ...(resume
                    ? [
                        {
                          kind: "resume_attempt" as const,
                          attemptId: proposal!.attemptId,
                          text: `The approved commit ${sha} was created. If the human requested push, use propose_push and wait for separate approval; otherwise report the result. Never run Git push yourself.`,
                        },
                      ]
                    : []),
                ],
              };
            };
            if (proposal.status === "prepared" && proposal.commitSha != null) {
              const ref = yield* Commit.readRef(proposal).pipe(Effect.provide(subjectContext));
              if (ref === proposal.commitSha) {
                const now = yield* nowIso;
                yield* reconcileAndCommit({
                  previous: aggregate,
                  ids: idsFor(row.workItemId, aggregate),
                  decision: completedDecision(aggregate, proposal.commitSha, now),
                });
                return;
              }
              if (ref !== proposal.parentSha)
                return yield* new GarrsError({
                  code: "conflict",
                  message: "The approved branch moved; no commit was written.",
                });
            }
            if (isWorkTerminal(aggregate.workItem)) {
              return yield* new GarrsError({
                code: "conflict",
                message: "The work was closed before the commit was written.",
              });
            }
            const requester = currentAttempt(aggregate, proposal.attemptId);
            if (
              requester?.attempt.status !== "running" ||
              requester.task.status !== "waiting_response"
            ) {
              return yield* new GarrsError({
                code: "conflict",
                message: "The Kex attempt was stopped before the commit was written.",
              });
            }
            const workspace = aggregate.workItem.workspace;
            const subject = yield* subjectOf(aggregate);
            const inspected = yield* Commit.inspect(proposal.checkoutPath).pipe(
              Effect.provide(subjectContext),
            );
            const subjectAfterInspection = yield* subjectOf(aggregate);
            if (
              workspace?.isolated !== true ||
              (aggregate.workItem.projectContexts?.length ?? 0) > 0 ||
              !proposal.diff ||
              subjectAfterInspection.hash !== subject.hash ||
              workspace.checkoutPath !== proposal.checkoutPath ||
              subject.hash !== proposal.reviewSubjectHash ||
              !aggregate.reviews.some(
                (review) =>
                  review.status === "valid" &&
                  review.verdict === "approved" &&
                  review.subjectHash === subject.hash,
              ) ||
              inspected === null ||
              inspected.branchRef !== proposal.branchRef ||
              inspected.parentSha !== proposal.parentSha ||
              inspected.treeSha !== proposal.treeSha ||
              inspected.diff !== proposal.diff
            ) {
              return yield* new GarrsError({
                code: "conflict",
                message:
                  "The approved checkout, reviewed state or staged tree changed; no commit was written.",
              });
            }
            if (proposal.status === "approved") {
              const commitSha = yield* Commit.createObject(proposal).pipe(
                Effect.provide(subjectContext),
              );
              if (commitSha === null)
                return yield* new GarrsError({
                  code: "unavailable",
                  message: "Git could not create the commit object; check commit identity.",
                });
              const now = yield* nowIso;
              aggregate = yield* reconcileAndCommit({
                previous: aggregate,
                ids: idsFor(row.workItemId, aggregate),
                decision: {
                  aggregate: {
                    ...aggregate,
                    workItem: {
                      ...aggregate.workItem,
                      commitProposal: { ...proposal, status: "prepared", commitSha },
                      updatedAt: now,
                    },
                  },
                  activity: [],
                  effects: [],
                },
              });
              proposal = aggregate.workItem.commitProposal!;
            }
            const commitSha = proposal.commitSha;
            if (commitSha == null)
              return yield* new GarrsError({
                code: "unavailable",
                message: "The commit object could not be recovered.",
              });
            const beforeMoveSubject = yield* subjectOf(aggregate);
            const beforeMove = yield* Commit.inspect(proposal.checkoutPath).pipe(
              Effect.provide(subjectContext),
            );
            const afterMoveInspectionSubject = yield* subjectOf(aggregate);
            if (
              afterMoveInspectionSubject.hash !== beforeMoveSubject.hash ||
              beforeMoveSubject.hash !== proposal.reviewSubjectHash ||
              !aggregate.reviews.some(
                (review) =>
                  review.status === "valid" &&
                  review.verdict === "approved" &&
                  review.subjectHash === beforeMoveSubject.hash,
              ) ||
              beforeMove === null ||
              beforeMove.branchRef !== proposal.branchRef ||
              beforeMove.parentSha !== proposal.parentSha ||
              beforeMove.treeSha !== proposal.treeSha ||
              beforeMove.diff !== proposal.diff
            ) {
              return yield* new GarrsError({
                code: "conflict",
                message:
                  "The approved checkout changed before the branch update; no commit was written.",
              });
            }
            const moved = yield* Commit.moveRef({ ...proposal, commitSha }).pipe(
              Effect.provide(subjectContext),
            );
            if (
              !moved &&
              (yield* Commit.readRef(proposal).pipe(Effect.provide(subjectContext))) !== commitSha
            ) {
              return yield* new GarrsError({
                code: "conflict",
                message: "The approved branch moved or the commit could not be confirmed.",
              });
            }
            const now = yield* nowIso;
            yield* reconcileAndCommit({
              previous: aggregate,
              ids: idsFor(row.workItemId, aggregate),
              decision: completedDecision(aggregate, commitSha, now),
            });
          }),
        );
      case "launch_attempt":
        return yield* launchAttempt(effect.attemptId, row.workItemId);
      case "stop_attempt": {
        const aggregate = yield* loadOrFail(row.workItemId);
        const attempt = aggregate.attempts.find((entry) => entry.id === effect.attemptId);
        if (attempt === undefined || attempt.status !== "cancel_requested") return;
        if (attempt.threadId !== null) return yield* stopThread(attempt.threadId, attempt.id);
        const threadId = ThreadId.make(`${ATTEMPT_THREAD_PREFIX}${attempt.id}`);
        const projection = yield* threads.getThreadProjection(threadId).pipe(
          Effect.catchTags({
            OrchestratorProjectionError: (error) =>
              isProjectionThreadNotFound(error.cause) && error.cause.threadId === threadId
                ? Effect.succeed(null)
                : Effect.fail(error),
          }),
        );
        if (projection !== null) {
          yield* mutate(row.workItemId, null, (latest) =>
            Effect.succeed({
              aggregate: replaceAttempt(latest, { ...attempt, threadId }),
              activity: [],
              effects: [],
              result: () => undefined,
            }),
          );
          const run = ThreadManagement.latestRun(projection);
          return run !== undefined && ThreadManagement.isTerminalRunStatus(run.status)
            ? yield* onRunEnded(threadId, run.status, run.id)
            : yield* stopThread(threadId, attempt.id);
        }
        yield* mutate(row.workItemId, null, (latest) =>
          Effect.map(nowIso, (now) => {
            const stopped = latest.attempts.find((entry) => entry.id === attempt.id);
            if (stopped?.status !== "cancel_requested" || stopped.threadId !== null) {
              return { aggregate: latest, activity: [], effects: [], result: () => undefined };
            }
            const reason = "Stopped before a provider thread was created.";
            const next = replaceAttempt(latest, { ...stopped, status: "cancelled", endedAt: now });
            return {
              aggregate: {
                ...next,
                tasks: next.tasks.map((task) =>
                  task.id === stopped.taskId &&
                  task.generation === stopped.generation &&
                  (task.status === "running" || task.status === "waiting_response")
                    ? { ...task, status: "failed" as const, statusReason: reason, updatedAt: now }
                    : task,
                ),
              },
              activity: [
                {
                  type: "attempt.cancelled",
                  summary: reason,
                  agentId: stopped.agentId,
                  taskId: stopped.taskId,
                  attemptId: stopped.id,
                },
              ],
              effects: [],
              result: () => undefined,
            };
          }),
        );
        return;
      }
      case "resume_attempt": {
        const aggregate = yield* loadOrFail(row.workItemId);
        const current = currentAttempt(aggregate, effect.attemptId);
        const attempt = current?.attempt;
        if (
          current === null ||
          attempt?.threadId == null ||
          attempt.status !== "running" ||
          current.task.status !== "running"
        )
          return;
        const projectId = current.task.projectId;
        if (projectId === undefined) return;
        yield* sendText(projectId, attempt.threadId, row.id, effect.text);
        return;
      }
      case "deliver_helper_result": {
        const aggregate = yield* loadOrFail(row.workItemId);
        const helper = aggregate.tasks.find((task) => task.id === effect.taskId);
        if (
          helper?.helper === undefined ||
          !Helpers.deliveries(aggregate).some(
            (item) => item.kind === "deliver_helper_result" && item.taskId === helper.id,
          )
        )
          return;
        const parent = currentAttempt(aggregate, helper.helper.parentAttemptId);
        if (parent?.attempt.threadId == null) return;
        const artifact = aggregate.artifacts.find(
          (entry) => entry.id === helper.completionArtifactId,
        );
        const message =
          artifact === undefined
            ? `Temporary helper ${helper.key} ended without a result: ${helper.statusReason ?? helper.status}. Continue without it or report the limitation.`
            : `Temporary helper ${helper.key} returned this result for your task. Verify it before relying on it.\n${artifact.summary}\n${artifact.body.slice(0, 8_000)}\nEvidence: ${artifact.evidence.join("; ") || "none"}`;
        const key = `helper:${helper.id}`;
        const projection = yield* threads.getThreadProjection(parent.attempt.threadId);
        if (
          !projection.messages.some((entry) => entry.id === MessageId.make(`garrs-message:${key}`))
        ) {
          yield* sendText(parent.task.projectId, parent.attempt.threadId, key, message);
        }
        yield* mutate(row.workItemId, null, (latest) =>
          Effect.map(nowIso, (now) => {
            const decision = Helpers.acknowledge(latest, helper.id, now);
            return {
              ...decision,
              effects: [
                ...decision.effects,
                ...Decider.pendingMessageEffects(decision.aggregate, parent.attempt.id),
              ],
              result: () => undefined,
            };
          }),
        );
        return;
      }
      case "deliver_message": {
        const aggregate = yield* loadOrFail(row.workItemId);
        const message = aggregate.messages.find((entry) => entry.id === effect.messageId);
        if (message === undefined || message.deliveryStatus !== "pending") return;
        const attempt =
          effect.attemptId === null
            ? null
            : aggregate.attempts.find((entry) => entry.id === effect.attemptId);
        const threadId =
          effect.attemptId === null ? aggregate.workItem.garrasThreadId : attempt?.threadId;
        if (threadId == null) return;
        const messageId = MessageId.make(`garrs-message:message:${message.id}`);
        const projection = yield* threads.getThreadProjection(threadId);
        const alreadyAccepted = projection.messages.some((entry) => entry.id === messageId);
        if (!alreadyAccepted) {
          if (isWorkTerminal(aggregate.workItem)) return;
          if (effect.attemptId !== null) {
            const current = currentAttempt(aggregate, effect.attemptId);
            if (
              current === null ||
              current.attempt.status !== "running" ||
              (message.toTaskId !== undefined && message.toTaskId !== current.task.id) ||
              (current.task.status !== "running" &&
                !(current.task.status === "waiting_response" && message.kind === "answer"))
            )
              return;
          }
          const text = `[Garrs message from ${message.fromAgent}, kind ${message.kind}, id ${message.id}]\n${message.body}${message.refs.length > 0 ? `\nRefs: ${message.refs.join(", ")}` : ""}`;
          const projectId =
            effect.attemptId === null
              ? aggregate.workItem.projectId
              : aggregate.tasks.find((task) => task.id === attempt?.taskId)?.projectId;
          if (projectId === undefined) return;
          yield* sendText(projectId, threadId, `message:${message.id}`, text);
        }
        yield* mutate(row.workItemId, null, (latest) =>
          Effect.map(nowIso, (now) => ({
            ...Decider.acknowledgeMessage(latest, message.id, effect.attemptId, now),
            result: () => undefined,
          })),
        );
        return;
      }
      case "notify_garras": {
        const aggregate = yield* loadOrFail(row.workItemId);
        yield* sendText(
          aggregate.workItem.projectId,
          aggregate.workItem.garrasThreadId,
          row.id,
          `[Garrs server update for work item ${aggregate.workItem.id}]\n${effect.text}`,
        );
        return;
      }
    }
  });

  const processEffects: Effect.Effect<void> = Effect.gen(function* () {
    const pending = yield* store.listPendingEffects();
    for (const row of pending) {
      const exit = yield* Effect.exit(runEffect(row));
      const now = yield* nowIso;
      if (exit._tag === "Success") {
        yield* store.finishEffect({ id: row.id, status: "done", error: null, now });
        continue;
      }
      yield* Effect.logWarning("Garrs effect failed", {
        kind: row.effect.kind,
        tries: row.tries + 1,
        cause: Cause.pretty(exit.cause),
      });
      if (row.effect.kind === "execute_commit" && row.tries + 1 >= 3) {
        const proposalId = row.effect.proposalId;
        yield* mutate(row.workItemId, null, (aggregate) =>
          Effect.sync(() => {
            const proposal = aggregate.workItem.commitProposal;
            if (
              proposal === undefined ||
              proposal.id !== proposalId ||
              proposal.status === "committed"
            ) {
              return { aggregate, activity: [], effects: [], result: () => undefined };
            }
            const unknown = proposal.commitSha != null;
            const reason = unknown
              ? "Commit outcome could not be confirmed. Inspect the approved branch before retrying."
              : "The commit could not be created. Review the checkout and create a new proposal.";
            return {
              aggregate: {
                ...aggregate,
                workItem: {
                  ...aggregate.workItem,
                  commitProposal: {
                    ...proposal,
                    status: unknown ? ("outcome_unknown" as const) : ("failed" as const),
                    failureReason: reason,
                  },
                  updatedAt: now,
                },
              },
              activity: [
                {
                  type: "commit.failed",
                  summary: reason,
                  agentId: "kex" as const,
                  taskId: null,
                  attemptId: proposal.attemptId,
                },
              ],
              effects: [],
              result: () => undefined,
            };
          }),
        );
      }
      yield* store.finishEffect({
        id: row.id,
        status:
          row.effect.kind === "deliver_message" ||
          row.effect.kind === "deliver_helper_result" ||
          row.tries + 1 < 3
            ? "pending"
            : "failed",
        error: "Effect failed; see server logs.",
        now,
      });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Garrs effect pass failed", { cause: Cause.pretty(cause) }),
    ),
  );

  // ── Run-end reactor ──────────────────────────────────────────────────────

  const onRunStarted = Effect.fn("GarrsService.onRunStarted")(function* (
    threadId: ThreadId,
    runId: RunId,
    userMessageId: MessageId | null,
  ) {
    const attempt = yield* store.findAttemptByThread(threadId);
    if (attempt === null || attempt.runId === runId) return;
    yield* mutate(attempt.workItemId, null, (aggregate) =>
      Effect.gen(function* () {
        const task = aggregate.tasks.find((task) => task.id === attempt.taskId);
        const projection =
          task?.status === "waiting_response" && userMessageId !== null
            ? yield* threads.getThreadProjection(threadId).pipe(Effect.orElseSucceed(() => null))
            : null;
        const humanResponse =
          projection?.messages.some(
            (message) => message.id === userMessageId && message.createdBy === "user",
          ) ?? false;
        const now = yield* nowIso;
        return {
          ...applyRunStarted(aggregate, { attemptId: attempt.id, runId, now, humanResponse }),
          result: () => undefined,
        };
      }),
    );
  });

  const onRunEnded = Effect.fn("GarrsService.onRunEnded")(function* (
    threadId: ThreadId,
    runStatus: string,
    runId?: RunId,
  ) {
    const attempt = yield* store.findAttemptByThread(threadId);
    if (attempt === null) return;
    const projection = yield* threads
      .getThreadProjection(threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const latestRun = projection === null ? undefined : ThreadManagement.latestRun(projection);
    if (runId !== undefined && latestRun !== undefined && latestRun.id !== runId) return;
    const usage =
      projection === null ? attempt.usage : usageFrom(projection, attempt.decision.requested);
    const reminders = yield* store.countEffects(attempt.id, "resume_attempt");
    const failedRunId = runId ?? latestRun?.id ?? attempt.runId;
    const failureMessage = projection?.visibleTurnItems
      .map((entry) => entry.item)
      .findLast(
        (item) => item.type === "error" && failedRunId !== null && item.runId === failedRunId,
      );
    yield* mutate(attempt.workItemId, null, (aggregate) =>
      Effect.gen(function* () {
        const checkoutState = yield* recoverCheckoutState(aggregate);
        const now = yield* nowIso;
        const decision = applyRunEnded(checkoutState.aggregate, {
          attemptId: attempt.id,
          runStatus,
          now,
          remindersSent: reminders,
          usage,
          effectiveModel: confirmedUsageModel(usage),
          effectiveModelSource: "provider_response",
          ...(failureMessage?.type === "error"
            ? { failureMessage: failureMessage.failure.message, failure: failureMessage.failure }
            : {}),
        });
        return {
          ...decision,
          activity: [...checkoutState.activity, ...decision.activity],
          result: () => undefined,
        };
      }),
    );
  });

  const onGarrasRunEnded = Effect.fn("GarrsService.onGarrasRunEnded")(function* (
    threadId: ThreadId,
    runId?: RunId,
  ) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const member = yield* store.getThread(threadId);
        if (member?.agentId !== "garras") return;
        yield* workspaceRoot(member.projectId);
        const changed = yield* Bootstrap.recoverRun({
          threadId,
          ...(runId === undefined ? {} : { runId }),
          catalog: yield* catalogFor(member.projectId),
          failures: yield* modelFailures(),
        }).pipe(Effect.provide(bootstrapContext));
        if (changed) yield* publish(`project:${member.projectId}`);
      }),
    );
  });

  const recoverGarrasConversations = Effect.gen(function* () {
    for (const threadId of yield* store.listFailedGarrasThreads()) {
      yield* onGarrasRunEnded(threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Garras bootstrap recovery failed", { cause: Cause.pretty(cause) }),
        ),
      );
    }
  });

  const timeoutSweep = Effect.gen(function* () {
    const active = yield* store.listActiveAttempts();
    const currentTime = yield* DateTime.now;
    const now = DateTime.toEpochMillis(currentTime);
    const nowString = DateTime.formatIso(currentTime);
    for (const workItemId of yield* store.listHelperWorkItemIds()) {
      const aggregate = yield* store.loadAggregate(workItemId);
      if (aggregate === null || Helpers.expire(aggregate, nowString).activity.length === 0)
        continue;
      yield* mutate(workItemId, null, (latest) =>
        Effect.succeed({
          ...Helpers.expire(latest, nowString),
          result: () => undefined,
        }),
      );
    }
    for (const attempt of active) {
      if (attempt.status === "cancel_requested" && attempt.threadId !== null) {
        const projection = yield* threads
          .getThreadProjection(attempt.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        const run = projection === null ? undefined : ThreadManagement.latestRun(projection);
        if (
          projection !== null &&
          (run === undefined || ThreadManagement.isTerminalRunStatus(run.status))
        )
          yield* onRunEnded(attempt.threadId, run?.status ?? "cancelled", run?.id);
      }
      if (attempt.status !== "running" || attempt.startedAt === null) continue;
      const aggregate = yield* store.loadAggregate(attempt.workItemId);
      if (aggregate === null) continue;
      const config = yield* store.getConfigRevision(aggregate.workItem.configRevision);
      const started = DateTime.toEpochMillis(DateTime.makeUnsafe(attempt.startedAt));
      if (now - started < config.limits.attemptTimeoutMinutes * 60_000) continue;
      yield* control({
        commandId: CommandId.make(`garrs:timeout:${attempt.id}`),
        workItemId: attempt.workItemId,
        action: { type: "stop_attempt", attemptId: attempt.id },
      }).pipe(Effect.ignore);
    }
    yield* recoverGarrasConversations;
    yield* effectsWorker.enqueue(undefined);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Garrs timeout sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  /** After a restart: settle attempts whose run ended while down, then schedule ready work. */
  const recover = Effect.gen(function* () {
    yield* recoverGarrasConversations;
    for (const attempt of yield* store.listActiveAttempts()) {
      if (attempt.threadId === null) continue;
      const projection = yield* threads
        .getThreadProjection(attempt.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const run = projection === null ? undefined : ThreadManagement.latestRun(projection);
      if (run !== undefined && ThreadManagement.isTerminalRunStatus(run.status)) {
        yield* onRunEnded(attempt.threadId, run.status, run.id).pipe(Effect.ignore);
      }
    }
    for (const workItemId of yield* store.listOpenWorkItemIds()) {
      yield* mutate(workItemId, null, (aggregate) =>
        Effect.succeed({ aggregate, activity: [], effects: [], result: () => undefined }),
      ).pipe(Effect.ignore);
    }
    yield* effectsWorker.enqueue(undefined);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Garrs recovery failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const start = Effect.fn("GarrsService.start")(function* () {
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        event.type === "run.updated" &&
        (event.threadId.startsWith(ATTEMPT_THREAD_PREFIX) || event.threadId.startsWith("garras:"))
          ? (ThreadManagement.isTerminalRunStatus(event.payload.status)
              ? event.threadId.startsWith("garras:")
                ? onGarrasRunEnded(event.threadId, event.payload.id)
                : onRunEnded(event.threadId, event.payload.status, event.payload.id)
              : event.threadId.startsWith(ATTEMPT_THREAD_PREFIX)
                ? onRunStarted(event.threadId, event.payload.id, event.payload.userMessageId)
                : Effect.void
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Garrs run handling failed", { cause: Cause.pretty(cause) }),
              ),
            )
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Garrs event stream failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
    yield* forkParked(recover);
    yield* forkParked(timeoutSweep.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));
  });

  return GarrsService.of({
    getConfig,
    updateConfig,
    getProjectBinding,
    updateProjectBinding,
    startConversation,
    subscribeProject: (projectId) => live(`project:${projectId}`, projectState(projectId)),
    subscribeWorkItem: (workItemId) => live(`work:${workItemId}`, getWorkItem(workItemId)),
    control,
    exportConfig,
    importConfig,
    getUsage,
    listMemory,
    mutateMemory,
    startWork,
    status,
    models,
    selectTaskModel,
    resume,
    revise,
    deliver,
    submitPlan,
    report,
    requestHelper,
    proposeCommit,
    proposePush,
    sendMessage,
    submitReview,
    start,
    drain: effectsWorker.drain,
  });
});

export const layer = Layer.effect(GarrsService, make);
