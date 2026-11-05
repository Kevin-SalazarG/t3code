import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ManagedPolicySummary,
  type ModelSelection,
  GarrsAttemptId,
  GarrsWorkItemId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import * as ServerSettings from "../serverSettings.ts";
import * as GarrsStore from "../garrs/GarrsStore.ts";
import type { WorkAggregate } from "../garrs/GarrsDomain.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const antigravityInstanceId = ProviderInstanceId.make("antigravity");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
  [antigravityInstanceId, ["approval-required", "auto-accept-edits", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        driver: instanceId,
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as unknown as ServerProvider),
    },
  }) as ProviderInstance;

const garrsMemberThreadId = ThreadId.make("garrs:w1-a1");

const layerWithPolicy = (policy?: ManagedPolicySummary) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(ServerSettings.layerTest({}, policy)),
    Layer.provide(
      Layer.mock(GarrsStore.GarrsStore)({
        getThread: (threadId) =>
          Effect.succeed(
            threadId === garrsMemberThreadId
              ? {
                  threadId,
                  projectId,
                  agentId: "copito" as const,
                  attemptId: GarrsAttemptId.make("read-attempt"),
                  readOnly: true,
                  instructions: "Review independently.",
                  configRevision: 0,
                }
              : null,
          ),
        findAttemptById: () =>
          Effect.succeed({ id: "read-attempt", workItemId: "read-work" } as never),
        loadAggregate: () =>
          Effect.succeed({
            workItem: { status: "active", projectContexts: [] },
            tasks: [{ id: "read-task", status: "running", generation: 0 }],
            attempts: [
              { id: "read-attempt", taskId: "read-task", status: "running", generation: 0 },
            ],
          } as unknown as WorkAggregate),
      }),
    ),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeedSome({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            pinnedAt: null,
            archivedAt: null,
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
      }),
    ),
  );

const layerTest = layerWithPolicy();

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("asks for Antigravity command approval when a stored Auto thread falls back", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: null, runtimeMode }),
          modelSelection: { instanceId: antigravityInstanceId, model: "test-model" },
        });
      const request = {
        sessionId: "session-1",
        toolCall: { toolCallId: "command-1", title: "Run command", kind: "execute" as const },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
      };
      const auto = yield* resolve("auto");
      assert.equal(auto.runtimeMode, "approval-required");
      assert.equal(acpPermissionDisposition(auto, request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("auto-accept-edits"), request), "ask");
      assert.equal(acpPermissionDisposition(yield* resolve("full-access"), request), "allow");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );

  it.effect("gives Garrs members their role brief and a read-only sandbox, and nobody else", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const ordinary = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.isUndefined(ordinary.instructions);
      assert.isUndefined(ordinary.sandboxPolicy);

      const member = yield* policy.resolve({
        thread: { ...makeThread({ now, worktreePath: null }), id: garrsMemberThreadId },
        modelSelection,
      });
      assert.include(member.instructions!, "Review independently.");
      assert.deepEqual(member.sandboxPolicy, { type: "readOnly" });
    }),
  );

  it.effect("rejects an unsupported provider selected after a Garrs thread was created", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      for (const driver of [
        "opencode",
        "acpRegistry",
        "antigravity",
        "grok",
        "fx",
        "cursor",
        "pi",
        "muse",
      ]) {
        const selection = { instanceId: ProviderInstanceId.make(driver), model: "test" };
        const error = yield* policy
          .resolve({
            thread: { ...makeThread({ now, worktreePath: null }), id: garrsMemberThreadId },
            modelSelection: selection,
          })
          .pipe(Effect.flip);
        assert.include(error.message, "only Claude and Codex");
        const ordinary = yield* policy.resolve({
          thread: makeThread({ now, worktreePath: null }),
          modelSelection: selection,
        });
        assert.isUndefined(ordinary.garrs);
        assert.isUndefined(ordinary.sandboxPolicy);
      }
    }),
  );
});

