import {
  isRuntimeModeAbove,
  managedRuntimeModeCeilingMessage,
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GarrsStore from "../garrs/GarrsStore.ts";
import * as GarrsPreparation from "../garrs/GarrsPreparation.ts";
import { runtimeContext } from "../garrs/GarrsRuntimeContext.ts";
import * as GarrsSubject from "../garrs/GarrsSubject.ts";
import * as GarrsCheckout from "../garrs/GarrsCheckout.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { garrsDriverRejection } from "../garrs/GarrsDomain.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "./ProjectStore.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    reason: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return (
      this.reason ??
      `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`
    );
  }
}

/**
 * A turn would start in a mode above the policy's ceiling. The orchestrator refuses those when
 * they are dispatched; this catches the ones it never saw, such as a run resumed after a restart
 * on a thread whose mode predates the policy.
 */
export class RuntimePolicyAboveCeilingError extends Schema.TaggedError<RuntimePolicyAboveCeilingError>()(
  "RuntimePolicyAboveCeilingError",
  {
    threadId: ThreadId,
    runtimeMode: RuntimeMode,
    maxRuntimeMode: RuntimeMode,
    organization: Schema.String,
  },
) {
  override get message(): string {
    return `${managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode)} Switch this thread's mode to continue.`;
  }
}

export const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  RuntimePolicyAboveCeilingError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function (input) {
    return Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    });
  }),
});

function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

const refuseAboveCeiling = (
  managedPolicy: ServerSettings.ServerSettingsService["Service"]["managedPolicy"],
  thread: OrchestrationV2AppThread,
) => {
  const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
  return managedPolicy !== undefined &&
    maxRuntimeMode !== undefined &&
    isRuntimeModeAbove(thread.runtimeMode, maxRuntimeMode)
    ? Effect.fail(
        new RuntimePolicyAboveCeilingError({
          threadId: thread.id,
          runtimeMode: thread.runtimeMode,
          maxRuntimeMode,
          organization: managedPolicy.organization,
        }),
      )
    : Effect.void;
};

