/** Pure command decisions for Garrs. Inputs carry ids and time; outputs are committed by the service. */
import type {
  GarrsAgentId,
  GarrsArtifact,
  GarrsArtifactId,
  GarrsAttemptId,
  GarrsAutonomy,
  GarrsControlAction,
  GarrsMessage,
  GarrsMessageId,
  GarrsPlanRevision,
  GarrsPlanRevisionId,
  ProjectId,
  GarrsReportInput,
  GarrsReview,
  GarrsReviewId,
  GarrsSendMessageInput,
  GarrsSubmitPlanInput,
  GarrsSubmitReviewInput,
  GarrsTask,
  GarrsTaskId,
  GarrsWorkspaceState,
} from "@t3tools/contracts";
import * as Struct from "effect/Struct";

import {
  type ActivityDraft,
  type Decision,
  type GarrsEffect,
  GarrsRejection,
  PLAN_TASK_KEY,
  KEX_WAITING_FOR_REVIEW,
  ROLE_RULES,
  type WorkAggregate,
  canTransitionTask,
  currentAttempt,
  isAttemptActive,
  isReviewTask,
  isTaskTerminal,
  isWorkTerminal,
  planTaskSpec,
  planRequiresApproval,
  replaceAttempt,
  replaceTask,
  taskFromSpec,
  taskProjectContext,
  validatePlan,
} from "./GarrsDomain.ts";

const reject = (code: GarrsRejection["code"], message: string): never => {
  throw new GarrsRejection(code, message);
};

function requireCurrent(aggregate: WorkAggregate, attemptId: GarrsAttemptId) {
  const current = currentAttempt(aggregate, attemptId);
  if (current === null) {
    return reject(
      "conflict",
      "This attempt is no longer current; its result cannot change the work.",
    );
  }
  return current;
}

function setTaskStatus(
  task: GarrsTask,
  status: GarrsTask["status"],
  reason: string | null,
  now: string,
) {
  if (!canTransitionTask(task.status, status)) {
    return reject("conflict", `Task "${task.key}" cannot move from ${task.status} to ${status}.`);
  }
  return { ...task, status, statusReason: reason, updatedAt: now };
}

const completedKeys = (aggregate: WorkAggregate) =>
  new Set(aggregate.tasks.filter((task) => task.status === "completed").map((task) => task.key));

// ── Asta's plan ────────────────────────────────────────────────────────────

export function submitPlan(
  aggregate: WorkAggregate,
  input: {
    readonly attemptId: GarrsAttemptId;
    readonly plan: GarrsSubmitPlanInput;
    readonly planId: GarrsPlanRevisionId;
    readonly newTaskId: () => GarrsTaskId;
    readonly autonomy: GarrsAutonomy;
    readonly now: string;
  },
): Decision {
  const { attempt, task } = requireCurrent(aggregate, input.attemptId);
  if (
    task.helper !== undefined ||
    !ROLE_RULES[task.agentId].plans ||
    !task.key.startsWith(PLAN_TASK_KEY)
  ) {
    reject("forbidden", "Only Asta's planning task can submit a plan.");
  }
  const errors = validatePlan(input.plan.tasks, {
    projectId: aggregate.workItem.projectId,
    additionalProjectIds:
      aggregate.workItem.projectContexts?.map((context) => context.projectId) ?? [],
    access: aggregate.workItem.access,
    authorizations: aggregate.workItem.authorizations,
    completedKeys: completedKeys(aggregate),
    ...(aggregate.workItem.access === "write" &&
    (aggregate.workItem.projectContexts?.length ?? 0) > 0
      ? {
          requiredCheckoutProjectIds: [
            ...(aggregate.workItem.workspace?.checkoutPath == null
              ? [aggregate.workItem.projectId]
              : []),
            ...(aggregate.workItem.projectContexts ?? [])
              .filter((entry) => entry.workspace.checkoutPath === null)
              .map((entry) => entry.projectId),
          ],
        }
      : {}),
  });
  if (errors.length > 0) reject("invalid", `Plan rejected:\n- ${errors.join("\n- ")}`);

  const revision = Math.max(0, ...aggregate.plans.map((plan) => plan.revision)) + 1;
  const awaiting = planRequiresApproval(input.autonomy, input.plan.tasks);
  const plan: GarrsPlanRevision = {
    id: input.planId,
    workItemId: aggregate.workItem.id,
    revision,
    authorAttemptId: attempt.id,
    summary: input.plan.summary,
    risks: input.plan.risks,
    tasks: input.plan.tasks,
    status: awaiting ? "awaiting_approval" : "active",
    createdAt: input.now,
  };
  // Replanning keeps completed work; unfinished tasks of older plans are superseded.
  const supersededTasks = aggregate.tasks.map((entry) =>
    entry.id === task.id || isTaskTerminal(entry) || entry.status === "running"
      ? entry
      : {
          ...entry,
          status: "cancelled" as const,
          statusReason: "Superseded by a new plan.",
          generation: entry.generation + 1,
          updatedAt: input.now,
        },
  );
  const newTasks = input.plan.tasks.map((spec) =>
    taskFromSpec({
      id: input.newTaskId(),
      workItem: aggregate.workItem,
      planRevision: revision,
      spec: Struct.omit(spec, ["selection", "selectionReason", "fallbackSelections"]),
      now: input.now,
    }),
  );
  const plans = aggregate.plans.map((entry) =>
    entry.status === "active" || entry.status === "awaiting_approval"
      ? { ...entry, status: "superseded" as const }
      : entry,
  );
  const doneTask = setTaskStatus(
    supersededTasks.find((entry) => entry.id === task.id)!,
    "completed",
    null,
    input.now,
  );
  const next: WorkAggregate = {
    ...aggregate,
    workItem: {
      ...aggregate.workItem,
      status: awaiting ? "awaiting_approval" : "active",
      statusReason: awaiting ? "The plan awaits the user's approval." : null,
      updatedAt: input.now,
    },
    plans: [...plans, plan],
    tasks: [
      ...supersededTasks.map((entry) => (entry.id === task.id ? doneTask : entry)),
      ...newTasks,
    ],
    attempts: aggregate.attempts.map((entry) =>
      entry.id === attempt.id ? { ...entry, status: "succeeded" as const } : entry,
    ),
  };
  return {
    aggregate: next,
    activity: [
      {
        type: "plan.submitted",
        summary: `Plan revision ${revision} with ${newTasks.length} tasks${awaiting ? " awaits approval" : " is active"}.`,
        agentId: "asta",
        taskId: task.id,
        attemptId: attempt.id,
      },
    ],
    effects: awaiting
      ? [
          {
            kind: "notify_garras",
            text: `Asta's plan for "${aggregate.workItem.title}" needs the user's approval. Summarize it for the user; they approve it from the Team panel.`,
          },
        ]
      : [],
  };
}

