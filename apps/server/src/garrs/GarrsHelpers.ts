import type { GarrsAttemptId, GarrsTaskId } from "@t3tools/contracts";

import {
  type Decision,
  type GarrsEffect,
  GarrsRejection,
  type WorkAggregate,
  currentAttempt,
  isAttemptActive,
  isTaskTerminal,
  isWorkTerminal,
  replaceTask,
  taskFromSpec,
} from "./GarrsDomain.ts";

const reject = (message: string): never => {
  throw new GarrsRejection("conflict", message);
};

export function request(
  aggregate: WorkAggregate,
  input: {
    readonly attemptId: GarrsAttemptId;
    readonly taskId: GarrsTaskId;
    readonly objective: string;
    readonly reason: string;
    readonly deadline: string;
    readonly now: string;
  },
): Decision {
  const current = currentAttempt(aggregate, input.attemptId);
  if (
    current === null ||
    current.attempt.status !== "running" ||
    current.task.status !== "running" ||
    isWorkTerminal(aggregate.workItem)
  ) {
    return reject("Only a currently running task may request a helper.");
  }
  const { task, attempt } = current;
  if (task.helper !== undefined) return reject("Temporary helpers cannot request further helpers.");
  if (!["pixi", "botas", "asta", "copito"].includes(task.agentId))
    return reject("Only Asta, Pixi, Botas and Copito can request a temporary helper.");
  if (input.objective.trim().length < 12 || input.reason.trim().length < 12)
    return reject("A helper needs a specific objective and a concrete reason.");
  const helpers = aggregate.tasks.filter((entry) => entry.helper !== undefined);
  if (helpers.length >= 3)
    return reject("This work item has reached its limit of three temporary helpers.");
  if (helpers.some((entry) => entry.helper?.parentTaskId === task.id && !isTaskTerminal(entry))) {
    return reject("This task already has a helper in progress.");
  }
  let number = helpers.length + 1;
  while (aggregate.tasks.some((entry) => entry.key === `helper-${number}`)) number++;
  const helper = {
    ...taskFromSpec({
      id: input.taskId,
      workItem: aggregate.workItem,
      planRevision: task.planRevision,
      now: input.now,
      spec: {
        key: `helper-${number}`,
        projectId: task.projectId,
        agentId: task.agentId,
        title: `Temporary helper ${number}: ${task.title}`.slice(0, 200),
        objective: input.objective,
        reason: input.reason,
        inputs: [`Supporting task: ${task.title}`, task.objective.slice(0, 2_000)],
        deliverables: ["A bounded result with evidence for the requesting team member"],
        acceptanceCriteria: ["Findings include the evidence and limitations"],
        dependsOn: [],
        capability: "read",
      },
    }),
    helper: { parentTaskId: task.id, parentAttemptId: attempt.id, deadline: input.deadline },
  };
  const parent = {
    ...task,
    status: "waiting_response" as const,
    statusReason: `Waiting for temporary helper ${helper.key}.`,
    updatedAt: input.now,
  };
  return {
    aggregate: {
      ...replaceTask(aggregate, parent),
      tasks: [...replaceTask(aggregate, parent).tasks, helper],
    },
    activity: [
      {
        type: "helper.requested",
        summary: `${task.agentId} requested ${helper.key}: ${input.reason.slice(0, 1_800)}`,
        agentId: task.agentId,
        taskId: helper.id,
        attemptId: attempt.id,
      },
    ],
    effects: [],
  };
}

export function deliveries(aggregate: WorkAggregate): ReadonlyArray<GarrsEffect> {
  return aggregate.tasks.flatMap((task): Array<GarrsEffect> => {
    if (task.helper === undefined || !isTaskTerminal(task)) return [];
    const parent = currentAttempt(aggregate, task.helper.parentAttemptId);
    if (
      parent === null ||
      parent.task.id !== task.helper.parentTaskId ||
      parent.task.status !== "waiting_response" ||
      parent.task.statusReason !== `Waiting for temporary helper ${task.key}.`
    )
      return [];
    return [{ kind: "deliver_helper_result", taskId: task.id }];
  });
}

export function acknowledge(aggregate: WorkAggregate, taskId: GarrsTaskId, now: string): Decision {
  const helper = aggregate.tasks.find((task) => task.id === taskId);
  if (helper?.helper === undefined || !isTaskTerminal(helper))
    return { aggregate, activity: [], effects: [] };
  const parent = currentAttempt(aggregate, helper.helper.parentAttemptId);
  if (
    parent === null ||
    parent.task.id !== helper.helper.parentTaskId ||
    parent.task.status !== "waiting_response" ||
    parent.task.statusReason !== `Waiting for temporary helper ${helper.key}.`
  )
    return { aggregate, activity: [], effects: [] };
  return {
    aggregate: replaceTask(aggregate, {
      ...parent.task,
      status: "running",
      statusReason: null,
      updatedAt: now,
    }),
    activity: [
      {
        type: "helper.result_queued",
        summary: `The result of ${helper.key} was accepted by T3 for its requester.`,
        agentId: parent.task.agentId,
        taskId: helper.id,
        attemptId: parent.attempt.id,
      },
    ],
    effects: [],
  };
}

export function expire(aggregate: WorkAggregate, now: string): Decision {
  const expired = aggregate.tasks.filter(
    (task) =>
      task.helper !== undefined &&
      !isTaskTerminal(task) &&
      (task.helper.deadline <= now ||
        currentAttempt(aggregate, task.helper.parentAttemptId)?.task.status !== "waiting_response"),
  );
  if (expired.length === 0) return { aggregate, activity: [], effects: [] };
  const ids = new Set(expired.map((task) => task.id));
  const active = aggregate.attempts.filter(
    (attempt) => ids.has(attempt.taskId) && isAttemptActive(attempt),
  );
  return {
    aggregate: {
      ...aggregate,
      tasks: aggregate.tasks.map((task) =>
        ids.has(task.id)
          ? {
              ...task,
              status: "failed" as const,
              statusReason:
                task.helper!.deadline <= now
                  ? "Temporary helper deadline reached."
                  : "The requesting task is no longer waiting for this helper.",
              generation: task.generation + 1,
              updatedAt: now,
            }
          : task,
      ),
      attempts: aggregate.attempts.map((attempt) =>
        active.some((item) => item.id === attempt.id)
          ? { ...attempt, status: "cancel_requested" as const, cancelRequestedAt: now }
          : attempt,
      ),
    },
    activity: expired.map((task) => ({
      type: "helper.expired",
      summary:
        task.helper!.deadline <= now
          ? `${task.key} reached its deadline.`
          : `${task.key} stopped because its requester is no longer waiting.`,
      agentId: task.agentId,
      taskId: task.id,
      attemptId: null,
    })),
    effects: active.map((attempt) => ({ kind: "stop_attempt" as const, attemptId: attempt.id })),
  };
}
