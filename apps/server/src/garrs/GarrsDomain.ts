/**
 * Pure Garrs decisions: role rules, plan validation, task transitions, scheduling,
 * model selection and delivery gates. Nothing here performs I/O; the service loads
 * state, calls these functions, and commits what they return.
 */
import type {
  GarrsAgentId,
  GarrsAgentStatus,
  GarrsArtifact,
  GarrsAttempt,
  GarrsAttemptId,
  GarrsAutonomy,
  GarrsAuthorizationRecord,
  GarrsCapability,
  GarrsLimits,
  GarrsMessage,
  GarrsPlanRevision,
  GarrsProjectContext,
  GarrsProjectBinding,
  GarrsReview,
  GarrsReviewCriterion,
  GarrsTask,
  GarrsTaskId,
  GarrsTaskSpec,
  GarrsTaskStatus,
  GarrsTeamConfig,
  GarrsWorkItem,
  GarrsWorkItemStatus,
  ProjectId,
} from "@t3tools/contracts";
import type { SelectionResult } from "./GarrsModels.ts";

// ── Roles ──────────────────────────────────────────────────────────────────

interface RoleRule {
  /** Capabilities a task owned by this role may hold. Empty: never assigned tasks. */
  readonly capabilities: ReadonlyArray<GarrsCapability>;
  readonly plans: boolean;
  readonly reviews: boolean;
}

export const ROLE_RULES: Readonly<Record<GarrsAgentId, RoleRule>> = {
  garras: { capabilities: [], plans: false, reviews: false },
  asta: { capabilities: ["read"], plans: true, reviews: false },
  pixi: { capabilities: ["read", "write"], plans: false, reviews: false },
  botas: { capabilities: ["read", "write"], plans: false, reviews: false },
  copito: { capabilities: ["read"], plans: false, reviews: true },
  kex: { capabilities: ["read", "git"], plans: false, reviews: false },
};

const GARRS_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

export function garrsDriverRejection(driver: string): string | null {
  return GARRS_DRIVERS.has(driver)
    ? null
    : "is not enabled for Garrs; only Claude and Codex are supported.";
}

export const planRequiresApproval = (
  autonomy: GarrsAutonomy,
  tasks: ReadonlyArray<GarrsTaskSpec>,
) =>
  autonomy === "approve_plan" ||
  (autonomy === "auto_read" && tasks.some((task) => task.capability !== "read"));

export const PLAN_TASK_KEY = "plan";
export const KEX_WAITING_FOR_REVIEW = "Waiting for Copito to review the current staged state.";

export const GIT_OPERATION_UNAVAILABLE =
  "Garrs cannot restrict Git operations to the user's authorization; Git tasks are unavailable.";

export function defaultTeamConfig(): GarrsTeamConfig {
  return {
    schemaVersion: 1,
    profiles: [
      {
        agentId: "garras",
        displayName: "Garras",
        description:
          "Coordina al equipo y habla con el usuario. Entiende intención, alcance y restricciones; no implementa.",
        personality: "Directo, atento, resolutivo y honesto sobre lo que falta.",
      },
      {
        agentId: "asta",
        displayName: "Asta",
        description:
          "Planificación técnica: alcance, dependencias, riesgos, contratos y criterios de aceptación.",
        personality: "Analítico, estructurado y crítico con supuestos débiles.",
      },
      {
        agentId: "pixi",
        displayName: "Pixigamer69",
        description:
          "Frontend y experiencia: interfaces, accesibilidad, estados, interacción y rendimiento del cliente.",
        personality: "Creativo, expresivo y detallista, sin sacrificar claridad.",
      },
      {
        agentId: "botas",
        displayName: "Botas",
        description:
          "Backend y datos: servicios, contratos, persistencia, integraciones, concurrencia y seguridad.",
        personality: "Práctico, preciso y orientado a soluciones mantenibles.",
      },
      {
        agentId: "copito",
        displayName: "Copito",
        description:
          "Revisión independiente de requisitos, reglas, implementación, pruebas y limitaciones.",
        personality: "Meticuloso, escéptico y claro, sin inventar problemas.",
      },
      {
        agentId: "kex",
        displayName: "Kex",
        description: "Git e integración: diffs, conflictos y operaciones Git autorizadas.",
        personality: "Ordenado, conservador con el historial y explícito sobre las operaciones.",
      },
    ],
    modelPolicy: [],
    limits: {
      maxConcurrentAttempts: 4,
      maxConcurrentAttemptsPerWorkItem: 3,
      maxConcurrentAttemptsPerProvider: 3,
      maxAttemptsPerTask: 2,
      maxCorrectionCycles: 3,
      attemptTimeoutMinutes: 60,
      maxMessagesPerTask: 20,
      tokenWarningPerWorkItem: null,
      tokenLimitPerWorkItem: null,
    },
    review: { requireReviewForWrites: true, reviewDiagnoses: false },
    retention: { keepAttemptThreadsDays: null, storeArtifactBodies: true },
    knowledgeSources: [],
  };
}

export function defaultProjectBinding(projectId: ProjectId): GarrsProjectBinding {
  return {
    projectId,
    enabled: false,
    rulePaths: ["AGENTS.md", "CLAUDE.md"],
    linkedProjectIds: [],
    autonomy: "approve_plan",
    allowedProviderInstanceIds: null,
    modelOverrides: [],
  };
}

