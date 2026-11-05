import type { OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isAttemptActive, type WorkAggregate } from "./GarrsDomain.ts";

export const unfinishedWriteTurns = Effect.fn("GarrsTurnSafety.unfinishedWriteTurns")(function* (
  aggregate: WorkAggregate,
  load: (threadId: ThreadId) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, "runs"> | null>,
) {
  for (const attempt of aggregate.attempts) {
    if (isAttemptActive(attempt) || attempt.threadId === null) continue;
    const task = aggregate.tasks.find((entry) => entry.id === attempt.taskId);
    if (task?.capability !== "write") continue;
    const projection = yield* load(attempt.threadId);
    const run = projection === null ? undefined : ThreadManagement.latestRun(projection);
    if (run === undefined || !ThreadManagement.isTerminalRunStatus(run.status)) return true;
  }
  return false;
});