// ── Reports ────────────────────────────────────────────────────────────────

export function report(
  aggregate: WorkAggregate,
  input: {
    readonly attemptId: GarrsAttemptId;
    readonly report: GarrsReportInput;
    readonly artifactId: GarrsArtifactId;
    readonly contentHash: string;
    readonly workspace: GarrsWorkspaceState | null;
    readonly now: string;
  },
): Decision {
  const { attempt, task } = requireCurrent(aggregate, input.attemptId);
  if (isReviewTask(task)) {
    reject("invalid", "Review tasks report with garrs action submit_review.");
  }
  if (task.key === PLAN_TASK_KEY && input.report.outcome === "done") {
    reject("invalid", "The planning task reports with garrs action submit_plan.");
  }
  if (input.report.kind === "code_change" && task.capability !== "write") {
    reject("forbidden", "This task cannot produce code changes.");
  }
  if (task.capability === "read") {
    const project = taskProjectContext(aggregate.workItem, task.projectId);
    const baseline =
      task.projectId === aggregate.workItem.projectId
        ? aggregate.workItem.readOnlyBaseline
        : project?.workspace.baseSha != null && project.baselineDiffHash !== undefined
          ? { headSha: project.workspace.baseSha, diffHash: project.baselineDiffHash }
          : undefined;
    if (baseline !== undefined) {
      if (
        input.workspace?.headSha !== baseline.headSha ||
        input.workspace.diffHash !== baseline.diffHash
      ) {
        reject(
          "conflict",
          "The project state changed or could not be verified while this read-only task was running.",
        );
      }
    } else if (input.workspace !== null && input.workspace.changedFiles.length > 0) {
      reject("forbidden", "A read-only task changed files; the report was refused.");
    }
  }
  const activity: Array<ActivityDraft> = [];
  const effects: Array<GarrsEffect> = [];
  let next = aggregate;
  if (input.report.outcome === "done") {
    const artifact: GarrsArtifact = {
      id: input.artifactId,
      workItemId: aggregate.workItem.id,
      taskId: task.id,
      attemptId: attempt.id,
      agentId: task.agentId,
      kind: input.report.kind,
      summary: input.report.summary,
      body: input.report.body,
      evidence: input.report.evidence,
      contentHash: input.contentHash,
      workspace: input.workspace,
      createdAt: input.now,
    };
    next = {
      ...replaceTask(next, {
        ...setTaskStatus(task, "completed", null, input.now),
        completionArtifactId: artifact.id,
      }),
      artifacts: [...next.artifacts, artifact],
    };
    next = replaceAttempt(next, { ...attempt, status: "succeeded" });
    activity.push({
      type: "artifact.created",
      summary: `${task.agentId} delivered "${task.title}": ${input.report.summary}`,
      agentId: task.agentId,
      taskId: task.id,
      attemptId: attempt.id,
    });
  } else if (input.report.outcome === "needs_input") {
    next = replaceTask(
      next,
      setTaskStatus(
        task,
        "waiting_response",
        input.report.question ?? input.report.summary,
        input.now,
      ),
    );
    activity.push({
      type: "task.waiting",
      summary: `${task.agentId} needs input: ${input.report.question ?? input.report.summary}`,
      agentId: task.agentId,
      taskId: task.id,
      attemptId: attempt.id,
    });
    effects.push({
      kind: "notify_garras",
      text: `${task.agentId} needs input on "${task.title}": ${input.report.question ?? input.report.summary}\nAnswer with garrs action send_message (kind "answer", to "${task.agentId}", toTaskId "${task.id}"), asking the user first if only they can answer.`,
    });
  } else {
    next = replaceTask(
      next,
      setTaskStatus(task, "failed", `Blocked: ${input.report.summary}`, input.now),
    );
    next = replaceAttempt(next, { ...attempt, status: "succeeded" });
    activity.push({
      type: "task.blocked",
      summary: `${task.agentId} is blocked: ${input.report.summary}`,
      agentId: task.agentId,
      taskId: task.id,
      attemptId: attempt.id,
    });
    effects.push({
      kind: "notify_garras",
      text: `${task.agentId} reported a blocker on "${task.title}": ${input.report.summary}\nInspect persisted attempt failures and current model eligibility. Recover or replan with garrs action revise within the user's existing authorization, configured approvals and attempt, token and time limits. Ask the user only when a real missing decision, new permission or exhausted budget prevents continuing; do not request authorization already granted or override limits.`,
    });
  }
  return { aggregate: next, activity, effects };
}