/** Lays the policy's ceiling over another runtime policy, as `layerFromProjectStore` does. */
export const layerEnforcingCeiling: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolveWithinCeiling")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        return yield* base.resolve(input);
      }),
    });
  }),
);

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // The same ceiling the orchestrator enforces, fixed for the server's life.
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
    // Optional so hosts without Garrs (tests, tools) keep the plain policy.
    const garrs = yield* Effect.serviceOption(GarrsStore.GarrsStore);
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    const paths = yield* Effect.serviceOption(Path.Path);
    const vcs = yield* Effect.serviceOption(VcsProcess.VcsProcess);
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const snapshot = instance === undefined ? undefined : yield* instance.snapshot.getSnapshot;
        const supportedRuntimeModes = snapshot?.supportedRuntimeModes;
        const cwd =
          input.thread.worktreePath ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        const member = Option.isNone(garrs)
          ? null
          : yield* garrs.value.getThread(input.thread.id).pipe(
              Effect.mapError(
                (cause) =>
                  new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    cause,
                  }),
              ),
            );
        let garrsReadRoots: ReadonlyArray<string> = [];
        let garrsWriteDenyRoots: ReadonlyArray<string> = [];
        let garrsProtectedRoots: ReadonlyArray<string> = [];
        if (member !== null) {
          const reason =
            snapshot === undefined
              ? "The selected provider instance is unavailable."
              : garrsDriverRejection(snapshot.driver);
          if (reason !== null) {
            return yield* new RuntimePolicyResolveError({
              projectId: input.thread.projectId,
              providerInstanceId: input.modelSelection.instanceId,
              reason: `${input.modelSelection.instanceId} ${reason}`,
            });
          }
          if (
            member.agentId === "copito" &&
            member.attemptId !== null &&
            member.readOnly &&
            Option.isSome(garrs)
          ) {
            const attempt = yield* garrs.value
              .findAttemptById(member.attemptId)
              .pipe(Effect.orElseSucceed(() => null));
            const aggregate =
              attempt === null
                ? null
                : yield* garrs.value
                    .loadAggregate(attempt.workItemId)
                    .pipe(Effect.orElseSucceed(() => null));
            if (aggregate === null)
              return yield* new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                reason: "Cannot verify the review's work item and project roots.",
              });
            const contexts = aggregate.workItem.projectContexts ?? [];
            if (contexts.length > 0) {
              if (Option.isNone(fileSystem) || Option.isNone(paths) || Option.isNone(vcs))
                return yield* new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  reason: "Cannot verify read-only access to all review projects.",
                });
              const roots = [
                {
                  projectId: aggregate.workItem.projectId,
                  root: aggregate.workItem.projectRoot,
                  identity: aggregate.workItem.repositoryIdentity,
                  workspace: aggregate.workItem.workspace,
                },
                ...contexts.map((context) => ({
                  projectId: context.projectId,
                  root: context.projectRoot,
                  identity: context.repositoryIdentity,
                  workspace: context.workspace,
                })),
              ];
              const validated: string[] = [];
              for (const entry of roots) {
                const project = yield* projects
                  .get(entry.projectId)
                  .pipe(Effect.orElseSucceed(() => Option.none()));
                if (
                  Option.isNone(project) ||
                  entry.root === undefined ||
                  entry.identity === undefined
                )
                  return yield* new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    reason: `Cannot verify review project ${entry.projectId}.`,
                  });
                const canonical = yield* fileSystem.value
                  .realPath(project.value.workspaceRoot)
                  .pipe(Effect.option);
                const identity = yield* GarrsSubject.repositoryIdentity(
                  project.value.workspaceRoot,
                ).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem.value),
                  Effect.provideService(Path.Path, paths.value),
                  Effect.provideService(VcsProcess.VcsProcess, vcs.value),
                );
                if (
                  Option.isNone(canonical) ||
                  canonical.value !== entry.root ||
                  Option.isNone(identity) ||
                  identity.value !== entry.identity
                )
                  return yield* new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    reason: `Review project ${entry.projectId} is unavailable or its repository changed.`,
                  });
                if (aggregate.workItem.access === "write") {
                  if (entry.workspace?.checkoutPath == null)
                    return yield* new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      reason: `Cannot verify review project ${entry.projectId}.`,
                    });
                  const checked = yield* GarrsCheckout.bind(
                    project.value.workspaceRoot,
                    entry.workspace.checkoutPath,
                    entry.workspace,
                  ).pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem.value),
                    Effect.provideService(Path.Path, paths.value),
                    Effect.provideService(VcsProcess.VcsProcess, vcs.value),
                  );
                  const checkout = yield* fileSystem.value
                    .realPath(entry.workspace.checkoutPath)
                    .pipe(Effect.option);
                  if (checked === null || Option.isNone(checkout))
                    return yield* new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      reason: `Review project ${entry.projectId} is unavailable or its repository changed.`,
                    });
                  validated.push(checkout.value);
                } else validated.push(canonical.value);
              }
              garrsReadRoots = validated;
            }
          }
          if (!member.readOnly) {
            if (
              input.thread.worktreePath === null ||
              Option.isNone(fileSystem) ||
              Option.isNone(paths) ||
              Option.isNone(vcs)
            ) {
              return yield* new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                reason: "Garrs writers require a verified isolated checkout.",
              });
            }
            const project = yield* projects
              .get(input.thread.projectId)
              .pipe(Effect.orElseSucceed(() => Option.none()));
            if (Option.isNone(project))
              return yield* new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                reason: "The writer's project is unavailable.",
              });
            const original = yield* fileSystem.value
              .realPath(project.value.workspaceRoot)
              .pipe(Effect.option);
            const checkout = yield* fileSystem.value
              .realPath(input.thread.worktreePath)
              .pipe(Effect.option);
            const isolated = yield* GarrsSubject.isIsolatedCheckout(
              project.value.workspaceRoot,
              input.thread.worktreePath,
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem.value),
              Effect.provideService(Path.Path, paths.value),
              Effect.provideService(VcsProcess.VcsProcess, vcs.value),
            );
            if (
              Option.isNone(original) ||
              Option.isNone(checkout) ||
              original.value === checkout.value ||
              !isolated
            ) {
              return yield* new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                reason: "Garrs writers require a verified isolated checkout.",
              });
            }
            const common = yield* GarrsSubject.repositoryIdentity(checkout.value).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem.value),
              Effect.provideService(Path.Path, paths.value),
              Effect.provideService(VcsProcess.VcsProcess, vcs.value),
            );
            if (Option.isNone(common))
              return yield* new RuntimePolicyResolveError({
                projectId: input.thread.projectId,
                providerInstanceId: input.modelSelection.instanceId,
                reason: "Cannot verify the writer's Git metadata paths.",
              });
            garrsWriteDenyRoots = [paths.value.join(checkout.value, ".git"), common.value];
            const relative = paths.value.relative(original.value, checkout.value);
            if (relative.startsWith("..") || paths.value.isAbsolute(relative))
              garrsProtectedRoots = [original.value];
          }
        }
        const preparation =
          member === null ||
          member.agentId === "garras" ||
          Option.isNone(fileSystem) ||
          Option.isNone(paths)
            ? []
            : yield* GarrsPreparation.inspect(member.projectId, cwd).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem.value),
                Effect.provideService(Path.Path, paths.value),
              );
        const instructions =
          member === null || Option.isNone(garrs)
            ? undefined
            : yield* runtimeContext(member, preparation).pipe(
                Effect.provideService(GarrsStore.GarrsStore, garrs.value),
                Effect.mapError(
                  (cause) =>
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      reason: cause.message,
                      cause,
                    }),
                ),
              );
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
          ...(maxRuntimeMode === undefined ? {} : { maxRuntimeMode }),
          // Garrs members get their role brief, and read-only roles the adapter's sandbox.
          ...(instructions === undefined ? {} : { instructions }),
          ...(member === null ? {} : { garrs: true }),
          ...(garrsReadRoots.length === 0 ? {} : { garrsReadRoots }),
          ...(garrsWriteDenyRoots.length === 0 ? {} : { garrsWriteDenyRoots }),
          ...(garrsProtectedRoots.length === 0 ? {} : { garrsProtectedRoots }),
          ...(member?.readOnly === true ? { sandboxPolicy: { type: "readOnly" } } : {}),
          ...(member?.readOnly === false
            ? {
                sandboxPolicy: {
                  type: "workspaceWrite",
                  writableRoots: [],
                  excludeSlashTmp: true,
                  excludeTmpdirEnvVar: true,
                  networkAccess: false,
                },
              }
            : {}),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
