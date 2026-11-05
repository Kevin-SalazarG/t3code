import { expect, it } from "@effect/vitest";
import { GarrsAttemptId, GarrsWorkItemId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { defaultTeamConfig, type WorkAggregate } from "./GarrsDomain.ts";
import * as Store from "./GarrsStore.ts";
import { runtimeContext } from "./GarrsRuntimeContext.ts";

it.effect.each(["running", "waiting_response", "cancelled", "completed"] as const)(
  "uses persisted task state before a direct %s turn",
  (status) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("garrs:attempt");
      const attemptId = GarrsAttemptId.make("attempt");
      const member = {
        threadId,
        projectId: ProjectId.make("project"),
        agentId: "botas" as const,
        attemptId,
        readOnly: false,
        instructions: "stale",
        configRevision: 0,
      };
      const aggregate = {
        workItem: {
          id: GarrsWorkItemId.make("work"),
          status: "active",
          updatedAt: "2026-11-05T00:00:00Z",
        },
        tasks: [{ id: "task", key: "backend", agentId: "botas", generation: 0, status }],
        attempts: [
          {
            id: attemptId,
            taskId: "task",
            workItemId: "work",
            generation: 0,
            status: status === "cancelled" || status === "completed" ? "cancelled" : "running",
          },
        ],
      } as unknown as WorkAggregate;
      const result = yield* runtimeContext(member).pipe(
        Effect.result,
        Effect.provide(
          Layer.mock(Store.GarrsStore)({
            findAttemptById: () => Effect.succeed(aggregate.attempts[0]!),
            loadAggregate: () => Effect.succeed(aggregate),
            getConfigRevision: () => Effect.succeed(defaultTeamConfig()),
          }),
        ),
      );
      if (status === "cancelled" || status === "completed") {
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } });
      } else {
        expect(result._tag).toBe("Success");
        if (result._tag === "Success") expect(result.success).toContain(`"status":"${status}"`);
      }
    }),
);

it.effect("refreshes the coordinator snapshot without copying another conversation's work", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("garras:coordinator");
    const projectId = ProjectId.make("project");
    let taskStatus = "running";
    const workItem = {
      id: GarrsWorkItemId.make("work"),
      garrasThreadId: threadId,
      projectId,
      status: "active",
      statusReason: null,
      updatedAt: "2026-11-05T00:00:00Z",
    } as const;
    const member = {
      threadId,
      projectId,
      agentId: "garras" as const,
      attemptId: null,
      readOnly: true,
      instructions: "stale",
      configRevision: 0,
    };
    const layer = Layer.mock(Store.GarrsStore)({
      getConfigRevision: () => Effect.succeed(defaultTeamConfig()),
      listWorkItems: () =>
        Effect.succeed([
          workItem,
          {
            ...workItem,
            id: GarrsWorkItemId.make("unrelated-work"),
            garrasThreadId: ThreadId.make("other-conversation"),
          },
        ] as never),
      loadAggregate: () =>
        Effect.sync(
          () =>
            ({
              workItem,
              attempts: [],
              tasks: [
                { id: "current-task", key: "current", agentId: "botas", status: taskStatus },
                ...Array.from({ length: 40 }, (_, i) => ({
                  id: `done-${i}`,
                  key: `done-${i}`,
                  status: "completed",
                })),
              ],
            }) as unknown as WorkAggregate,
        ),
    });
    const first = yield* runtimeContext(member).pipe(Effect.provide(layer));
    taskStatus = "failed";
    const next = yield* runtimeContext(member).pipe(Effect.provide(layer));
    expect(first).toContain('"status":"running"');
    expect(next).toContain('"status":"failed"');
    expect(next).not.toContain('"status":"running"');
    expect(next).not.toContain("unrelated-work");
    expect(next).not.toContain("done-39");
  }),
);