// ── Copito's review ────────────────────────────────────────────────────────

export function submitReview(
  aggregate: WorkAggregate,
  input: {
    readonly attemptId: GarrsAttemptId;
    readonly review: GarrsSubmitReviewInput;
    readonly reviewId: GarrsReviewId;
    /** The subject as it is now; compared with the one Copito was launched with. */
    readonly currentSubjectHash: string | null;
    readonly newTaskId: () => GarrsTaskId;
    readonly maxCorrectionCycles: number;
    readonly now: string;
  },
): Decision {
  const { attempt, task } = requireCurrent(aggregate, input.attemptId);
  if (task.helper !== undefined || !ROLE_RULES[task.agentId].reviews || !isReviewTask(task))
    reject("forbidden", "Only Copito's review task submits reviews.");
  const bound = attempt.reviewSubjectHash;
  const drift =
    bound === null
      ? "The reviewed state could not be read when this review started."
      : bound !== input.currentSubjectHash
        ? "Files or rules changed while Copito was reviewing."
        : null;
  const blocking = input.review.findings.filter(
    (finding) => finding.severity === "blocker" || finding.severity === "major",
  );
  const failed = input.review.criteria.some((criterion) => criterion.status === "failed");
  if (input.review.verdict === "approved" && (blocking.length > 0 || failed)) {
    reject("invalid", "An approval cannot carry blocker or major findings or failed criteria.");
  }
  const projects = new Set([
    aggregate.workItem.projectId,
    ...(aggregate.workItem.projectContexts ?? []).map((project) => project.projectId),
  ]);
  for (const finding of input.review.findings) {
    if (finding.projectId !== undefined && !projects.has(finding.projectId)) {
      reject("invalid", "A review finding targets a project outside this work item.");
    }
    if (projects.size > 1 && finding.severity !== "info" && finding.projectId === undefined) {
      reject("invalid", "Each actionable finding in cross-project work needs its projectId.");
    }
  }
  const review: GarrsReview = {
    id: input.reviewId,
    workItemId: aggregate.workItem.id,
    taskId: task.id,
    attemptId: attempt.id,
    subjectHash: bound ?? input.currentSubjectHash ?? "unavailable",
    verdict: input.review.verdict,
    criteria: input.review.criteria,
    findings: input.review.findings,
    status: drift === null ? "valid" : "invalidated",
    invalidatedReason: drift,
    createdAt: input.now,
  };
  let next: WorkAggregate = {
    ...replaceAttempt(replaceTask(aggregate, setTaskStatus(task, "completed", null, input.now)), {
      ...attempt,
      status: "succeeded",
    }),
    reviews: [...aggregate.reviews, review],
  };
  const activity: Array<ActivityDraft> = [
    {
      type: "review.submitted",
      summary: `Copito: ${input.review.verdict} with ${input.review.findings.length} findings.`,
      agentId: "copito",
      taskId: task.id,
      attemptId: attempt.id,
    },
  ];
  const effects: Array<GarrsEffect> = [];
  if (drift !== null) {
    // Findings about a state that no longer exists are kept for reading but not acted on;
    // reconcile schedules a fresh review of the current state.
    activity.push({
      type: "review.invalidated",
      summary: `${drift} The review was kept for reference and does not count.`,
      agentId: "copito",
      taskId: task.id,
      attemptId: attempt.id,
    });
  } else if (input.review.verdict === "blocked") {
    const reason =
      "Copito could not complete the review; Garras must resolve the reported blocker.";
    next = {
      ...replaceTask(next, {
        ...(task.pinnedBy === "user"
          ? task
          : {
              ...Struct.omit(task, ["selectionReason", "fallbackSelections"]),
              pinnedSelection: null,
              pinnedBy: null,
            }),
        status: "ready",
        statusReason: reason,
        updatedAt: input.now,
      }),
      workItem: {
        ...next.workItem,
        ...(next.workItem.status === "paused" ? {} : { status: "blocked", statusReason: reason }),
        updatedAt: input.now,
      },
    };
    effects.push({
      kind: "notify_garras",
      text: `Copito could not complete review task ${task.id}. Read its criteria and findings, then resolve the operational blocker within the existing authorization and attempt limits. No code correction was requested. Use models and select_model for this retry-ready review if another account or tool policy is needed; preserve any exact user model pin. Do not ask again for permission already granted.`,
    });
  } else if (input.review.verdict === "changes_requested") {
    const cycles = aggregate.workItem.correctionCycles + 1;
    if (cycles > input.maxCorrectionCycles) {
      next = {
        ...next,
        workItem: {
          ...next.workItem,
          status: "blocked",
          statusReason: `Correction cycle limit (${input.maxCorrectionCycles}) reached.`,
          updatedAt: input.now,
        },
      };
      effects.push({
        kind: "notify_garras",
        text: `Copito still finds problems after ${input.maxCorrectionCycles} correction cycles on "${aggregate.workItem.title}". Present the open findings to the user with options: another cycle, a narrower scope, or accepting with a recorded waiver.`,
      });
    } else {
      // Corrections go back to the owners Copito named; other work is left alone.
      const owners = new Map<
        string,
        { agentId: GarrsAgentId; projectId: ProjectId; items: Array<string> }
      >();
      for (const finding of input.review.findings) {
        if (finding.severity === "info") continue;
        const owner = ROLE_RULES[finding.suggestedOwner].capabilities.includes("write")
          ? finding.suggestedOwner
          : "botas";
        const projectId = finding.projectId ?? aggregate.workItem.projectId;
        const key = `${projectId}:${owner}`;
        const group = owners.get(key) ?? { agentId: owner, projectId, items: [] };
        owners.set(key, {
          ...group,
          items: [
            ...group.items,
            `${finding.description} (${finding.location}). Resolve when: ${finding.resolutionCondition}`,
          ],
        });
      }
      const corrections = [...owners.values()].map(({ agentId, projectId, items }, index) =>
        taskFromSpec({
          id: input.newTaskId(),
          workItem: next.workItem,
          planRevision: task.planRevision,
          now: input.now,
          spec: {
            key: `fix-${cycles}-${agentId}-${index + 1}`,
            projectId,
            agentId,
            title: `Correcciones de revisión (${cycles})`,
            objective: `Resolve Copito's findings:\n- ${items.join("\n- ")}`,
            reason: "Copito returned findings on this owner's area.",
            inputs: ["Review findings", "Current integrated diff"],
            deliverables: ["Code changes that meet each resolution condition", "Test evidence"],
            acceptanceCriteria: items.map((item) => `Resolved: ${item}`),
            dependsOn: [],
            capability: next.workItem.access === "write" ? "write" : "read",
          },
        }),
      );
      next = {
        ...next,
        tasks: [...next.tasks, ...corrections],
        workItem: { ...next.workItem, correctionCycles: cycles, updatedAt: input.now },
      };
      activity.push({
        type: "corrections.created",
        summary: `${corrections.length} correction tasks went back to their owners.`,
        agentId: "copito",
        taskId: task.id,
        attemptId: attempt.id,
      });
    }
  }
  if (drift === null && input.review.verdict === "approved") {
    for (const waiting of next.tasks) {
      if (
        waiting.agentId !== "kex" ||
        waiting.status !== "waiting_response" ||
        waiting.statusReason !== KEX_WAITING_FOR_REVIEW
      )
        continue;
      const active = next.attempts.find(
        (entry) =>
          entry.taskId === waiting.id &&
          entry.generation === waiting.generation &&
          entry.status === "running" &&
          entry.threadId !== null,
      );
      if (active === undefined) continue;
      next = replaceTask(next, setTaskStatus(waiting, "running", null, input.now));
      effects.push({
        kind: "resume_attempt",
        attemptId: active.id,
        text: "Copito approved the current state. You may propose the commit again; do not push.",
      });
    }
  }
  return { aggregate: next, activity, effects };
}