export function taskProjectContext(
  workItem: GarrsWorkItem,
  projectId: ProjectId,
): GarrsProjectContext | null {
  if (workItem.projectId === projectId) {
    return workItem.workspace === null
      ? null
      : {
          projectId,
          bindingRevision: workItem.bindingRevision,
          rules: workItem.rules,
          workspace: workItem.workspace,
        };
  }
  return workItem.projectContexts?.find((entry) => entry.projectId === projectId) ?? null;
}

/** Profiles keep stable ids: a document missing one gets the default back, extras are dropped. */
export function normalizeTeamConfig(config: GarrsTeamConfig): GarrsTeamConfig {
  const defaults = defaultTeamConfig();
  return {
    ...config,
    profiles: defaults.profiles.map(
      (profile) => config.profiles.find((entry) => entry.agentId === profile.agentId) ?? profile,
    ),
  };
}

// ── Aggregate ──────────────────────────────────────────────────────────────

export interface WorkAggregate {
  readonly workItem: GarrsWorkItem;
  readonly plans: ReadonlyArray<GarrsPlanRevision>;
  readonly tasks: ReadonlyArray<GarrsTask>;
  readonly attempts: ReadonlyArray<GarrsAttempt>;
  readonly artifacts: ReadonlyArray<GarrsArtifact>;
  readonly reviews: ReadonlyArray<GarrsReview>;
  readonly messages: ReadonlyArray<GarrsMessage>;
}

export interface ActivityDraft {
  readonly type: string;
  readonly summary: string;
  readonly agentId: GarrsAgentId | null;
  readonly taskId: GarrsTaskId | null;
  readonly attemptId: GarrsAttemptId | null;
}

export type GarrsEffect =
  | { readonly kind: "prepare_commit"; readonly taskId: GarrsTaskId }
  | { readonly kind: "execute_push"; readonly proposalId: string }
  | { readonly kind: "execute_commit"; readonly proposalId: string }
  | { readonly kind: "launch_attempt"; readonly attemptId: GarrsAttemptId }
  | { readonly kind: "stop_attempt"; readonly attemptId: GarrsAttemptId }
  | { readonly kind: "resume_attempt"; readonly attemptId: GarrsAttemptId; readonly text: string }
  | { readonly kind: "deliver_helper_result"; readonly taskId: GarrsTaskId }
  | {
      readonly kind: "deliver_message";
      readonly messageId: GarrsMessage["id"];
      readonly attemptId: GarrsAttemptId | null;
    }
  | { readonly kind: "notify_garras"; readonly text: string };

export interface Decision {
  readonly aggregate: WorkAggregate;
  readonly activity: ReadonlyArray<ActivityDraft>;
  readonly effects: ReadonlyArray<GarrsEffect>;
}

export class GarrsRejection {
  readonly _tag = "GarrsRejection";
  readonly code: "invalid" | "conflict" | "forbidden" | "not_found";
  readonly message: string;
  constructor(code: GarrsRejection["code"], message: string) {
    this.code = code;
    this.message = message;
  }
}

const TERMINAL_TASK: ReadonlySet<GarrsTaskStatus> = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_ATTEMPT: ReadonlySet<GarrsAttempt["status"]> = new Set([
  "launching",
  "running",
  "cancel_requested",
]);
const TERMINAL_WORK: ReadonlySet<GarrsWorkItemStatus> = new Set([
  "delivered",
  "accepted",
  "cancelled",
  "failed",
]);

export const isTaskTerminal = (task: GarrsTask) => TERMINAL_TASK.has(task.status);
export const isAttemptActive = (attempt: GarrsAttempt) => ACTIVE_ATTEMPT.has(attempt.status);
export const isWorkTerminal = (workItem: GarrsWorkItem) => TERMINAL_WORK.has(workItem.status);

/** Who may move a task between two states. The server applies mechanical moves itself. */
const TASK_TRANSITIONS: Readonly<Record<GarrsTaskStatus, ReadonlyArray<GarrsTaskStatus>>> = {
  pending: ["ready", "waiting_dependency", "cancelled"],
  waiting_dependency: ["ready", "cancelled"],
  ready: ["running", "waiting_dependency", "cancelled", "failed", "waiting_authorization"],
  waiting_authorization: ["ready", "cancelled"],
  running: [
    "completed",
    "failed",
    "cancelled",
    "waiting_response",
    "ready",
    "in_review",
    "needs_changes",
  ],
  waiting_response: ["running", "cancelled", "failed", "ready"],
  in_review: ["completed", "needs_changes", "cancelled"],
  needs_changes: ["ready", "cancelled"],
  completed: [],
  failed: ["pending", "cancelled"],
  cancelled: ["pending", "failed"],
};

export function canTransitionTask(from: GarrsTaskStatus, to: GarrsTaskStatus): boolean {
  return from === to || TASK_TRANSITIONS[from].includes(to);
}

export function moveTask(
  task: GarrsTask,
  status: GarrsTaskStatus,
  reason: string | null,
  now: string,
) {
  if (!canTransitionTask(task.status, status)) {
    throw new GarrsRejection(
      "conflict",
      `Task ${task.key} cannot move from ${task.status} to ${status}.`,
    );
  }
  return { ...task, status, statusReason: reason, updatedAt: now };
}

// ── Plans ──────────────────────────────────────────────────────────────────

export interface PlanValidationContext {
  readonly projectId: ProjectId;
  readonly additionalProjectIds?: ReadonlyArray<ProjectId>;
  readonly access: GarrsWorkItem["access"];
  readonly authorizations: ReadonlyArray<GarrsAuthorizationRecord>;
  /** Keys of completed tasks from earlier plans that a new plan may depend on. */
  readonly completedKeys: ReadonlySet<string>;
  readonly requiredCheckoutProjectIds?: ReadonlyArray<ProjectId>;
}

