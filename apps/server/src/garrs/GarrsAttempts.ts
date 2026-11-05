import type {
  GarrsAttempt,
  GarrsAttemptId,
  RunId,
  OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import {
  currentAttempt,
  isAttemptActive,
  moveTask,
  replaceAttempt,
  replaceTask,
  type WorkAggregate,
  type Decision,
} from "./GarrsDomain.ts";

export function applyRunStarted(
  aggregate: WorkAggregate,
  input: {
    readonly attemptId: GarrsAttemptId;
    readonly runId: RunId;
    readonly now: string;
    readonly humanResponse?: boolean;
  },
): Decision {
  const current = currentAttempt(aggregate, input.attemptId);
  if (
    current === null ||
    current.attempt.status === "cancel_requested" ||
    current.attempt.runId === input.runId ||
    !["running", "waiting_response"].includes(current.task.status)
  )
    return { aggregate, activity: [], effects: [] };
  return {
    aggregate: replaceTask(
      replaceAttempt(aggregate, { ...current.attempt, runId: input.runId }),
      current.task.status === "waiting_response" &&
        input.humanResponse &&
        current.task.agentId !== "kex" &&
        !current.task.statusReason?.startsWith("Waiting for temporary helper ")
        ? moveTask(current.task, "running", null, input.now)
        : current.task,
    ),
    activity: [
      {
        type: "attempt.continued",
        summary: "T3 started a new turn in the current team assignment.",
        taskId: current.task.id,
        attemptId: current.attempt.id,
        agentId: current.task.agentId,
      },
    ],
    effects: [],
  };
}

const SAFE_PROVIDER_FAILURES = new Set([
  "Garrs cannot start with external or unverifiable MCP configuration. Disable external MCP servers for this session.",
  "Garrs cannot start while an external MCP server is available to the thread.",
  "Garrs requires the T3 MCP server.",
  "Garrs could not verify the complete MCP server list.",
  "Garrs could not verify its T3 MCP server.",
  "Cannot verify the review's work item and project roots.",
  "Cannot verify read-only access to all review projects.",
  "Garrs writers require a verified isolated checkout.",
  "Garrs cannot recreate a missing checkout automatically; inspect the worktree and start a new work item.",
]);

const safeProviderFailure = (message: string | undefined) => {
  if (message === undefined) return null;
  if (SAFE_PROVIDER_FAILURES.has(message)) return message;
  for (const reason of [
    "Garrs cannot prepare a worktree while checkout filters are configured.",
    "Garrs cannot prepare a worktree containing submodules.",
    "Cannot verify the project's checkout filters.",
    "Cannot verify the project's checkout tree.",
    "Cannot verify checkout filters and submodules.",
  ]) {
    if (message.endsWith(reason)) return reason;
  }
  if (
    message.startsWith("Cannot verify review project ") ||
    message.startsWith("Review project ")
  ) {
    return "A review project is unavailable or its repository could not be verified.";
  }
  return null;
};

/**
 * A provider run of an attempt ended. A late end for a superseded or cancelled
 * attempt changes nothing. A run that ended without a report gets one reminder;
 * a second silent end fails the attempt.
 */
export function applyRunEnded(
  aggregate: WorkAggregate,
  input: {
    readonly attemptId: GarrsAttemptId;
    readonly runStatus: string;
    readonly now: string;
    readonly remindersSent: number;
    readonly usage: GarrsAttempt["usage"];
    readonly effectiveModel: string | null;
    readonly effectiveModelSource?: "provider_response";
    readonly failureMessage?: string;
    readonly failure?: OrchestrationV2ProviderFailure;
  },
): Decision {
  const attempt = aggregate.attempts.find((entry) => entry.id === input.attemptId);
  if (attempt === undefined) return { aggregate, activity: [], effects: [] };
  const withUsage = (entry: GarrsAttempt): GarrsAttempt => ({
    ...entry,
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    usage: input.usage,
    decision:
      input.effectiveModel === null
        ? { ...entry.decision, effectiveModelSource: "unverifiable" }
        : {
            ...entry.decision,
            effectiveModel: input.effectiveModel,
            effectiveModelSource: input.effectiveModelSource ?? "provider_session",
          },
  });
  const task = aggregate.tasks.find((entry) => entry.id === attempt.taskId);
  if (attempt.status === "cancel_requested") {
    const cancelled = withUsage({ ...attempt, status: "cancelled", endedAt: input.now });
    let next = replaceAttempt(aggregate, cancelled);
    if (
      task !== undefined &&
      (task.status === "running" || task.status === "waiting_response") &&
      task.generation === attempt.generation
    ) {
      next = replaceTask(next, moveTask(task, "failed", "Stopped by the user.", input.now));
    }
    return {
      aggregate: next,
      activity: [
        {
          type: "attempt.cancelled",
          summary: "Stop confirmed: the attempt's run ended.",
          agentId: attempt.agentId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
        },
      ],
      effects: [],
    };
  }
  if (!isAttemptActive(attempt) || task === undefined || task.generation !== attempt.generation) {
    // Stale: record usage only; never reactivate or complete anything.
    return {
      aggregate: replaceAttempt(
        aggregate,
        withUsage({ ...attempt, endedAt: attempt.endedAt ?? input.now }),
      ),
      activity: [],
      effects: [],
    };
  }
  if (task.status === "waiting_response" && input.runStatus === "completed") {
    return { aggregate: replaceAttempt(aggregate, withUsage(attempt)), activity: [], effects: [] };
  }
  if (input.runStatus === "completed" && input.remindersSent === 0) {
    return {
      aggregate: replaceAttempt(aggregate, withUsage(attempt)),
      activity: [
        {
          type: "attempt.reminded",
          summary: "Run ended without a report; asked once for it.",
          agentId: attempt.agentId,
          taskId: task.id,
          attemptId: attempt.id,
        },
      ],
      effects: [
        {
          kind: "resume_attempt",
          attemptId: attempt.id,
          text: "Your turn ended without a Garrs report. Call the Garrs reporting tool for your task now (garrs action report, garrs action submit_plan or garrs action submit_review) with what you actually did and found. Do not redo work.",
        },
      ],
    };
  }
  const reason =
    input.runStatus === "completed"
      ? "The run ended twice without a structured report."
      : input.failure?.class === "usage_limit"
        ? `Provider reported a usage limit${input.failure.code === null ? "" : ` (${input.failure.code})`}; reset ${input.failure.resetAt ?? "unknown"}.`
        : (safeProviderFailure(input.failureMessage) ??
          `The provider run ended as ${input.runStatus}.`);
  const failed = withUsage({
    ...attempt,
    status: input.runStatus === "interrupted" ? "interrupted" : "failed",
    error: reason,
    endedAt: input.now,
  });
  const retry = moveTask(task, "ready", `Retrying after: ${reason}`, input.now);
  return {
    aggregate: replaceTask(replaceAttempt(aggregate, failed), retry),
    activity: [
      {
        type: "attempt.failed",
        summary: reason,
        agentId: attempt.agentId,
        taskId: task.id,
        attemptId: attempt.id,
      },
    ],
    effects: [],
  };
}