// ── Messages ───────────────────────────────────────────────────────────────

export function sendMessage(
  aggregate: WorkAggregate,
  input: {
    readonly from: GarrsAgentId | "user";
    readonly fromTaskId: GarrsTaskId | null;
    readonly message: GarrsSendMessageInput;
    readonly messageId: GarrsMessageId;
    readonly maxMessagesPerTask: number;
    readonly now: string;
  },
): Decision {
  if (isWorkTerminal(aggregate.workItem)) reject("conflict", "This work item is closed.");
  if (input.from === input.message.to) reject("invalid", "An agent cannot message itself.");
  if (input.fromTaskId !== null) {
    const sent = aggregate.messages.filter((message) => message.taskId === input.fromTaskId).length;
    if (sent >= input.maxMessagesPerTask) {
      reject(
        "conflict",
        `Message limit for this task (${input.maxMessagesPerTask}) reached; report a blocker instead.`,
      );
    }
  }
  let toTaskId = input.message.toTaskId;
  if (input.message.replyTo !== undefined) {
    const original =
      aggregate.messages.find((message) => message.id === input.message.replyTo) ??
      reject("not_found", "The message being answered does not exist in this work item.");
    if (original.toAgent !== input.from || original.fromAgent !== input.message.to) {
      reject("invalid", "Only the original recipient can reply to the sender.");
    }
    if (original.toTaskId !== undefined && original.toTaskId !== input.fromTaskId) {
      reject("invalid", "Only the original recipient task can reply to this message.");
    }
    if (original.taskId !== null) {
      if (toTaskId !== undefined && toTaskId !== original.taskId) {
        reject("invalid", "A reply must target the original sender's task.");
      }
      toTaskId = original.taskId;
    }
  }
  const targets = aggregate.tasks.filter(
    (task) =>
      task.agentId === input.message.to && task.helper === undefined && !isTaskTerminal(task),
  );
  if (toTaskId === undefined && targets.length > 1) {
    reject("invalid", "This member has multiple tasks; specify toTaskId from Garrs status.");
  }
  const target = toTaskId === undefined ? targets[0] : targets.find((task) => task.id === toTaskId);
  if (toTaskId !== undefined && target === undefined) {
    reject("conflict", "The recipient task is unavailable or does not belong to this member.");
  }
  toTaskId = target?.id;
  const targetAttempt =
    target === undefined
      ? undefined
      : aggregate.attempts.find(
          (attempt) =>
            attempt.taskId === target.id &&
            attempt.generation === target.generation &&
            attempt.status === "running",
        );
  const message: GarrsMessage = {
    id: input.messageId,
    workItemId: aggregate.workItem.id,
    taskId: input.fromTaskId,
    fromAgent: input.from,
    toAgent: input.message.to,
    ...(toTaskId === undefined ? {} : { toTaskId }),
    kind: input.message.kind,
    body: input.message.body,
    refs: input.message.refs ?? [],
    replyTo: input.message.replyTo ?? null,
    deliveryStatus: "pending",
    createdAt: input.now,
  };
  const effects: Array<GarrsEffect> = [];
  const next: WorkAggregate = { ...aggregate, messages: [...aggregate.messages, message] };
  if (input.message.to === "garras") {
    effects.push({ kind: "deliver_message", messageId: message.id, attemptId: null });
  } else if (
    target !== undefined &&
    targetAttempt?.threadId != null &&
    (target.status === "running" || message.kind === "answer")
  ) {
    effects.push({ kind: "deliver_message", messageId: message.id, attemptId: targetAttempt.id });
  }
  return {
    aggregate: next,
    activity: [
      {
        type: "message.sent",
        summary: `${input.from} → ${input.message.to} (${message.kind}), awaiting delivery.`,
        agentId: input.from === "user" ? null : input.from,
        taskId: input.fromTaskId,
        attemptId: null,
      },
    ],
    effects,
  };
}