export function validateProjectScope(
  projectId: ProjectId,
  requested: ReadonlyArray<ProjectId> | undefined,
  linked: ReadonlyArray<ProjectId>,
): string | null {
  const additional = requested?.filter((entry) => entry !== projectId) ?? [];
  if (additional.some((entry) => !linked.includes(entry))) {
    return "A requested project is not associated with this project.";
  }
  return null;
}

export function validateLinkedProjects(
  projectId: ProjectId,
  linkedProjectIds: ReadonlyArray<ProjectId>,
  availableProjectIds: ReadonlySet<ProjectId>,
): string | null {
  if (linkedProjectIds.includes(projectId)) return "A project cannot be associated with itself.";
  if (new Set(linkedProjectIds).size !== linkedProjectIds.length) {
    return "The associated project list contains a duplicate.";
  }
  if (linkedProjectIds.some((id) => !availableProjectIds.has(id))) {
    return "An associated project is unavailable in this environment.";
  }
  return null;
}

/** Every reason a plan is invalid. Empty means the server accepts it. */
export function validatePlan(
  specs: ReadonlyArray<GarrsTaskSpec>,
  context: PlanValidationContext,
): ReadonlyArray<string> {
  const errors: Array<string> = [];
  const keys = new Set<string>();
  for (const projectId of context.requiredCheckoutProjectIds ?? []) {
    if (
      !specs.some(
        (spec) =>
          (spec.projectId ?? context.projectId) === projectId &&
          spec.capability !== "git" &&
          spec.agentId !== "copito" &&
          spec.agentId !== "kex",
      )
    ) {
      errors.push(`Project ${projectId} needs a task to prepare its isolated checkout.`);
    }
  }
  for (const spec of specs) {
    if (
      spec.projectId !== undefined &&
      spec.projectId !== context.projectId &&
      !context.additionalProjectIds?.includes(spec.projectId)
    ) {
      errors.push(
        `Task "${spec.key}" targets another project that is not associated with this work item.`,
      );
    }
    if (keys.has(spec.key)) errors.push(`Duplicate task key "${spec.key}".`);
    keys.add(spec.key);
    if (context.completedKeys.has(spec.key)) {
      errors.push(`Task key "${spec.key}" is already used by completed work; pick another.`);
    }
    const role = ROLE_RULES[spec.agentId];
    if (role.capabilities.length === 0) {
      errors.push(`${spec.agentId} coordinates and cannot own task "${spec.key}".`);
    } else if (!role.capabilities.includes(spec.capability)) {
      errors.push(
        `${spec.agentId} cannot hold "${spec.capability}" on task "${spec.key}" (allowed: ${role.capabilities.join(", ")}).`,
      );
    }
    if (spec.capability === "write" && context.access !== "write") {
      errors.push(`Task "${spec.key}" writes, but this work item is read-only.`);
    }
    if (spec.capability === "git" && context.access !== "write") {
      errors.push(`Task "${spec.key}" requests Git operations, but this work item is read-only.`);
    }
    if (
      spec.capability === "git" &&
      !context.authorizations.some((auth) => auth.kind === "git_commit" || auth.kind === "git_push")
    ) {
      errors.push(`Task "${spec.key}" needs a Git authorization the user has not granted.`);
    }
    if (spec.deliverables.length === 0) errors.push(`Task "${spec.key}" has no deliverables.`);
    if (spec.acceptanceCriteria.length === 0) {
      errors.push(`Task "${spec.key}" has no acceptance criteria.`);
    }
  }
  for (const spec of specs) {
    for (const dependency of spec.dependsOn) {
      if (dependency === spec.key) errors.push(`Task "${spec.key}" depends on itself.`);
      else if (!keys.has(dependency) && !context.completedKeys.has(dependency)) {
        errors.push(`Task "${spec.key}" depends on unknown task "${dependency}".`);
      }
    }
  }
  const cycle = findCycle(specs);
  if (cycle !== null) errors.push(`Dependency cycle: ${cycle.join(" -> ")}.`);
  return errors;
}

function findCycle(specs: ReadonlyArray<GarrsTaskSpec>): ReadonlyArray<string> | null {
  const edges = new Map(specs.map((spec) => [spec.key, spec.dependsOn] as const));
  const state = new Map<string, "visiting" | "done">();
  const stack: Array<string> = [];
  const visit = (key: string): ReadonlyArray<string> | null => {
    const current = state.get(key);
    if (current === "done") return null;
    if (current === "visiting") return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, "visiting");
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      if (!edges.has(next)) continue;
      const found = visit(next);
      if (found !== null) return found;
    }
    stack.pop();
    state.set(key, "done");
    return null;
  };
  for (const spec of specs) {
    const found = visit(spec.key);
    if (found !== null) return found;
  }
  return null;
}

