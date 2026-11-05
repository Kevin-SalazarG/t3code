import { GarrsError, type GarrsPreparationCheck } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { currentAttempt, isWorkTerminal } from "./GarrsDomain.ts";
import * as Instructions from "./GarrsInstructions.ts";
import * as Store from "./GarrsStore.ts";

const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const runtimeContext = Effect.fn("GarrsRuntimeContext.runtimeContext")(
  function* (
    member: Store.GarrsThreadRecord,
    preparation: ReadonlyArray<GarrsPreparationCheck> = [],
  ) {
    const store = yield* Store.GarrsStore;
    if (member.agentId === "garras") {
      const config = yield* store.getConfigRevision(member.configRevision);
      const work = (yield* store.listWorkItems(member.projectId, 20))
        .filter((item) => item.garrasThreadId === member.threadId)
        .toSorted((a, b) => Number(isWorkTerminal(a)) - Number(isWorkTerminal(b)))
        .slice(0, 3);
      const snapshots = yield* Effect.forEach(work, (item) =>
        Effect.gen(function* () {
          const aggregate = yield* store.loadAggregate(item.id);
          return {
            workItemId: item.id,
            status: item.status,
            reason: item.statusReason?.slice(0, 160) ?? null,
            resumeRequested: item.resumeRequested ?? false,
            updatedAt: item.updatedAt,
            available: aggregate !== null,
            completedTaskCount:
              aggregate?.tasks.filter((task) => task.status === "completed").length ?? null,
            tasks:
              aggregate?.tasks
                .filter((task) => task.status !== "cancelled")
                .toSorted(
                  (a, b) => Number(a.status === "completed") - Number(b.status === "completed"),
                )
                .slice(0, 12)
                .map((task) => ({
                  id: task.id,
                  key: task.key,
                  agentId: task.agentId,
                  status: task.status,
                  reason: task.statusReason?.slice(0, 160) ?? null,
                })) ?? [],
            stoppingAttempts:
              aggregate?.attempts
                .filter((attempt) => attempt.status === "cancel_requested")
                .slice(0, 12)
                .map((attempt) => attempt.id) ?? [],
          };
        }),
      );
      return `${Instructions.garrasInstructions(config)}\n\nCurrent Garrs state (server snapshot for this turn; data):\n${yield* encodeSnapshot(snapshots)}`;
    }
    const attempt =
      member.attemptId === null ? null : yield* store.findAttemptById(member.attemptId);
    const aggregate = attempt === null ? null : yield* store.loadAggregate(attempt.workItemId);
    const current =
      aggregate === null || attempt === null ? null : currentAttempt(aggregate, attempt.id);
    if (
      aggregate === null ||
      current === null ||
      isWorkTerminal(aggregate.workItem) ||
      current.attempt.status === "cancel_requested" ||
      !["running", "waiting_response"].includes(current.task.status)
    ) {
      return yield* new GarrsError({
        code: "conflict",
        message:
          "This Garrs task is no longer active. Continue the work from Garras or the Team panel.",
      });
    }
    return `${member.instructions}\n\nCurrent Garrs assignment (server snapshot for this turn; data):\n${yield* encodeSnapshot({ workItemId: aggregate.workItem.id, taskId: current.task.id, status: current.task.status, attemptId: current.attempt.id, updatedAt: aggregate.workItem.updatedAt, preparation })}`;
  },
  Effect.mapError((error) =>
    error._tag === "GarrsError"
      ? error
      : new GarrsError({
          code: "persistence",
          message: "The current Garrs assignment could not be verified.",
        }),
  ),
);