export function pendingMessageEffects(
  aggregate: WorkAggregate,
  attemptId: GarrsAttemptId,
): ReadonlyArray<GarrsEffect> {
  const current = currentAttempt(aggregate, attemptId);
  if (
    current === null ||
    current.task.helper !== undefined ||
    current.attempt.status !== "running" ||
    current.attempt.threadId === null ||
    isWorkTerminal(aggregate.workItem)
  )
    return [];
  return aggregate.messages
    .filter(
      (message) =>
        message.toAgent === current.task.agentId &&
        message.deliveryStatus === "pending" &&
        (current.task.status === "running" || message.kind === "answer") &&
        (message.toTaskId === undefined
          ? aggregate.tasks.filter(
              (task) =>
                task.agentId === current.task.agentId &&
                task.helper === undefined &&
                !isTaskTerminal(task),
            ).length === 1
          : message.toTaskId === current.task.id),
    )
    .map((message) => ({ kind: "deliver_message" as const, messageId: message.id, attemptId }));
}

export function acknowledgeMessage(
  aggregate: WorkAggregate,
  messageId: GarrsMessageId,
  attemptId: GarrsAttemptId | null,
  now: string,
): Decision {
  const message = aggregate.messages.find((entry) => entry.id === messageId);
  if (message === undefined || message.deliveryStatus !== "pending") {
    return { aggregate, activity: [], effects: [] };
  }
  let next: WorkAggregate = {
    ...aggregate,
    messages: aggregate.messages.map((entry) =>
      entry.id === messageId ? { ...entry, deliveryStatus: "queued" } : entry,
    ),
  };
  let resumed = false;
  if (attemptId !== null && message.kind === "answer") {
    const current = currentAttempt(next, attemptId);
    if (current?.task.status === "waiting_response") {
      next = replaceTask(next, setTaskStatus(current.task, "running", null, now));
      resumed = true;
    }
  }
  return {
    aggregate: next,
    activity: [
      {
        type: "message.queued",
        summary: `Message ${messageId} was accepted by T3 for ${message.toAgent}; provider receipt is not confirmed.`,
        agentId: message.toAgent === "user" ? null : message.toAgent,
        taskId: message.taskId,
        attemptId,
      },
    ],
    effects: resumed && attemptId !== null ? pendingMessageEffects(next, attemptId) : [],
  };
}