it.layer(
  layerWithPolicy({
    organization: "Example Corp",
    lockedSettings: [],
    limits: { maxRuntimeMode: "auto-accept-edits" },
  }),
)("RuntimePolicyV2 under a runtime mode ceiling", (it) => {
  it.effect("refuses to start a turn above the ceiling, such as one resumed after a restart", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolve = (runtimeMode: RuntimeMode) =>
        policy.resolve({
          thread: makeThread({ now, worktreePath: "/work", runtimeMode }),
          modelSelection,
        });

      const refused = yield* resolve("full-access").pipe(Effect.flip);
      assert.equal(refused._tag, "RuntimePolicyAboveCeilingError");
      assert.equal(
        refused.message,
        "Example Corp limits threads to Auto-accept edits. Switch this thread's mode to continue.",
      );
      const allowed = yield* resolve("auto-accept-edits");
      assert.equal(allowed.runtimeMode, "auto-accept-edits");
      assert.equal(allowed.maxRuntimeMode, "auto-accept-edits");
    }),
  );
});
it.effect("restricts Garrs writers to an isolated checkout with Codex's filesystem sandbox", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-writer-policy-" });
    const root = path.join(dir, "project");
    const checkout = path.join(dir, "worktree");
    yield* fs.makeDirectory(root);
    const git = (args: ReadonlyArray<string>) =>
      vcs.run({ operation: "RuntimePolicy.test", command: "git", cwd: root, args });
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
    yield* git(["worktree", "add", "--quiet", "--detach", checkout]);
    const writerId = ThreadId.make("garrs:writer");
    const policyLayer = RuntimePolicy.layerFromProjectStore.pipe(
      Layer.provide(ServerSettings.layerTest({})),
      Layer.provide(
        Layer.mock(GarrsStore.GarrsStore)({
          getThread: () =>
            Effect.succeed({
              threadId: writerId,
              projectId,
              agentId: "botas",
              attemptId: GarrsAttemptId.make("writer-attempt"),
              readOnly: false,
              instructions: "Write only here.",
              configRevision: 0,
            }),
          findAttemptById: () =>
            Effect.succeed({ id: "writer-attempt", workItemId: "writer-work" } as never),
          loadAggregate: () =>
            Effect.succeed({
              workItem: { status: "active" },
              tasks: [{ id: "writer-task", status: "running", generation: 0 }],
              attempts: [
                { id: "writer-attempt", taskId: "writer-task", status: "running", generation: 0 },
              ],
            } as unknown as WorkAggregate),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              projectId,
              title: "Project",
              workspaceRoot: root,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              pinnedAt: null,
              archivedAt: null,
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
              deletedAt: null,
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
          listInstances: Effect.succeed([]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.never,
        }),
      ),
    );
    const policy = yield* Effect.provide(RuntimePolicy.RuntimePolicyV2, policyLayer);
    const now = yield* DateTime.now;
    const writer = { ...makeThread({ now, worktreePath: checkout }), id: writerId };
    const safe = yield* policy.resolve({ thread: writer, modelSelection });
    assert.deepEqual(safe.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: [],
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
      networkAccess: false,
    });
    assert.deepEqual(safe.garrsWriteDenyRoots, [
      path.join(yield* fs.realPath(checkout), ".git"),
      path.join(yield* fs.realPath(root), ".git"),
    ]);
    const sameRoot = yield* policy
      .resolve({ thread: { ...writer, worktreePath: root }, modelSelection })
      .pipe(Effect.flip);
    assert.include(sameRoot.message, "isolated checkout");
    const subdirectory = path.join(root, "subdirectory");
    yield* fs.makeDirectory(subdirectory);
    const nested = yield* policy
      .resolve({ thread: { ...writer, worktreePath: subdirectory }, modelSelection })
      .pipe(Effect.flip);
    assert.include(nested.message, "isolated checkout");
    const unsupported = yield* policy
      .resolve({
        thread: writer,
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "test" },
      })
      .pipe(Effect.flip);
    assert.include(unsupported.message, "only Claude and Codex");
  }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("grants Copito only validated project roots and rejects a substituted checkout", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-review-roots-" });
    const first = path.join(dir, "first");
    const second = path.join(dir, "second");
    const alias = path.join(dir, "alias");
    const secondId = ProjectId.make("project:second");
    for (const root of [first, second]) {
      yield* fs.makeDirectory(root);
      yield* vcs.run({
        operation: "RuntimePolicy.test",
        command: "git",
        cwd: root,
        args: ["init", "--quiet"],
      });
      yield* vcs.run({
        operation: "RuntimePolicy.test",
        command: "git",
        cwd: root,
        args: [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "base",
        ],
      });
    }
    yield* fs.symlink(second, alias);
    const firstCanonical = yield* fs.realPath(first);
    const secondCanonical = yield* fs.realPath(second);
    const attemptId = GarrsAttemptId.make("attempt:review");
    const workItemId = GarrsWorkItemId.make("work:review");
    const reviewerId = ThreadId.make("garrs:review");
    let aggregate = {
      workItem: {
        projectId,
        status: "active",
        access: "read_only",
        projectRoot: firstCanonical,
        repositoryIdentity: path.join(firstCanonical, ".git"),
        projectContexts: [
          {
            projectId: secondId,
            projectRoot: secondCanonical,
            repositoryIdentity: path.join(secondCanonical, ".git"),
          },
        ],
      },
      tasks: [{ id: "review-task", status: "running", generation: 0 }],
      attempts: [{ id: attemptId, taskId: "review-task", status: "running", generation: 0 }],
    } as unknown as WorkAggregate;
    const policyLayer = RuntimePolicy.layerFromProjectStore.pipe(
      Layer.provide(ServerSettings.layerTest({})),
      Layer.provide(
        Layer.mock(GarrsStore.GarrsStore)({
          getThread: () =>
            Effect.succeed({
              threadId: reviewerId,
              projectId,
              agentId: "copito",
              attemptId,
              readOnly: true,
              instructions: "Review",
              configRevision: 0,
            }),
          findAttemptById: () => Effect.succeed({ id: attemptId, workItemId } as never),
          loadAggregate: () => Effect.succeed(aggregate),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (id) =>
            Effect.succeedSome({ workspaceRoot: id === projectId ? first : alias } as never),
        }),
      ),
      Layer.provide(
        Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
          listInstances: Effect.succeed([]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.never,
        }),
      ),
    );
    const policy = yield* Effect.provide(RuntimePolicy.RuntimePolicyV2, policyLayer);
    const now = yield* DateTime.now;
    const thread = { ...makeThread({ now, worktreePath: null }), id: reviewerId };
    const resolved = yield* policy.resolve({ thread, modelSelection });
    assert.deepEqual(resolved.garrsReadRoots, [firstCanonical, secondCanonical]);
    assert.deepEqual(resolved.sandboxPolicy, { type: "readOnly" });
    yield* fs.remove(alias);
    yield* fs.symlink(first, alias);
    const rejected = yield* policy.resolve({ thread, modelSelection }).pipe(Effect.flip);
    assert.include(rejected.message, "repository changed");
    yield* fs.remove(alias);
    yield* fs.symlink(second, alias);
    const firstCheckout = path.join(dir, "first-checkout");
    const secondCheckout = path.join(dir, "second-checkout");
    const workspace = (project: ProjectId, checkout: string, sha: string) => ({
      projectId: project,
      checkoutPath: checkout,
      isolated: true,
      baseSha: sha,
    });
    for (const [root, checkout] of [
      [first, firstCheckout],
      [second, secondCheckout],
    ] as const) {
      yield* vcs.run({
        operation: "RuntimePolicy.test",
        command: "git",
        cwd: root,
        args: ["worktree", "add", "--quiet", "--detach", checkout],
      });
    }
    const firstHead = (yield* vcs.run({
      operation: "RuntimePolicy.test",
      command: "git",
      cwd: first,
      args: ["rev-parse", "HEAD"],
    })).stdout.trim();
    const secondHead = (yield* vcs.run({
      operation: "RuntimePolicy.test",
      command: "git",
      cwd: second,
      args: ["rev-parse", "HEAD"],
    })).stdout.trim();
    aggregate = {
      ...aggregate,
      workItem: {
        ...aggregate.workItem,
        projectId,
        access: "write",
        projectRoot: firstCanonical,
        repositoryIdentity: path.join(firstCanonical, ".git"),
        workspace: workspace(projectId, firstCheckout, firstHead),
        projectContexts: [
          {
            projectId: secondId,
            projectRoot: secondCanonical,
            repositoryIdentity: path.join(secondCanonical, ".git"),
            workspace: workspace(secondId, secondCheckout, secondHead),
          },
        ],
      },
    } as unknown as WorkAggregate;
    const writeReview = yield* policy.resolve({
      thread: { ...thread, worktreePath: firstCheckout },
      modelSelection,
    });
    assert.deepEqual(writeReview.garrsReadRoots, [
      yield* fs.realPath(firstCheckout),
      yield* fs.realPath(secondCheckout),
    ]);
    assert.deepEqual(writeReview.sandboxPolicy, { type: "readOnly" });
  }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