export function taskFromSpec(input: {
  readonly id: GarrsTaskId;
  readonly workItem: GarrsWorkItem;
  readonly planRevision: number;
  readonly spec: GarrsTaskSpec;
  readonly now: string;
}): GarrsTask {
  const { spec } = input;
  return {
    id: input.id,
    workItemId: input.workItem.id,
    projectId: input.spec.projectId ?? input.workItem.projectId,
    planRevision: input.planRevision,
    key: spec.key,
    agentId: spec.agentId,
    title: spec.title,
    objective: spec.objective,
    reason: spec.reason,
    inputs: spec.inputs,
    deliverables: spec.deliverables,
    acceptanceCriteria: spec.acceptanceCriteria,
    dependsOn: spec.dependsOn,
    capability: spec.capability,
    status: "pending",
    statusReason: null,
    generation: 0,
    attemptCount: 0,
    pinnedSelection: spec.selection ?? null,
    pinnedBy: spec.selection === undefined ? null : "coordinator",
    ...(spec.selectionReason === undefined ? {} : { selectionReason: spec.selectionReason }),
    ...(spec.fallbackSelections === undefined
      ? {}
      : { fallbackSelections: spec.fallbackSelections }),
    completionArtifactId: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function planTaskSpec(objective: string): GarrsTaskSpec {
  return {
    key: PLAN_TASK_KEY,
    agentId: "asta",
    title: "Plan técnico",
    objective,
    reason: "Asta convierte la petición en un plan ejecutable y validable.",
    inputs: ["Objetivo del usuario", "Reglas del proyecto"],
    deliverables: ["Plan estructurado enviado con garrs action submit_plan"],
    acceptanceCriteria: [
      "Cada tarea tiene responsable permitido, entregables y criterios",
      "Las dependencias no forman ciclos",
      "El alcance respeta el acceso autorizado del trabajo",
    ],
    dependsOn: [],
    capability: "read",
  };
}

function reviewTaskSpec(key: string, dependsOn: ReadonlyArray<string>, cycle: number) {
  return {
    key,
    agentId: "copito",
    title: cycle === 0 ? "Revisión independiente" : `Revisión de correcciones (${cycle})`,
    objective:
      "Revisar el resultado integrado contra la petición original, los criterios de aceptación y las reglas del proyecto.",
    reason: "La política del equipo exige revisión independiente antes de entregar cambios.",
    inputs: ["Petición original", "Plan vigente", "Diff integrado", "Evidencia de pruebas"],
    deliverables: ["Revisión enviada con garrs action submit_review"],
    acceptanceCriteria: [
      "Cada criterio queda verificado, incumplido, no aplicable o no verificable con evidencia",
      "Cada hallazgo tiene severidad, ubicación y condición de resolución",
    ],
    dependsOn: [...dependsOn],
    capability: "read",
  } satisfies GarrsTaskSpec;
}

// ── Model selection ────────────────────────────────────────────────────────

// ── Scheduling ─────────────────────────────────────────────────────────────

export interface ScheduleContext {
  readonly now: string;
  readonly limits: GarrsLimits;
  readonly requireReviewForWrites: boolean;
  readonly reviewDiagnoses?: boolean;
  /** Active attempts across every work item, and per provider instance. */
  readonly runningGlobal: number;
  readonly runningByInstance: ReadonlyMap<string, number>;
  readonly newTaskId: () => GarrsTaskId;
  readonly newAttemptId: () => GarrsAttemptId;
  readonly select: (task: GarrsTask) => SelectionResult;
  /** Current workspace + rules hash of write work; null when unknown or read-only. */
  readonly subjectHash: string | null;
  readonly tokensUsed: number | null;
  /** Do not overlap the next work with a writer's provider turn still finishing. */
  readonly holdLaunches: boolean;
}

const activePlan = (aggregate: WorkAggregate) =>
  aggregate.plans
    .filter((plan) => plan.status === "active")
    .toSorted((a, b) => b.revision - a.revision)[0];

export const isReviewTask = (task: GarrsTask) =>
  task.agentId === "copito" && task.helper === undefined;

export const hasVerifiedCriteria = (criteria: ReadonlyArray<GarrsReviewCriterion>) =>
  criteria.some((criterion) => criterion.status === "verified") &&
  !criteria.some(
    (criterion) => criterion.status === "failed" || criterion.status === "unverifiable",
  );

function validApprovedReview(
  aggregate: WorkAggregate,
  subjectHash: string | null,
): GarrsReview | undefined {
  return aggregate.reviews.find(
    (review) =>
      review.status === "valid" &&
      review.verdict === "approved" &&
      hasVerifiedCriteria(review.criteria) &&
      subjectHash !== null &&
      review.subjectHash === subjectHash,
  );
}

const needsReview = (
  aggregate: WorkAggregate,
  requireReviewForWrites: boolean,
  reviewDiagnoses = false,
) =>
  (aggregate.workItem.access === "read_only" &&
    ((reviewDiagnoses && aggregate.workItem.intent === "diagnose") ||
      aggregate.tasks.some((task) => isReviewTask(task) && task.status !== "cancelled"))) ||
  (aggregate.workItem.access === "write" &&
    aggregate.tasks.some((task) => task.capability === "write" && task.status === "completed") &&
    ((requireReviewForWrites &&
      !aggregate.workItem.authorizations.some((auth) => auth.kind === "review_waiver")) ||
      aggregate.tasks.some((task) => task.agentId === "kex" && task.status !== "cancelled")));

/** What still blocks delivery. Empty when Garras may deliver. */
export function deliveryBlockers(
  aggregate: WorkAggregate,
  requireReviewForWrites: boolean,
  subjectHash: string | null,
  reviewDiagnoses = false,
): ReadonlyArray<string> {
  const blockers: Array<string> = [];
  const { workItem } = aggregate;
  if (isWorkTerminal(workItem)) blockers.push(`Work item is already ${workItem.status}.`);
  if (workItem.status === "awaiting_approval")
    blockers.push("The plan awaits the user's approval.");
  if (
    activePlan(aggregate) === undefined &&
    !aggregate.tasks.some((task) => task.status === "completed")
  ) {
    blockers.push("No plan has been accepted yet.");
  }
  for (const task of aggregate.tasks) {
    if (task.helper !== undefined) continue;
    if (task.status === "cancelled") continue;
    if (task.status === "failed")
      blockers.push(`Task "${task.title}" failed: ${task.statusReason ?? "no reason"}.`);
    else if (task.status !== "completed")
      blockers.push(
        `Task "${task.title}" is ${task.status}${task.statusReason === null ? "" : `: ${task.statusReason}`}.`,
      );
  }
  const needsValidState =
    needsReview(aggregate, requireReviewForWrites, reviewDiagnoses) ||
    (workItem.access === "read_only" && (workItem.projectContexts?.length ?? 0) > 0);
  if (needsValidState) {
    if (subjectHash === null)
      blockers.push(
        "The review state is unavailable or incomplete; check project rules, Git output, and untracked files (limit 2,000).",
      );
    else if (
      needsReview(aggregate, requireReviewForWrites, reviewDiagnoses) &&
      validApprovedReview(aggregate, subjectHash) === undefined
    ) {
      blockers.push("Copito has not approved the current integrated changes.");
    }
  }
  return blockers;
}

/** Invalidate approvals whose subject no longer matches the workspace and rules. */
export function invalidateStaleReviews(
  aggregate: WorkAggregate,
  subjectHash: string | null,
): { readonly aggregate: WorkAggregate; readonly activity: ReadonlyArray<ActivityDraft> } {
  const activity: Array<ActivityDraft> = [];
  const reviews = aggregate.reviews.map((review) => {
    if (review.status !== "valid") return review;
    const reason =
      review.subjectHash !== subjectHash
        ? "Workspace or rules changed after this review."
        : review.verdict === "approved" && !hasVerifiedCriteria(review.criteria)
          ? "Required review criteria were not verified."
          : null;
    if (reason === null) return review;
    activity.push({
      type: "review.invalidated",
      summary: `${reason} This review no longer counts toward delivery.`,
      agentId: "copito",
      taskId: review.taskId,
      attemptId: review.attemptId,
    });
    return {
      ...review,
      status: "invalidated" as const,
      invalidatedReason: reason,
    };
  });
  return activity.length === 0
    ? { aggregate, activity }
    : { aggregate: { ...aggregate, reviews }, activity };
}

/**
 * Advance mechanical state: dependency gates, review creation, work item status,
 * and new attempts within limits. Idempotent: calling it twice changes nothing more.
 */
export function reconcile(input: WorkAggregate, context: ScheduleContext): Decision {
  const activity: Array<ActivityDraft> = [];
  const effects: Array<GarrsEffect> = [];
  const invalidated = invalidateStaleReviews(input, context.subjectHash);
  activity.push(...invalidated.activity);
  let aggregate = invalidated.aggregate;
  let { workItem } = aggregate;
  const now = context.now;
  let tasks = [...aggregate.tasks];
  const attempts = [...aggregate.attempts];

  if (isWorkTerminal(workItem)) return { aggregate, activity, effects };
  if (workItem.resumeRequested) {
    if (attempts.some((attempt) => attempt.status === "cancel_requested"))
      return { aggregate, activity, effects };
    const plan =
      activePlan(aggregate) ?? aggregate.plans.find((plan) => plan.status === "awaiting_approval");
    const planner = tasks.findLast(
      (task) =>
        task.agentId === "asta" && task.key.startsWith(PLAN_TASK_KEY) && task.helper === undefined,
    );
    tasks = tasks.map((task) =>
      task.helper === undefined &&
      (task.status === "failed" || task.status === "cancelled") &&
      (plan === undefined ? task.id === planner?.id : task.planRevision === plan.revision)
        ? attempts.filter(
            (attempt) =>
              attempt.taskId === task.id &&
              attempt.generation >= (task.attemptLimitGeneration ?? 0),
          ).length >= context.limits.maxAttemptsPerTask
          ? moveTask(task, "failed", "Attempt limit reached.", now)
          : moveTask(
              task,
              "pending",
              "Continuing the existing task; prior changes and evidence are preserved.",
              now,
            )
        : task,
    );
    const approval = aggregate.plans.some((plan) => plan.status === "awaiting_approval");
    workItem = {
      ...workItem,
      resumeRequested: false,
      status: approval ? "awaiting_approval" : "active",
      statusReason: approval ? "The plan awaits the user's approval." : null,
      updatedAt: now,
    };
    aggregate = { ...aggregate, workItem, tasks };
    activity.push({
      type: "work.resumed",
      summary: "Continued the existing plan without repeating completed work.",
      agentId: null,
      taskId: null,
      attemptId: null,
    });
  }

  // Dependency gates.
  const byKey = new Map(tasks.map((task) => [task.key, task] as const));
  tasks = tasks.map((task) => {
    if (
      task.status !== "pending" &&
      task.status !== "waiting_dependency" &&
      task.status !== "ready"
    ) {
      return task;
    }
    const dependencies = task.dependsOn.map((key) => byKey.get(key));
    const broken = dependencies.find(
      (dependency) =>
        dependency === undefined ||
        dependency.status === "failed" ||
        dependency.status === "cancelled",
    );
    if (broken !== undefined || dependencies.some((dependency) => dependency === undefined)) {
      const reason = `Blocked: dependency ${broken?.key ?? "missing"} did not complete.`;
      return task.status === "waiting_dependency" && task.statusReason === reason
        ? task
        : moveTask(task, "waiting_dependency", reason, now);
    }
    const done = dependencies.every((dependency) => dependency?.status === "completed");
    if (done && task.status !== "ready") return moveTask(task, "ready", null, now);
    if (!done && task.status === "pending") {
      return moveTask(task, "waiting_dependency", "Waiting for dependencies.", now);
    }
    return task;
  });

  // Git remains blocked until its reviewed operation can be authorized precisely.
  const others = tasks.filter(
    (task) =>
      task.helper === undefined &&
      !isReviewTask(task) &&
      task.capability !== "git" &&
      !(workItem.access === "write" && task.agentId === "kex" && task.status !== "completed") &&
      task.status !== "cancelled",
  );
  const reviewPending = tasks.some((task) => isReviewTask(task) && !isTaskTerminal(task));
  const pendingKex = tasks.find(
    (task) =>
      task.agentId === "kex" &&
      task.capability === "read" &&
      ["pending", "waiting_dependency", "ready"].includes(task.status) &&
      task.helper === undefined,
  );
  if (
    pendingKex !== undefined &&
    workItem.access === "write" &&
    workItem.workspace?.isolated === true &&
    workItem.workspace.checkoutPath !== null &&
    (workItem.projectContexts?.length ?? 0) === 0 &&
    others.every((task) => task.status === "completed") &&
    !context.holdLaunches &&
    !tasks.some(
      (task) => isReviewTask(task) && ["running", "waiting_response"].includes(task.status),
    ) &&
    !["paused", "blocked", "awaiting_approval"].includes(workItem.status) &&
    workItem.commitPreparation?.status !== "pending" &&
    (workItem.commitPreparation?.taskId !== pendingKex.id ||
      workItem.commitPreparation.status !== "prepared" ||
      workItem.commitPreparation.subjectHash !== context.subjectHash)
  ) {
    workItem = {
      ...workItem,
      commitPreparation: {
        taskId: pendingKex.id,
        status: "pending",
        subjectHash: context.subjectHash,
        reason: null,
      },
      updatedAt: now,
    };
    effects.push({ kind: "prepare_commit", taskId: pendingKex.id });
  }
  const preparingCommit = workItem.commitPreparation?.status === "pending";
  aggregate = { ...aggregate, workItem, tasks };
  if (
    (others.length > 0 || tasks.some(isReviewTask)) &&
    others.every((task) => task.status === "completed") &&
    needsReview(aggregate, context.requireReviewForWrites, context.reviewDiagnoses) &&
    !reviewPending &&
    !preparingCommit &&
    context.subjectHash !== null &&
    validApprovedReview(aggregate, context.subjectHash) === undefined &&
    !aggregate.reviews.some(
      (review) => review.status === "valid" && review.subjectHash === context.subjectHash,
    )
  ) {
    const cycle = tasks.filter(isReviewTask).length;
    const spec = reviewTaskSpec(`review-${cycle + 1}`, [], workItem.correctionCycles);
    const review: GarrsTask = {
      ...taskFromSpec({
        id: context.newTaskId(),
        workItem,
        planRevision: activePlan(aggregate)?.revision ?? 0,
        spec,
        now,
      }),
      status: "ready",
    };
    tasks.push(review);
    activity.push({
      type: "task.created",
      summary: "Copito's independent review was scheduled for the integrated changes.",
      agentId: "copito",
      taskId: review.id,
      attemptId: null,
    });
  }

  if (validApprovedReview({ ...aggregate, tasks }, context.subjectHash) !== undefined) {
    tasks = tasks.map((task) => {
      if (
        task.agentId !== "kex" ||
        task.status !== "waiting_response" ||
        task.statusReason !== KEX_WAITING_FOR_REVIEW
      )
        return task;
      const attempt = attempts.find(
        (entry) =>
          entry.taskId === task.id &&
          entry.generation === task.generation &&
          entry.status === "running" &&
          entry.threadId !== null,
      );
      if (attempt === undefined) return task;
      effects.push({
        kind: "resume_attempt",
        attemptId: attempt.id,
        text: "Copito approved the current state. You may propose the commit again; do not push.",
      });
      return moveTask(task, "running", null, now);
    });
  }

  // Launches within limits.
  const blockedStatuses: ReadonlySet<GarrsWorkItemStatus> = new Set([
    "paused",
    "awaiting_approval",
    "blocked",
  ]);
  const tokenLimitHit =
    context.limits.tokenLimitPerWorkItem !== null &&
    context.tokensUsed !== null &&
    context.tokensUsed >= context.limits.tokenLimitPerWorkItem;
  if (tokenLimitHit && workItem.status !== "paused") {
    workItem = {
      ...workItem,
      status: "paused",
      statusReason: "Token limit reached; new assignments paused.",
      updatedAt: now,
    };
    activity.push({
      type: "work.paused",
      summary: "Token limit reached; no new assignments start.",
      agentId: null,
      taskId: null,
      attemptId: null,
    });
  }
  if (!blockedStatuses.has(workItem.status) && !context.holdLaunches && !preparingCommit) {
    let runningHere = attempts.filter(isAttemptActive).length;
    let runningGlobal = context.runningGlobal;
    const runningByInstance = new Map(context.runningByInstance);
    const checkoutKey = (task: GarrsTask) =>
      taskProjectContext(workItem, task.projectId)?.workspace.checkoutPath ?? task.projectId;
    const needsCheckout = (task: GarrsTask) =>
      workItem.access === "write" &&
      taskProjectContext(workItem, task.projectId)?.workspace.checkoutPath === null;
    const preparingProjects = new Set(
      attempts.filter(isAttemptActive).flatMap((attempt) => {
        const task = tasks.find((entry) => entry.id === attempt.taskId);
        return task !== undefined && needsCheckout(task) ? [task.projectId] : [];
      }),
    );
    const busyCheckouts = new Set(
      tasks.flatMap((task) =>
        (task.status === "running" || task.status === "waiting_response") &&
        (task.capability === "write" || task.capability === "git")
          ? [checkoutKey(task)]
          : [],
      ),
    );
    tasks = tasks.map((task) => {
      if (task.status !== "ready") return task;
      if (isReviewTask(task) && others.some((entry) => entry.status !== "completed")) {
        return {
          ...task,
          statusReason: "Waiting for the integrated results before review.",
          updatedAt: now,
        };
      }
      if (task.helper !== undefined) {
        const parent = currentAttempt(aggregate, task.helper.parentAttemptId);
        if (
          task.helper.deadline <= now ||
          parent === null ||
          parent.task.id !== task.helper.parentTaskId ||
          parent.task.status !== "waiting_response" ||
          parent.task.statusReason !== `Waiting for temporary helper ${task.key}.`
        ) {
          const reason =
            task.helper.deadline <= now
              ? "Temporary helper deadline reached."
              : "The requesting task is no longer waiting for this helper.";
          activity.push({
            type: "helper.expired",
            summary: `${task.key}: ${reason}`,
            agentId: task.agentId,
            taskId: task.id,
            attemptId: null,
          });
          return moveTask(task, "failed", reason, now);
        }
      }
      if (
        task.agentId === "kex" &&
        task.capability === "read" &&
        workItem.access === "write" &&
        tasks.some((entry) => entry.capability === "write") &&
        validApprovedReview(aggregate, context.subjectHash) === undefined
      ) {
        return {
          ...task,
          statusReason: "Awaiting Copito’s approval before Git preparation.",
          updatedAt: now,
        };
      }
      if (task.capability === "git") {
        if (task.statusReason === GIT_OPERATION_UNAVAILABLE) return task;
        activity.push({
          type: "task.blocked",
          summary: `"${task.title}": ${GIT_OPERATION_UNAVAILABLE}`,
          agentId: task.agentId,
          taskId: task.id,
          attemptId: null,
        });
        return { ...task, statusReason: GIT_OPERATION_UNAVAILABLE, updatedAt: now };
      }
      if (runningHere >= context.limits.maxConcurrentAttemptsPerWorkItem) return task;
      if (runningGlobal >= context.limits.maxConcurrentAttempts) return task;
      if (needsCheckout(task) && preparingProjects.has(task.projectId)) {
        return {
          ...task,
          statusReason: "Waiting for this project's isolated checkout to be prepared.",
          updatedAt: now,
        };
      }
      const writes = task.capability === "write";
      if (writes && busyCheckouts.has(checkoutKey(task))) return task;
      const generationAttempts = attempts.filter(
        (attempt) =>
          attempt.taskId === task.id && attempt.generation >= (task.attemptLimitGeneration ?? 0),
      ).length;
      if (
        generationAttempts >= (task.helper === undefined ? context.limits.maxAttemptsPerTask : 1)
      ) {
        activity.push({
          type: "task.failed",
          summary: `"${task.title}" reached its attempt limit.`,
          agentId: task.agentId,
          taskId: task.id,
          attemptId: null,
        });
        return moveTask(task, "failed", "Attempt limit reached.", now);
      }
      const selected = context.select(task);
      if (!selected.ok) {
        if (task.statusReason === selected.reason) return task;
        activity.push({
          type: "task.blocked",
          summary: `"${task.title}": ${selected.reason}`,
          agentId: task.agentId,
          taskId: task.id,
          attemptId: null,
        });
        effects.push({
          kind: "notify_garras",
          text: `Model decision needed for ${workItem.id}, task ${task.id} (${task.agentId}, ${task.projectId}): ${selected.reason} Read garrs status and models; use select_model with a concrete reason and permitted alternatives. Do not poll or change user preferences.`,
        });
        return { ...task, statusReason: selected.reason, updatedAt: now };
      }
      const instanceId = selected.decision.requested.instanceId;
      if (
        (runningByInstance.get(instanceId) ?? 0) >= context.limits.maxConcurrentAttemptsPerProvider
      ) {
        return task;
      }
      const attempt: GarrsAttempt = {
        id: context.newAttemptId(),
        taskId: task.id,
        workItemId: workItem.id,
        agentId: task.agentId,
        generation: task.generation,
        threadId: null,
        runId: null,
        readOnlyEnforced: task.capability === "read",
        decision: selected.decision,
        status: "launching",
        error: null,
        createdAt: now,
        startedAt: null,
        endedAt: null,
        cancelRequestedAt: null,
        reviewSubjectHash: isReviewTask(task) ? context.subjectHash : null,
        usage: unknownUsage(),
      };
      attempts.push(attempt);
      effects.push({ kind: "launch_attempt", attemptId: attempt.id });
      activity.push({
        type: "attempt.created",
        summary: `${task.agentId} starts "${task.title}" on ${instanceId} / ${selected.decision.requested.model}.`,
        agentId: task.agentId,
        taskId: task.id,
        attemptId: attempt.id,
      });
      runningHere += 1;
      runningGlobal += 1;
      runningByInstance.set(instanceId, (runningByInstance.get(instanceId) ?? 0) + 1);
      if (needsCheckout(task)) preparingProjects.add(task.projectId);
      if (writes) busyCheckouts.add(checkoutKey(task));
      return { ...moveTask(task, "running", null, now), attemptCount: task.attemptCount + 1 };
    });
  }

  aggregate = { ...aggregate, workItem, tasks, attempts };
  const status = deriveWorkStatus(aggregate, context);
  if (status !== workItem.status && !blockedStatuses.has(workItem.status)) {
    workItem = {
      ...workItem,
      status,
      statusReason:
        status === "blocked" &&
        context.subjectHash === null &&
        needsReview(aggregate, context.requireReviewForWrites, context.reviewDiagnoses)
          ? "The review state is unavailable. Restore the rules or checkout, then resume."
          : null,
      updatedAt: now,
    };
    if (status === "ready_to_deliver") {
      effects.push({
        kind: "notify_garras",
        text: `Work item "${workItem.title}" is ready to deliver. Review its results with garrs action status, then deliver with garrs action deliver.`,
      });
    }
    if (status === "blocked") {
      effects.push({
        kind: "notify_garras",
        text: `Work item "${workItem.title}" is blocked. Read garrs action status and tell the user what is missing.`,
      });
    }
  }
  return { aggregate: { ...aggregate, workItem }, activity, effects };
}

function deriveWorkStatus(aggregate: WorkAggregate, context: ScheduleContext): GarrsWorkItemStatus {
  const live = aggregate.tasks.filter((task) => task.status !== "cancelled");
  if (live.length === 0) return aggregate.workItem.status;
  if (context.holdLaunches) return activePlanStatus(aggregate);
  if (live.some((task) => task.status === "running" && isReviewTask(task))) return "in_review";
  if (live.some((task) => !isTaskTerminal(task))) {
    const stuck = live.every(
      (task) =>
        isTaskTerminal(task) ||
        (task.status === "waiting_dependency" && (task.statusReason ?? "").startsWith("Blocked")) ||
        (task.status === "ready" && task.statusReason !== null),
    );
    return stuck && !live.some((task) => task.status === "running")
      ? "blocked"
      : activePlanStatus(aggregate);
  }
  if (live.some((task) => task.status === "failed")) return "blocked";
  if (
    context.subjectHash === null &&
    needsReview(aggregate, context.requireReviewForWrites, context.reviewDiagnoses)
  )
    return "blocked";
  return deliveryBlockers(
    aggregate,
    context.requireReviewForWrites,
    context.subjectHash,
    context.reviewDiagnoses,
  ).length === 0
    ? "ready_to_deliver"
    : "active";
}

const activePlanStatus = (aggregate: WorkAggregate): GarrsWorkItemStatus =>
  activePlan(aggregate) === undefined ? "planning" : "active";

export function unknownUsage(): GarrsAttempt["usage"] {
  return {
    quality: "unknown",
    inputTokens: null,
    cachedInputTokens: null,
    cacheCreationTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    providerTurns: 0,
    queueWaitMs: null,
    runDurationMs: null,
  };
}

// ── Attempt outcomes ───────────────────────────────────────────────────────

/** The attempt a tool call or run event may act for: current generation and still active. */
export function currentAttempt(
  aggregate: WorkAggregate,
  attemptId: GarrsAttemptId,
): { readonly attempt: GarrsAttempt; readonly task: GarrsTask } | null {
  const attempt = aggregate.attempts.find((entry) => entry.id === attemptId);
  if (attempt === undefined) return null;
  const task = aggregate.tasks.find((entry) => entry.id === attempt.taskId);
  if (task === undefined) return null;
  if (attempt.generation !== task.generation || !isAttemptActive(attempt)) return null;
  return { attempt, task };
}

export function replaceTask(aggregate: WorkAggregate, task: GarrsTask): WorkAggregate {
  return {
    ...aggregate,
    tasks: aggregate.tasks.map((entry) => (entry.id === task.id ? task : entry)),
  };
}

export function replaceAttempt(aggregate: WorkAggregate, attempt: GarrsAttempt): WorkAggregate {
  return {
    ...aggregate,
    attempts: aggregate.attempts.map((entry) => (entry.id === attempt.id ? attempt : entry)),
  };
}

// ── Team status ────────────────────────────────────────────────────────────

/** Who is doing what, derived from persisted attempts; never from chat text. */
export function agentStatuses(
  aggregates: ReadonlyArray<WorkAggregate>,
): ReadonlyArray<GarrsAgentStatus> {
  const order: ReadonlyArray<GarrsAgentId> = ["garras", "asta", "pixi", "botas", "copito", "kex"];
  return order.map((agentId): GarrsAgentStatus => {
    for (const aggregate of aggregates) {
      const tasks = aggregate.tasks.filter(
        (task) => task.agentId === agentId && !isTaskTerminal(task),
      );
      const running = tasks.find((task) => task.status === "running");
      const waiting = tasks.find((task) => task.status === "waiting_response");
      const task =
        running ??
        waiting ??
        tasks.find((entry) => entry.status === "ready" && entry.statusReason !== null);
      if (task === undefined) continue;
      const attempt = aggregate.attempts
        .filter((entry) => entry.taskId === task.id && entry.generation === task.generation)
        .at(-1);
      return {
        agentId,
        state: running !== undefined ? "working" : waiting !== undefined ? "waiting" : "blocked",
        workItemId: aggregate.workItem.id,
        taskId: task.id,
        taskTitle: task.title,
        attemptId: attempt?.id ?? null,
        threadId: attempt?.threadId ?? null,
        selection: attempt?.decision.requested ?? null,
        waitingFor: running !== undefined ? null : task.statusReason,
      };
    }
    return {
      agentId,
      state: "idle",
      workItemId: null,
      taskId: null,
      taskTitle: null,
      attemptId: null,
      threadId: null,
      selection: null,
      waitingFor: null,
    };
  });
}