// ── User controls ──────────────────────────────────────────────────────────

export function control(
  aggregate: WorkAggregate,
  action: GarrsControlAction,
  now: string,
): Decision & { readonly effect: string } {
  const { workItem } = aggregate;
  const activeAttempts = aggregate.attempts.filter(isAttemptActive);
  const done = (next: WorkAggregate, effect: string, effects: ReadonlyArray<GarrsEffect> = []) => ({
    aggregate: next,
    activity: [
      {
        type: `control.${action.type}`,
        summary: effect,
        agentId: null,
        taskId: null,
        attemptId: null,
      },
    ],
    effects,
    effect,
  });
  const withStatus = (status: typeof workItem.status, reason: string | null) => ({
    ...aggregate,
    workItem: { ...workItem, status, statusReason: reason, updatedAt: now },
  });
  const authorize = (kind: (typeof workItem.authorizations)[number]["kind"], note: string) => ({
    ...aggregate,
    workItem: {
      ...workItem,
      authorizations: [
        ...workItem.authorizations,
        { kind, grantedBy: "user" as const, note, grantedAt: now },
      ],
      updatedAt: now,
    },
  });

  switch (action.type) {
    case "pause": {
      if (isWorkTerminal(workItem)) reject("conflict", `Work item is ${workItem.status}.`);
      const running = activeAttempts.length;
      return done(
        withStatus("paused", "Paused by the user."),
        running === 0
          ? "Paused. No attempt was running; no new assignments start."
          : `Paused new assignments. ${running} running attempt(s) continue; stop them individually or cancel the work.`,
      );
    }
    case "resume": {
      if (workItem.status !== "paused" && workItem.status !== "blocked") {
        reject("conflict", `Only paused or blocked work resumes; this is ${workItem.status}.`);
      }
      return done(withStatus("active", null), "Resumed. Ready tasks start within the team limits.");
    }
    case "cancel": {
      if (isWorkTerminal(workItem)) reject("conflict", `Work item is already ${workItem.status}.`);
      const next: WorkAggregate = {
        ...withStatus("cancelled", action.reason ?? "Cancelled by the user."),
        tasks: aggregate.tasks.map((task) =>
          isTaskTerminal(task)
            ? task
            : {
                ...task,
                status: "cancelled" as const,
                statusReason: "Work item cancelled.",
                generation: task.generation + 1,
                updatedAt: now,
              },
        ),
        attempts: aggregate.attempts.map((attempt) =>
          isAttemptActive(attempt)
            ? { ...attempt, status: "cancel_requested" as const, cancelRequestedAt: now }
            : attempt,
        ),
      };
      return done(
        next,
        activeAttempts.length === 0
          ? "Cancelled. Nothing was running."
          : `Cancelled. Stop requested for ${activeAttempts.length} running attempt(s); each shows cancelled once its run confirms the stop.`,
        activeAttempts.map((attempt) => ({ kind: "stop_attempt" as const, attemptId: attempt.id })),
      );
    }
    case "accept": {
      if (workItem.status !== "delivered")
        reject("conflict", "Only delivered work can be accepted.");
      return done(
        {
          ...withStatus("accepted", null),
          workItem: { ...workItem, status: "accepted", acceptedAt: now, updatedAt: now },
        },
        "Accepted.",
      );
    }
    case "approve_plan": {
      const plan = aggregate.plans.find((entry) => entry.status === "awaiting_approval");
      if (plan === undefined) reject("conflict", "No plan awaits approval.");
      if (plan!.id !== action.planId) {
        const seen = aggregate.plans.find((entry) => entry.id === action.planId);
        reject(
          "conflict",
          `The plan changed: you approved ${seen === undefined ? "an unknown plan" : `revision ${seen.revision}`}, but revision ${plan!.revision} awaits approval. Review it and approve again.`,
        );
      }
      const approved = authorize("plan_approval", `Plan revision ${plan!.revision}`);
      return done(
        {
          ...approved,
          workItem: { ...approved.workItem, status: "active", statusReason: null },
          plans: aggregate.plans.map((entry) =>
            entry.id === plan!.id ? { ...entry, status: "active" as const } : entry,
          ),
        },
        `Plan revision ${plan!.revision} approved; its tasks start within the team limits.`,
      );
    }
    case "stop_attempt": {
      const attempt = aggregate.attempts.find((entry) => entry.id === action.attemptId);
      if (attempt === undefined) reject("not_found", "Attempt not found.");
      if (!isAttemptActive(attempt!)) reject("conflict", `Attempt is already ${attempt!.status}.`);
      if (attempt!.status === "cancel_requested") {
        return done(aggregate, "Stop was already requested; waiting for the run to confirm.");
      }
      return done(
        replaceAttempt(aggregate, {
          ...attempt!,
          status: "cancel_requested",
          cancelRequestedAt: now,
        }),
        "Stop requested. The attempt shows cancelled once its run confirms the stop.",
        [{ kind: "stop_attempt", attemptId: attempt!.id }],
      );
    }
    case "retry_task": {
      const task = aggregate.tasks.find((entry) => entry.id === action.taskId);
      if (task === undefined) reject("not_found", "Task not found.");
      if (task!.helper !== undefined)
        reject(
          "conflict",
          "Temporary helpers cannot be retried; the responsible member may request new bounded help.",
        );
      if (task!.status !== "failed" && task!.status !== "cancelled") {
        reject(
          "conflict",
          `Only failed or cancelled tasks are retried; this one is ${task!.status}.`,
        );
      }
      const next = replaceTask(aggregate, {
        ...task!,
        status: "pending",
        statusReason: "Retry requested by the user.",
        generation: task!.generation + 1,
        updatedAt: now,
      });
      return done(
        workItem.status === "blocked"
          ? { ...next, workItem: { ...next.workItem, status: "active", statusReason: null } }
          : next,
        `"${task!.title}" will run again as a new attempt.`,
      );
    }
    case "reassign_task": {
      const task = aggregate.tasks.find((entry) => entry.id === action.taskId);
      if (task === undefined) reject("not_found", "Task not found.");
      if (
        task!.status === "running" ||
        task!.status === "completed" ||
        task!.status === "waiting_response"
      ) {
        reject("conflict", `A ${task!.status} task cannot change its assignment; stop it first.`);
      }
      return done(
        replaceTask(aggregate, {
          ...Struct.omit(task!, ["modelInstruction", "selectionReason", "fallbackSelections"]),
          pinnedSelection: action.selection,
          pinnedBy: "user",
          statusReason: null,
          updatedAt: now,
        }),
        `"${task!.title}" will use ${action.selection.instanceId} / ${action.selection.model} on its next attempt, without fallback.`,
      );
    }
    case "waive_review":
      return done(
        authorize("review_waiver", action.reason),
        "Independent review waived by the user; the waiver is recorded on the work item.",
      );
    case "approve_push": {
      const proposal = workItem.pushProposal;
      if (
        isWorkTerminal(workItem) ||
        proposal === undefined ||
        proposal.id !== action.proposalId ||
        proposal.status !== "proposed"
      )
        reject("conflict", "The push proposal is no longer awaiting approval.");
      return done(
        {
          ...aggregate,
          workItem: {
            ...workItem,
            pushProposal: { ...proposal!, status: "approved", approvedAt: now },
            updatedAt: now,
          },
        },
        "Push approved for this commit and destination only.",
        [{ kind: "execute_push", proposalId: proposal!.id }],
      );
    }
    case "approve_commit": {
      const proposal = workItem.commitProposal;
      if (proposal === undefined || proposal.id !== action.proposalId) {
        reject("conflict", "The commit proposal changed; review the current proposal first.");
      }
      if (proposal!.status !== "proposed") {
        reject("conflict", "This commit proposal has already been approved.");
      }
      return done(
        {
          ...aggregate,
          workItem: {
            ...workItem,
            commitProposal: { ...proposal!, status: "approved", approvedAt: now },
            updatedAt: now,
          },
        },
        "Commit proposal approved; the server will create the commit.",
        [{ kind: "execute_commit", proposalId: proposal!.id }],
      );
    }
    case "authorize":
      return done(
        authorize(action.kind, action.note),
        `Authorization recorded: ${action.kind}. It applies to this work item only.`,
      );
  }
}

// ── Garras ─────────────────────────────────────────────────────────────────

export function revise(
  aggregate: WorkAggregate,
  input: {
    readonly feedback: string;
    readonly access: WorkAggregate["workItem"]["access"] | undefined;
    readonly invalidatePrevious?: boolean;
    readonly newTaskId: () => GarrsTaskId;
    readonly now: string;
  },
): Decision {
  const { workItem } = aggregate;
  if (
    input.access === "write" &&
    workItem.access !== "write" &&
    (workItem.projectContexts?.length ?? 0) > 0
  ) {
    reject(
      "conflict",
      "This cross-project work was opened read-only; start a new write work item to prepare isolated checkouts.",
    );
  }
  if (workItem.status === "cancelled")
    reject("conflict", "A cancelled work item cannot be revised.");
  if (aggregate.attempts.some(isAttemptActive)) {
    reject("conflict", "Wait for running attempts to finish or stop them before revising.");
  }
  const revision = workItem.revision + 1;
  const completed = input.invalidatePrevious
    ? []
    : aggregate.tasks.filter((task) => task.status === "completed");
  const planTask = taskFromSpec({
    id: input.newTaskId(),
    workItem,
    planRevision: 0,
    now: input.now,
    spec: {
      ...planTaskSpec(
        `${workItem.objective}\n\nUser feedback (revision ${revision}):\n${input.feedback}\n\nCompleted tasks you may depend on and should not redo unless the feedback invalidates them: ${completed.map((task) => `${task.key} (${task.title})`).join(", ") || "none"}.`,
      ),
      key: `${PLAN_TASK_KEY}-r${revision}`,
    },
  });
  return {
    aggregate: {
      ...aggregate,
      workItem: {
        ...workItem,
        revision,
        access: input.access ?? workItem.access,
        status: "planning",
        statusReason: null,
        deliveredAt: null,
        acceptedAt: null,
        updatedAt: input.now,
      },
      tasks: [
        ...aggregate.tasks.map((task) =>
          input.invalidatePrevious && task.status !== "cancelled"
            ? {
                ...task,
                status: "cancelled" as const,
                statusReason: "Superseded because project state changed.",
                generation: task.generation + 1,
                updatedAt: input.now,
              }
            : task,
        ),
        planTask,
      ],
      plans: input.invalidatePrevious
        ? aggregate.plans.map((plan) =>
            plan.status === "active" || plan.status === "awaiting_approval"
              ? { ...plan, status: "superseded" as const }
              : plan,
          )
        : aggregate.plans,
      reviews: input.invalidatePrevious
        ? aggregate.reviews.map((review) =>
            review.status === "valid"
              ? {
                  ...review,
                  status: "invalidated" as const,
                  invalidatedReason: "Project state changed before replanning.",
                }
              : review,
          )
        : aggregate.reviews,
    },
    activity: [
      {
        type: "work.revised",
        summary: input.invalidatePrevious
          ? `Revision ${revision}: project state changed; earlier results and reviews were superseded.`
          : `Revision ${revision}: Asta replans from the user's feedback.`,
        agentId: "garras",
        taskId: planTask.id,
        attemptId: null,
      },
    ],
    effects: [],
  };
}

export function deliver(
  aggregate: WorkAggregate,
  input: { readonly blockers: ReadonlyArray<string>; readonly now: string },
): Decision {
  if (input.blockers.length > 0) {
    reject("conflict", `Not ready to deliver:\n- ${input.blockers.join("\n- ")}`);
  }
  return {
    aggregate: {
      ...aggregate,
      workItem: {
        ...aggregate.workItem,
        status: "delivered",
        statusReason: null,
        deliveredAt: input.now,
        updatedAt: input.now,
      },
    },
    activity: [
      {
        type: "work.delivered",
        summary: "Garras delivered the result to the user.",
        agentId: "garras",
        taskId: null,
        attemptId: null,
      },
    ],
    effects: [],
  };
}
