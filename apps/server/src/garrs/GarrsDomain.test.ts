import { describe, expect, it } from "@effect/vitest";
import {
  type GarrsAttempt,
  GarrsAttemptId,
  GarrsMessageId,
  GarrsPlanRevisionId,
  GarrsReviewId,
  type GarrsTask,
  GarrsTaskId,
  type GarrsTaskSpec,
  GarrsStartWorkInput,
  type GarrsWorkItem,
  GarrsWorkItemId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as Decider from "./GarrsDecider.ts";
import * as Helpers from "./GarrsHelpers.ts";
import {
  GarrsRejection,
  type ScheduleContext,
  KEX_WAITING_FOR_REVIEW,
  type WorkAggregate,
  applyRunEnded,
  defaultTeamConfig,
  deliveryBlockers,
  planTaskSpec,
  reconcile,
  taskFromSpec,
  taskProjectContext,
  unknownUsage,
  validatePlan,
  validateProjectScope,
  validateLinkedProjects,
  garrsDriverRejection,
} from "./GarrsDomain.ts";
import { selectModel, type CatalogInstance } from "./GarrsModels.ts";

const NOW = "2026-10-31T12:00:00.000Z";
const config = defaultTeamConfig();
const decodeStartWork = Schema.decodeSync(GarrsStartWorkInput);

const selection = (instanceId: string, model: string) =>
  ({ instanceId: ProviderInstanceId.make(instanceId), model }) as ModelSelection;

const catalog: ReadonlyArray<CatalogInstance> = [
  {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    allowed: true,
    available: true,
    unavailableReason: null,
    models: ["model-a", "model-b"],
    defaultModel: "model-a",
  },
  {
    instanceId: "claude-work",
    driver: "claudeAgent",
    displayName: "Claude (work)",
    allowed: true,
    available: true,
    unavailableReason: null,
    models: ["model-c"],
    defaultModel: "model-c",
  },
  {
    instanceId: "claude-personal",
    driver: "claudeAgent",
    displayName: "Claude (personal)",
    allowed: true,
    available: false,
    unavailableReason: "Not signed in.",
    models: ["model-c"],
    defaultModel: "model-c",
  },
  {
    instanceId: "opencode",
    driver: "opencode",
    displayName: "OpenCode",
    allowed: true,
    available: true,
    unavailableReason: null,
    models: ["model-d"],
    defaultModel: "model-d",
  },
];

const spec = (overrides: Partial<GarrsTaskSpec> & Pick<GarrsTaskSpec, "key">): GarrsTaskSpec => ({
  agentId: "botas",
  title: `Task ${overrides.key}`,
  objective: "Do the work.",
  reason: "Owner of the area.",
  inputs: [],
  deliverables: ["Result"],
  acceptanceCriteria: ["Works"],
  dependsOn: [],
  capability: "read",
  ...overrides,
});

const workItem = (overrides: Partial<GarrsWorkItem> = {}): GarrsWorkItem => ({
  id: GarrsWorkItemId.make("w1"),
  projectId: ProjectId.make("p1"),
  garrasThreadId: ThreadId.make("garras:1"),
  title: "Work",
  objective: "Goal",
  intent: "implement",
  access: "write",
  status: "active",
  statusReason: null,
  configRevision: 0,
  bindingRevision: 0,
  revision: 1,
  correctionCycles: 0,
  rules: [],
  workspace: null,
  authorizations: [],
  createdAt: NOW,
  updatedAt: NOW,
  deliveredAt: null,
  acceptedAt: null,
  ...overrides,
});

const aggregateOf = (
  specs: ReadonlyArray<GarrsTaskSpec>,
  overrides: Partial<GarrsWorkItem> = {},
): WorkAggregate => {
  const item = workItem(overrides);
  return {
    workItem: item,
    plans: [
      {
        id: "plan-1" as never,
        workItemId: item.id,
        revision: 1,
        authorAttemptId: null,
        summary: "Plan",
        risks: [],
        tasks: specs,
        status: "active",
        createdAt: NOW,
      },
    ],
    tasks: specs.map((entry, index) =>
      taskFromSpec({
        id: GarrsTaskId.make(`t${index + 1}`),
        workItem: item,
        planRevision: 1,
        spec: entry,
        now: NOW,
      }),
    ),
    attempts: [],
    artifacts: [],
    reviews: [],
    messages: [],
  };
};

/** Ids continue from the aggregate, as the service's `idsFor` does. */
const context = (
  aggregate: WorkAggregate,
  overrides: Partial<ScheduleContext> = {},
): ScheduleContext => {
  let tasks = aggregate.tasks.length;
  let attempts = aggregate.attempts.length;
  return {
    now: NOW,
    limits: config.limits,
    requireReviewForWrites: true,
    runningGlobal: 0,
    runningByInstance: new Map(),
    newTaskId: () => GarrsTaskId.make(`t${++tasks}`),
    newAttemptId: () => GarrsAttemptId.make(`a${++attempts}`),
    select: (task) =>
      selectModel({
        agentId: task.agentId,
        pinned: null,
        projectOverrides: [],
        teamPolicy: [],
        catalog,
        requirements: { readOnly: task.capability === "read" },
      }),
    subjectHash: "subject-1",
    tokensUsed: null,
    holdLaunches: false,
    ...overrides,
  };
};

const step = (aggregate: WorkAggregate, overrides: Partial<ScheduleContext> = {}) =>
  reconcile(aggregate, context(aggregate, overrides));

const taskByKey = (aggregate: WorkAggregate, key: string): GarrsTask =>
  aggregate.tasks.find((task) => task.key === key)!;
const attemptFor = (aggregate: WorkAggregate, key: string): GarrsAttempt =>
  aggregate.attempts.find((attempt) => attempt.taskId === taskByKey(aggregate, key).id)!;

/** Mark an attempt as running in a thread, as launchAttempt does. */
const running = (aggregate: WorkAggregate): WorkAggregate => ({
  ...aggregate,
  attempts: aggregate.attempts.map((attempt) =>
    attempt.status === "launching"
      ? { ...attempt, status: "running", threadId: ThreadId.make(`garrs:${attempt.id}`) }
      : attempt,
  ),
});

const report = (aggregate: WorkAggregate, key: string, diffHash: string | null = null) =>
  Decider.report(aggregate, {
    attemptId: attemptFor(aggregate, key).id,
    report: {
      outcome: "done",
      kind: taskByKey(aggregate, key).capability === "write" ? "code_change" : "diagnosis",
      summary: "Done",
      body: "Details",
      evidence: ["vp test run x.test.ts: passed"],
    },
    artifactId: `artifact-${key}` as never,
    contentHash: `hash-${key}`,
    workspace:
      diffHash === null
        ? null
        : { checkoutPath: "/work", headSha: "base", diffHash, changedFiles: ["a.ts"] },
    now: NOW,
  }).aggregate;

describe("validatePlan", () => {
  const valid = {
    access: "write" as const,
    authorizations: [],
    completedKeys: new Set<string>(),
    projectId: ProjectId.make("project-a"),
  };

  it("requires a task to prepare every as-yet uninitialized write checkout", () => {
    const other = ProjectId.make("project-b");
    const context = {
      ...valid,
      additionalProjectIds: [other],
      requiredCheckoutProjectIds: [valid.projectId, other],
    };
    expect(
      validatePlan([spec({ key: "front", projectId: valid.projectId })], context).join(" "),
    ).toContain("project-b");
    expect(
      validatePlan(
        [
          spec({ key: "front", projectId: valid.projectId }),
          spec({ key: "back", projectId: other, agentId: "botas" }),
        ],
        context,
      ),
    ).toEqual([]);
  });

  it("rejects a task targeting a different project after decoding the submitted plan", () => {
    const input = decodeStartWork({
      title: "Cross-project work",
      objective: "Coordinate UI and API",
      intent: "implement",
      access: "write",
      projectIds: ["project-a", "project-b"],
      plan: { tasks: [spec({ key: "backend", projectId: ProjectId.make("project-b") })] },
    });
    expect(input.projectIds).toEqual(["project-a", "project-b"]);
    expect(
      validateProjectScope(ProjectId.make("project-a"), input.projectIds, [
        ProjectId.make("project-b"),
      ]),
    ).toBeNull();
    expect(validateProjectScope(ProjectId.make("project-a"), input.projectIds, [])).toContain(
      "not associated",
    );
    expect(
      validateProjectScope(ProjectId.make("project-a"), input.projectIds, [
        ProjectId.make("project-b"),
      ]),
    ).toBeNull();
    expect(
      validateProjectScope(ProjectId.make("project-a"), [ProjectId.make("project-a")], []),
    ).toBeNull();
    if (input.plan === "asta") throw new Error("Expected a plan");
    expect(input.plan.tasks[0]?.projectId).toBe("project-b");
    expect(validatePlan(input.plan.tasks, valid).join(" ")).toContain("another project");
    expect(
      validatePlan(input.plan.tasks, {
        ...valid,
        additionalProjectIds: [ProjectId.make("project-b")],
      }),
    ).toEqual([]);
    expect(
      validatePlan([spec({ key: "own", projectId: ProjectId.make("project-a") })], valid),
    ).toEqual([]);
  });

  it("retains the target project on a task instead of silently replacing it", () => {
    const owner = workItem();
    const task = taskFromSpec({
      id: GarrsTaskId.make("cross-task"),
      workItem: owner,
      planRevision: 1,
      now: NOW,
      spec: spec({ key: "api", projectId: ProjectId.make("other-project") }),
    });
    expect(task.projectId).toBe("other-project");
    expect(taskProjectContext(owner, task.projectId)).toBeNull();
    const linked = {
      projectId: task.projectId,
      bindingRevision: 3,
      rules: [],
      workspace: {
        projectId: task.projectId,
        checkoutPath: "/other",
        isolated: false,
        baseSha: "abc",
      },
    };
    expect(taskProjectContext({ ...owner, projectContexts: [linked] }, task.projectId)).toEqual(
      linked,
    );
    const multi = {
      ...aggregateOf([]),
      workItem: { ...owner, access: "read_only" as const, projectContexts: [linked] },
    };
    expect(() =>
      Decider.revise(multi, {
        feedback: "Make changes",
        access: "write",
        newTaskId: () => GarrsTaskId.make("new"),
        now: NOW,
      }),
    ).toThrow("read-only");
  });

  it.each([
    ["an unknown dependency", [spec({ key: "a", dependsOn: ["missing"] })], "unknown task"],
    [
      "a dependency cycle",
      [spec({ key: "a", dependsOn: ["b"] }), spec({ key: "b", dependsOn: ["a"] })],
      "cycle",
    ],
    ["Garras owning a task", [spec({ key: "a", agentId: "garras" })], "coordinates"],
    ["Copito writing", [spec({ key: "a", agentId: "copito", capability: "write" })], "cannot hold"],
    ["Git without authorization", [spec({ key: "a", agentId: "kex", capability: "git" })], "Git"],
    ["duplicate keys", [spec({ key: "a" }), spec({ key: "a" })], "Duplicate"],
  ])("rejects %s", (_name, specs, message) => {
    expect(validatePlan(specs, valid).join(" ")).toContain(message);
  });

  it("refuses writes in read-only work, so a question never becomes a change", () => {
    const errors = validatePlan([spec({ key: "a", capability: "write" })], {
      ...valid,
      access: "read_only",
    });
    expect(errors).toEqual([`Task "a" writes, but this work item is read-only.`]);
  });

  it("refuses an authorized Git task in read-only work", () => {
    const errors = validatePlan([spec({ key: "git", agentId: "kex", capability: "git" })], {
      ...valid,
      access: "read_only",
      authorizations: [{ kind: "git_commit", grantedBy: "user", note: "Commit", grantedAt: NOW }],
    });
    expect(errors.join(" ")).toContain("read-only");
  });

  it("accepts a Git task with authorization but leaves execution to the scheduler", () => {
    const errors = validatePlan([spec({ key: "git", agentId: "kex", capability: "git" })], {
      ...valid,
      authorizations: [{ kind: "git_commit", grantedBy: "user", note: "Commit", grantedAt: NOW }],
    });
    expect(errors).toEqual([]);
  });

  it("accepts a valid plan that depends on completed earlier work", () => {
    expect(
      validatePlan([spec({ key: "b", dependsOn: ["a"] })], {
        ...valid,
        completedKeys: new Set(["a"]),
      }),
    ).toEqual([]);
  });
});

it("approves only the exact proposed commit", () => {
  const initial = aggregateOf([spec({ key: "inspect", agentId: "kex", capability: "read" })]);
  const aggregate = {
    ...initial,
    workItem: {
      ...initial.workItem,
      commitProposal: {
        id: "proposal-new",
        projectId: initial.workItem.projectId,
        checkoutPath: "/checkout",
        branchRef: "refs/heads/feature",
        parentSha: "parent",
        treeSha: "tree",
        reviewSubjectHash: "subject",
        message: "fix: proposed change",
        attemptId: GarrsAttemptId.make("attempt"),
        status: "proposed" as const,
        createdAt: NOW,
        approvedAt: null,
      },
    },
  };
  expect(() =>
    Decider.control(aggregate, { type: "approve_commit", proposalId: "proposal-old" }, NOW),
  ).toThrow();
  const approved = Decider.control(
    aggregate,
    { type: "approve_commit", proposalId: "proposal-new" },
    NOW,
  );
  expect(approved.aggregate.workItem.commitProposal).toMatchObject({
    id: "proposal-new",
    status: "approved",
    approvedAt: NOW,
  });
  expect(approved.effects).toEqual([{ kind: "execute_commit", proposalId: "proposal-new" }]);
});

describe("linked projects", () => {
  it("accepts distinct projects in this environment and rejects invalid associations", () => {
    const owner = ProjectId.make("p1");
    const other = ProjectId.make("p2");
    const available = new Set([owner, other]);
    expect(validateLinkedProjects(owner, [other], available)).toBeNull();
    expect(validateLinkedProjects(owner, [owner], available)).toContain("itself");
    expect(validateLinkedProjects(owner, [other, other], available)).toContain("duplicate");
    expect(validateLinkedProjects(owner, [ProjectId.make("elsewhere")], available)).toContain(
      "environment",
    );
  });
});

describe("selectModel", () => {
  it("requires coordinator reasoning for team tasks and separates automatic bootstrap", () => {
    const input = {
      agentId: "asta" as const,
      pinned: null,
      projectOverrides: [],
      teamPolicy: [],
      catalog,
      requirements: { readOnly: true, coordinatorRequired: true },
    };
    expect(selectModel(input)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Waiting for Garras"),
    });
    const bootstrap = selectModel({ ...input, agentId: "garras", bootstrap: true });
    expect(bootstrap.ok && bootstrap.decision.source).toBe("bootstrap");
    expect(bootstrap.ok && bootstrap.decision.candidates).toHaveLength(5);
    const withAcp = selectModel({
      ...input,
      agentId: "garras",
      bootstrap: true,
      catalog: [
        ...catalog,
        {
          instanceId: "kimi",
          driver: "acpRegistry",
          displayName: "Kimi",
          allowed: true,
          available: true,
          unavailableReason: null,
          models: ["aaa-model"],
          defaultModel: "aaa-model",
        },
      ],
    });
    expect(withAcp.ok && withAcp.decision.requested.instanceId).not.toBe("kimi");
  });

  it("uses only permitted alternatives after an observed usage limit", () => {
    const input = {
      agentId: "asta" as const,
      pinned: {
        selection: selection("codex", "model-a"),
        by: "coordinator" as const,
        reason: "Need a planner with read tools; alternate account if the primary is limited.",
        fallbacks: [selection("claude-work", "model-c")],
      },
      projectOverrides: [],
      teamPolicy: [],
      catalog,
      requirements: { readOnly: true },
      now: NOW,
      failures: [
        {
          selection: selection("codex", "model-a"),
          at: NOW,
          failure: {
            class: "usage_limit" as const,
            message: "Usage limit reached",
            code: null,
            retryable: false,
            resetAt: "2026-11-01T00:00:00.000Z",
          },
        },
      ],
    };
    const result = selectModel(input);
    expect(result.ok && result.decision).toMatchObject({
      requested: { instanceId: "claude-work" },
      fallbackUsed: true,
      reason: expect.stringContaining("Observed usage limit"),
    });
    const sameAccount = selectModel({
      ...input,
      pinned: {
        ...input.pinned,
        fallbacks: [selection("codex", "model-b"), selection("claude-work", "model-c")],
      },
    });
    expect(sameAccount.ok && sameAccount.decision.requested.instanceId).toBe("claude-work");
    const pinned = selectModel({ ...input, pinned: { ...input.pinned, by: "user" } });
    expect(pinned.ok).toBe(false);
    const staleReset = selectModel({
      ...input,
      failures: input.failures.map((entry) => ({
        ...entry,
        failure: { ...entry.failure, resetAt: "2026-10-31T11:59:00.000Z" },
      })),
    });
    expect(staleReset.ok && staleReset.decision.requested.instanceId).toBe("claude-work");
    const knownWindow = selectModel({
      ...input,
      failures: [],
      catalog: catalog.map((entry) =>
        entry.instanceId === "codex"
          ? {
              ...entry,
              usageLimits: {
                checkedAt: "2026-10-31T11:00:00.000Z",
                windows: [
                  {
                    id: "weekly",
                    kind: "weekly" as const,
                    label: "Weekly",
                    usedPercent: 100,
                    resetsAt: "2026-11-01T00:00:00.000Z",
                  },
                ],
              },
            }
          : entry,
      ),
    });
    expect(knownWindow.ok && knownWindow.decision.requested.instanceId).toBe("claude-work");
    const reset = selectModel({ ...input, now: "2026-11-01T01:00:00.000Z" });
    expect(reset.ok && reset.decision.requested.instanceId).toBe("codex");
  });

  it("keeps a coordinator choice inside the user's configured restrictions", () => {
    const result = selectModel({
      agentId: "pixi",
      pinned: { selection: selection("codex", "model-b"), by: "coordinator" },
      projectOverrides: [],
      teamPolicy: [
        {
          agentId: "pixi",
          candidates: [selection("claude-work", "model-c")],
          allowFallback: false,
        },
      ],
      catalog,
      requirements: { readOnly: true },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("policy");

    const preference = {
      agentId: "pixi" as const,
      pinned: {
        selection: selection("codex", "model-b"),
        by: "coordinator" as const,
        reason: "Proposed alternative for this task.",
      },
      projectOverrides: [],
      teamPolicy: [
        {
          agentId: "pixi" as const,
          candidates: [selection("claude-work", "model-c"), selection("codex", "model-b")],
          allowFallback: true,
        },
      ],
      catalog,
      requirements: { readOnly: true },
    };
    expect(selectModel(preference).ok).toBe(false);
    const authorized = selectModel({
      ...preference,
      catalog: catalog.map((entry) =>
        entry.instanceId === "claude-work"
          ? { ...entry, available: false, unavailableReason: "Account unavailable" }
          : entry,
      ),
    });
    expect(authorized.ok && authorized.decision).toMatchObject({
      requested: selection("codex", "model-b"),
      fallbackUsed: true,
      reason: expect.stringContaining("Account unavailable"),
    });
  });

  it("lets a task instruction override a preference but never the project allowlist", () => {
    const input = {
      agentId: "pixi" as const,
      pinned: { selection: selection("codex", "model-b"), by: "user" as const },
      projectOverrides: [],
      teamPolicy: [
        {
          agentId: "pixi" as const,
          candidates: [selection("claude-work", "model-c")],
          allowFallback: false,
        },
      ],
      catalog,
      requirements: { readOnly: true },
    };
    expect(selectModel(input).ok).toBe(true);
    expect(
      selectModel({
        ...input,
        catalog: catalog.map((entry) => ({ ...entry, allowed: entry.instanceId !== "codex" })),
      }).ok,
    ).toBe(false);
  });

  it("rejects a requested model the catalog lacks instead of substituting", () => {
    const result = selectModel({
      agentId: "botas",
      pinned: { selection: selection("codex", "model-z"), by: "coordinator" },
      projectOverrides: [],
      teamPolicy: [],
      catalog,
      requirements: { readOnly: false },
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.reason).toContain("model-z");
  });

  it("keeps two instances of one driver apart and reports the unavailable one", () => {
    const result = selectModel({
      agentId: "copito",
      pinned: { selection: selection("claude-personal", "model-c"), by: "user" },
      projectOverrides: [],
      teamPolicy: [],
      catalog,
      requirements: { readOnly: true },
    });
    expect(result.ok ? "" : result.reason).toContain("Not signed in");
  });

  it("falls back only when policy allows it, and records the fallback", () => {
    const policy = [
      {
        agentId: "asta" as const,
        candidates: [selection("claude-personal", "model-c"), selection("claude-work", "model-c")],
        allowFallback: true,
      },
    ];
    const allowed = selectModel({
      agentId: "asta",
      pinned: null,
      projectOverrides: [],
      teamPolicy: policy,
      catalog,
      requirements: { readOnly: true },
    });
    expect(allowed.ok && allowed.decision.requested.instanceId).toBe("claude-work");
    expect(allowed.ok && allowed.decision.fallbackUsed).toBe(true);

    const pinned = selectModel({
      agentId: "asta",
      pinned: null,
      projectOverrides: [],
      teamPolicy: [{ ...policy[0]!, allowFallback: false }],
      catalog,
      requirements: { readOnly: true },
    });
    expect(pinned.ok).toBe(false);
  });

  it("never gives read-only work to a provider that cannot enforce it", () => {
    const result = selectModel({
      agentId: "copito",
      pinned: { selection: selection("opencode", "model-d"), by: "user" },
      projectOverrides: [],
      teamPolicy: [],
      catalog,
      requirements: { readOnly: true },
    });
    expect(result.ok ? "" : result.reason).toContain("only Claude and Codex");
  });

  it("restricts every Garrs selection path to Claude and Codex", () => {
    expect(garrsDriverRejection("codex")).toBeNull();
    expect(garrsDriverRejection("claudeAgent")).toBeNull();
    for (const driver of [
      "acpRegistry",
      "antigravity",
      "grok",
      "fx",
      "opencode",
      "cursor",
      "pi",
      "muse",
    ]) {
      expect(garrsDriverRejection(driver)).toContain("only Claude and Codex");
      const requested = selection(driver, "model");
      const input = {
        agentId: "botas" as const,
        projectOverrides: [],
        teamPolicy: [],
        catalog: [
          { ...catalog[0]!, instanceId: driver, driver, models: ["model"], defaultModel: "model" },
        ],
        requirements: { readOnly: true },
      };
      for (const readOnly of [true, false]) {
        const requirements = { readOnly };
        expect(selectModel({ ...input, requirements, pinned: null }).ok).toBe(false);
        for (const by of ["user", "coordinator"] as const) {
          expect(
            selectModel({ ...input, requirements, pinned: { selection: requested, by } }).ok,
          ).toBe(false);
        }
        expect(
          selectModel({
            ...input,
            requirements,
            pinned: null,
            teamPolicy: [{ agentId: "botas", candidates: [requested], allowFallback: true }],
          }).ok,
        ).toBe(false);
      }
    }
  });

  it("allows Claude writers with native isolation and keeps OpenCode blocked", () => {
    const result = selectModel({
      agentId: "pixi",
      pinned: { selection: selection("opencode", "model-d"), by: "user" },
      projectOverrides: [],
      teamPolicy: [],
      catalog,
      requirements: { readOnly: false },
    });
    expect(result.ok).toBe(false);
    const claude = selectModel({
      agentId: "pixi",
      pinned: { selection: selection("claude-work", "model-c"), by: "user" },
      projectOverrides: [],
      teamPolicy: [],
      catalog,
      requirements: { readOnly: false },
    });
    expect(claude.ok && claude.decision.requested.instanceId).toBe("claude-work");
  });

  it("uses a role's own preference rather than the chat's model", () => {
    const result = selectModel({
      agentId: "pixi",
      pinned: null,
      projectOverrides: [],
      teamPolicy: [
        { agentId: "pixi", candidates: [selection("codex", "model-b")], allowFallback: false },
      ],
      catalog,
      requirements: { readOnly: false },
    });
    expect(result.ok && result.decision).toMatchObject({
      source: "team_policy",
      requested: { instanceId: "codex", model: "model-b" },
      effectiveModelSource: "pending",
    });
  });
});

describe("reconcile", () => {
  it.each([
    ["consult", "read_only", "read"],
    ["diagnose", "read_only", "read"],
    ["implement", "write", "write"],
  ] as const)(
    "recognizes Copito's explicit review in %s regardless of its key",
    (intent, access, capability) => {
      const initial = aggregateOf(
        [
          spec({ key: "work", agentId: "botas", capability }),
          spec({ key: "copito-formal-review", agentId: "copito", dependsOn: ["work"] }),
        ],
        { access, intent },
      );
      const started = running(step(initial, { reviewDiagnoses: true }).aggregate);
      const ready = running(
        step(report(started, "work", capability === "write" ? "diff" : null), {
          reviewDiagnoses: true,
        }).aggregate,
      );
      const attempt = attemptFor(ready, "copito-formal-review");
      expect(attempt.reviewSubjectHash).toBe("subject-1");
      expect(() => report(ready, "copito-formal-review")).toThrow("submit_review");
      const reviewed = Decider.submitReview(ready, {
        attemptId: attempt.id,
        review: { verdict: "approved", criteria: [], findings: [] },
        reviewId: GarrsReviewId.make("formal"),
        currentSubjectHash: "subject-1",
        newTaskId: () => GarrsTaskId.make("unused"),
        maxCorrectionCycles: 3,
        now: NOW,
      }).aggregate;
      expect(reviewed.reviews[0]).toMatchObject({ status: "valid", subjectHash: "subject-1" });
      expect(deliveryBlockers(reviewed, true, "subject-1", true)).toEqual([]);
    },
  );
  it("requires a formal review for diagnoses when configured", () => {
    const initial = aggregateOf(
      [spec({ key: "analysis", agentId: "asta" }), spec({ key: "audit", agentId: "pixi" })],
      { access: "read_only", intent: "diagnose" },
    );
    const started = running(step(initial).aggregate);
    const completed = report(report(started, "analysis"), "audit");
    expect(deliveryBlockers(completed, true, "subject-1", true)).toContain(
      "Copito has not approved the current integrated changes.",
    );
    const scheduled = running(step(completed, { reviewDiagnoses: true }).aggregate);
    const review = scheduled.attempts.find((attempt) => attempt.reviewSubjectHash === "subject-1");
    expect(review).toBeDefined();
    expect(scheduled.reviews).toHaveLength(0);
    const approved = Decider.submitReview(scheduled, {
      attemptId: review!.id,
      review: { verdict: "approved", criteria: [], findings: [] },
      reviewId: GarrsReviewId.make("formal-review"),
      currentSubjectHash: "subject-1",
      newTaskId: () => GarrsTaskId.make("unused"),
      maxCorrectionCycles: 3,
      now: NOW,
    }).aggregate;
    expect(deliveryBlockers(approved, true, "subject-1", true)).toEqual([]);
    expect(step(completed, { reviewDiagnoses: false }).aggregate.workItem.status).toBe(
      "ready_to_deliver",
    );
  });
  it("does not launch an existing Git task without enforceable operation restrictions", () => {
    const start = aggregateOf([spec({ key: "git", agentId: "kex", capability: "git" })]);
    const result = step(start);
    expect(result.aggregate.attempts).toHaveLength(0);
    expect(taskByKey(result.aggregate, "git").statusReason).toContain(
      "cannot restrict Git operations",
    );
    expect(result.effects.some((effect) => effect.kind === "launch_attempt")).toBe(false);
  });

  it("reviews completed changes before an authorized but blocked Git task", () => {
    const initial = aggregateOf(
      [
        spec({ key: "edit", agentId: "botas", capability: "write" }),
        spec({ key: "prepare", agentId: "kex", capability: "read", dependsOn: ["edit"] }),
        spec({ key: "commit", agentId: "kex", capability: "git", dependsOn: ["prepare"] }),
      ],
      {
        workspace: {
          projectId: ProjectId.make("p1"),
          checkoutPath: "/isolated",
          isolated: true,
          baseSha: "base",
        },
        authorizations: [{ kind: "git_commit", grantedBy: "user", note: "Commit", grantedAt: NOW }],
      },
    );
    const started = running(step(initial).aggregate);
    const afterEdit = step(report(started, "edit", "diff"), { requireReviewForWrites: false });
    expect(afterEdit.aggregate.attempts.some((attempt) => attempt.agentId === "kex")).toBe(false);
    expect(afterEdit.effects.some((effect) => effect.kind === "prepare_commit")).toBe(true);
    expect(afterEdit.aggregate.attempts.some((attempt) => attempt.agentId === "copito")).toBe(
      false,
    );
    const prepared = {
      ...afterEdit.aggregate,
      workItem: {
        ...afterEdit.aggregate.workItem,
        commitPreparation: {
          taskId: taskByKey(afterEdit.aggregate, "prepare").id,
          status: "prepared" as const,
          subjectHash: "subject-1",
          reason: null,
        },
      },
    };
    const reviewing = running(step(prepared).aggregate);
    const review = reviewing.attempts.find((attempt) => attempt.agentId === "copito")!;
    expect(review).toBeDefined();
    const approved = Decider.submitReview(reviewing, {
      attemptId: review.id,
      review: {
        verdict: "approved",
        criteria: [{ criterion: "Works", status: "verified", evidence: "Checked" }],
        findings: [],
      },
      reviewId: GarrsReviewId.make("review-approved"),
      currentSubjectHash: "subject-1",
      newTaskId: () => GarrsTaskId.make("unused"),
      maxCorrectionCycles: 3,
      now: NOW,
    }).aggregate;
    const afterApproval = running(step(approved).aggregate);
    const preparation = afterApproval.attempts.find((attempt) => attempt.agentId === "kex")!;
    expect(preparation.readOnlyEnforced).toBe(true);
    const afterPreparation = step(report(afterApproval, "prepare"));
    expect(taskByKey(afterPreparation.aggregate, "commit").statusReason).toContain(
      "cannot restrict Git operations",
    );
  });

  it("runs read-only Kex after review and requires a new review after its result", () => {
    const initial = aggregateOf(
      [
        spec({ key: "edit", agentId: "botas", capability: "write" }),
        spec({ key: "audit", agentId: "copito", capability: "read", dependsOn: ["edit"] }),
        spec({ key: "prepare", agentId: "kex", capability: "read", dependsOn: ["audit"] }),
      ],
      {
        workspace: {
          projectId: ProjectId.make("p1"),
          checkoutPath: "/isolated",
          isolated: true,
          baseSha: "base",
        },
      },
    );
    const writer = running(step(initial).aggregate);
    const staged = step(report(writer, "edit", "diff")).aggregate;
    expect(staged.workItem.commitPreparation?.status).toBe("pending");
    expect(staged.attempts.some((attempt) => attempt.agentId === "copito")).toBe(false);
    const reviewing = running(
      step({
        ...staged,
        workItem: {
          ...staged.workItem,
          commitPreparation: {
            taskId: taskByKey(staged, "prepare").id,
            status: "prepared",
            subjectHash: "subject-1",
            reason: null,
          },
        },
      }).aggregate,
    );
    const review = reviewing.attempts.find((attempt) => attempt.agentId === "copito")!;
    const approved = Decider.submitReview(reviewing, {
      attemptId: review.id,
      review: {
        verdict: "approved",
        criteria: [{ criterion: "Works", status: "verified", evidence: "Checked" }],
        findings: [],
      },
      reviewId: GarrsReviewId.make("review-approved-new-plan"),
      currentSubjectHash: "subject-1",
      newTaskId: () => GarrsTaskId.make("unused"),
      maxCorrectionCycles: 3,
      now: NOW,
    }).aggregate;
    const preparing = running(step(approved).aggregate);
    expect(taskByKey(preparing, "prepare").status).toBe("running");
    const waiting = {
      ...preparing,
      tasks: preparing.tasks.map((task) =>
        task.key === "prepare"
          ? { ...task, status: "waiting_response" as const, statusReason: KEX_WAITING_FOR_REVIEW }
          : task,
      ),
    };
    const reverted = step(waiting);
    expect(taskByKey(reverted.aggregate, "prepare").status).toBe("running");
    expect(reverted.effects.some((effect) => effect.kind === "resume_attempt")).toBe(true);
    const rereviewing = running(step(waiting, { subjectHash: "staged-new-file" }).aggregate);
    const secondReview = rereviewing.attempts
      .filter((attempt) => attempt.agentId === "copito")
      .at(-1)!;
    const reviewInput = {
      attemptId: secondReview.id,
      review: {
        verdict: "approved" as const,
        criteria: [{ criterion: "Works", status: "verified" as const, evidence: "Checked" }],
        findings: [],
      },
      reviewId: GarrsReviewId.make("staged-review"),
      currentSubjectHash: "staged-new-file",
      newTaskId: () => GarrsTaskId.make("unused"),
      maxCorrectionCycles: 3,
      now: NOW,
    };
    const invalidatedAgain = Decider.submitReview(rereviewing, {
      ...reviewInput,
      currentSubjectHash: "changed-again",
    });
    expect(invalidatedAgain.effects.some((effect) => effect.kind === "resume_attempt")).toBe(false);
    expect(taskByKey(invalidatedAgain.aggregate, "prepare").status).toBe("waiting_response");
    const resumed = Decider.submitReview(rereviewing, reviewInput);
    expect(taskByKey(resumed.aggregate, "prepare").status).toBe("running");
    expect(
      resumed.effects.some(
        (effect) =>
          effect.kind === "resume_attempt" &&
          effect.attemptId === attemptFor(preparing, "prepare").id,
      ),
    ).toBe(true);
    const stopped = {
      ...rereviewing,
      attempts: rereviewing.attempts.map((entry) =>
        entry.id === attemptFor(preparing, "prepare").id
          ? { ...entry, status: "cancel_requested" as const }
          : entry,
      ),
    };
    expect(
      Decider.submitReview(stopped, reviewInput).effects.some(
        (effect) => effect.kind === "resume_attempt",
      ),
    ).toBe(false);
    const afterCommit = step(report(preparing, "prepare"), { subjectHash: "subject-after-commit" });
    expect(taskByKey(afterCommit.aggregate, "prepare").status).toBe("completed");
    expect(afterCommit.aggregate.reviews[0]?.status).toBe("invalidated");
    expect(
      afterCommit.aggregate.attempts.filter((attempt) => attempt.agentId === "copito"),
    ).toHaveLength(2);
  });

  it("blocks a task on its dependency and releases it when the dependency completes", () => {
    const start = aggregateOf([
      spec({ key: "api", agentId: "botas", capability: "write" }),
      spec({ key: "ui", agentId: "pixi", capability: "write", dependsOn: ["api"] }),
    ]);
    const first = step(start).aggregate;
    expect(taskByKey(first, "api").status).toBe("running");
    expect(taskByKey(first, "ui").status).toBe("waiting_dependency");

    const done = report(running(first), "api", "diff-1");
    const second = step(done).aggregate;
    expect(taskByKey(second, "ui").status).toBe("running");
  });

  it("runs one writer at a time in a work item while readers run in parallel", () => {
    const start = aggregateOf([
      spec({ key: "w1", capability: "write" }),
      spec({ key: "w2", agentId: "pixi", capability: "write" }),
      spec({ key: "r1", agentId: "asta" }),
    ]);
    const next = step(start).aggregate;
    expect(next.tasks.map((task) => [task.key, task.status])).toEqual([
      ["w1", "running"],
      ["w2", "ready"],
      ["r1", "running"],
    ]);
  });

  it("serializes writers per checkout while allowing independent projects to run", () => {
    const other = ProjectId.make("p2");
    const start = aggregateOf(
      [
        spec({ key: "front", agentId: "pixi", capability: "write" }),
        spec({ key: "back", agentId: "botas", capability: "write", projectId: other }),
        spec({ key: "front-again", agentId: "pixi", capability: "write" }),
      ],
      {
        workspace: {
          projectId: ProjectId.make("p1"),
          checkoutPath: "/front",
          isolated: true,
          baseSha: "a",
        },
        projectContexts: [
          {
            projectId: other,
            bindingRevision: 0,
            rules: [],
            workspace: { projectId: other, checkoutPath: "/back", isolated: true, baseSha: "b" },
          },
        ],
      },
    );
    expect(step(start).aggregate.tasks.map((task) => task.status)).toEqual([
      "running",
      "running",
      "ready",
    ]);
    const unprepared = aggregateOf(
      [
        spec({ key: "front-prepare", agentId: "asta", capability: "read" }),
        spec({ key: "front-change", agentId: "pixi", capability: "write" }),
        spec({ key: "back-prepare", agentId: "botas", capability: "read", projectId: other }),
        spec({ key: "back-change", agentId: "botas", capability: "write", projectId: other }),
      ],
      {
        ...start.workItem,
        workspace: { ...start.workItem.workspace!, checkoutPath: null },
        projectContexts: start.workItem.projectContexts!.map((project) => ({
          ...project,
          workspace: { ...project.workspace, checkoutPath: null },
        })),
      },
    );
    const preparing = step(unprepared).aggregate;
    expect(preparing.tasks.map((task) => task.status)).toEqual([
      "running",
      "ready",
      "running",
      "ready",
    ]);
    expect(step(running(preparing)).aggregate.attempts).toHaveLength(2);
  });

  it("respects global and per-provider concurrency limits", () => {
    const start = aggregateOf([spec({ key: "a" }), spec({ key: "b" })]);
    const next = step(start, { runningGlobal: config.limits.maxConcurrentAttempts - 1 }).aggregate;
    expect(next.attempts).toHaveLength(1);
  });

  it("starts nothing while paused", () => {
    const next = step(aggregateOf([spec({ key: "a" })], { status: "paused" }));
    expect(next.effects).toEqual([]);
    expect(next.aggregate.workItem.status).toBe("paused");
  });

  it("is idempotent: a second pass launches nothing new", () => {
    const once = step(aggregateOf([spec({ key: "a" })]));
    const twice = step(once.aggregate);
    expect(twice.effects).toEqual([]);
    expect(twice.aggregate.attempts).toHaveLength(1);
  });

  it("schedules Copito's review after writes and binds delivery to the reviewed diff", () => {
    const launched = running(
      step(aggregateOf([spec({ key: "api", capability: "write" })])).aggregate,
    );
    const reported = report(launched, "api", "diff-1");
    const settling = step(reported, { holdLaunches: true, subjectHash: null });
    expect(settling.aggregate.workItem.status).toBe("active");
    expect(settling.aggregate.tasks.some((task) => task.agentId === "copito")).toBe(false);
    expect(settling.effects).toEqual([]);
    const written = step(settling.aggregate).aggregate;
    const review = written.tasks.find((task) => task.agentId === "copito")!;
    expect(review.status).toBe("running");
    expect(deliveryBlockers(written, true, "subject-1")).toContain(
      "Copito has not approved the current integrated changes.",
    );

    const reviewing = running(written);
    const approved = Decider.submitReview(reviewing, {
      attemptId: reviewing.attempts.find((attempt) => attempt.taskId === review.id)!.id,
      review: {
        verdict: "approved",
        criteria: [{ criterion: "Works", status: "verified", evidence: "test passed" }],
        findings: [],
      },
      reviewId: GarrsReviewId.make("r1"),
      currentSubjectHash: "subject-1",
      newTaskId: () => GarrsTaskId.make("unused"),
      maxCorrectionCycles: 3,
      now: NOW,
    }).aggregate;
    expect(deliveryBlockers(approved, true, "subject-1")).toEqual([]);

    // Files or rules changed after the review: the approval no longer covers them.
    const changed = step(approved, { subjectHash: "subject-2" }).aggregate;
    expect(changed.reviews[0]).toMatchObject({ status: "invalidated" });
    expect(deliveryBlockers(changed, true, "subject-2")).toContain(
      "Copito has not approved the current integrated changes.",
    );
    expect(changed.tasks.filter((task) => task.agentId === "copito")).toHaveLength(2);
  });

  it("returns a blocked review to model selection without creating code corrections", () => {
    for (const { pinnedBy, paused } of [
      { pinnedBy: "coordinator", paused: false },
      { pinnedBy: "user", paused: false },
      { pinnedBy: "coordinator", paused: true },
    ] as const) {
      const written = running(
        step(
          report(
            running(step(aggregateOf([spec({ key: "api", capability: "write" })])).aggregate),
            "api",
            "diff",
          ),
        ).aggregate,
      );
      const review = written.tasks.find((task) => task.agentId === "copito")!;
      const requested = selection("claude-work", "model-c");
      const result = Decider.submitReview(
        {
          ...written,
          workItem: paused ? { ...written.workItem, status: "paused" } : written.workItem,
          tasks: written.tasks.map((task) =>
            task.id === review.id
              ? { ...task, pinnedSelection: requested, pinnedBy, selectionReason: "Review" }
              : task,
          ),
        },
        {
          attemptId: written.attempts.find((attempt) => attempt.taskId === review.id)!.id,
          review: {
            verdict: "blocked",
            criteria: [
              { criterion: "Runtime tests", status: "unverifiable", evidence: "No shell tool" },
            ],
            findings: [
              {
                description: "Cannot execute the tests with this tool policy",
                impact: "Independent runtime verification is missing",
                location: "Review tools",
                severity: "blocker",
                suggestedOwner: "copito",
                resolutionCondition: "Use a reviewer with sandboxed shell access",
              },
            ],
          },
          reviewId: GarrsReviewId.make("blocked-review"),
          currentSubjectHash: "subject-1",
          newTaskId: () => GarrsTaskId.make("unexpected-correction"),
          maxCorrectionCycles: 3,
          now: NOW,
        },
      );
      expect(result.aggregate.tasks).toHaveLength(written.tasks.length);
      expect(result.aggregate.workItem).toMatchObject({
        status: paused ? "paused" : "blocked",
        correctionCycles: 0,
      });
      expect(taskByKey(result.aggregate, "api").status).toBe("completed");
      expect(result.aggregate.tasks.find((task) => task.id === review.id)).toMatchObject({
        status: "ready",
        pinnedSelection: pinnedBy === "user" ? requested : null,
      });
      expect(result.effects).toContainEqual({
        kind: "notify_garras",
        text: expect.stringContaining(review.id),
      });
    }
  });

  it("sends findings back to their owner only, leaving other completed work alone", () => {
    const launched = running(
      step(
        aggregateOf([
          spec({ key: "api", capability: "write" }),
          spec({ key: "docs", agentId: "asta" }),
        ]),
      ).aggregate,
    );
    const written = running(step(report(report(launched, "api", "diff"), "docs")).aggregate);
    const review = written.tasks.find((task) => task.agentId === "copito")!;
    const result = Decider.submitReview(written, {
      attemptId: written.attempts.find((attempt) => attempt.taskId === review.id)!.id,
      review: {
        verdict: "changes_requested",
        criteria: [{ criterion: "Rule X", status: "failed", evidence: "a.ts:3 breaks rule X" }],
        findings: [
          {
            description: "Breaks rule X",
            impact: "Rule violation",
            location: "a.ts:3",
            severity: "major",
            suggestedOwner: "botas",
            resolutionCondition: "Rule X holds",
          },
        ],
      },
      reviewId: GarrsReviewId.make("r1"),
      currentSubjectHash: "subject-1",
      newTaskId: () => GarrsTaskId.make("fix-task"),
      maxCorrectionCycles: 3,
      now: NOW,
    }).aggregate;
    const fix = result.tasks.find((task) => task.id === "fix-task")!;
    expect(fix).toMatchObject({ agentId: "botas", capability: "write", status: "pending" });
    expect(taskByKey(result, "api").status).toBe("completed");
    expect(taskByKey(result, "docs").status).toBe("completed");
    expect(result.workItem.correctionCycles).toBe(1);
  });

  it("rejects an approval that carries a major finding", () => {
    const written = running(
      step(
        report(
          running(step(aggregateOf([spec({ key: "api", capability: "write" })])).aggregate),
          "api",
          "d",
        ),
      ).aggregate,
    );
    const review = written.tasks.find((task) => task.agentId === "copito")!;
    expect(() =>
      Decider.submitReview(written, {
        attemptId: written.attempts.find((attempt) => attempt.taskId === review.id)!.id,
        review: {
          verdict: "approved",
          criteria: [{ criterion: "Works", status: "verified", evidence: "ok" }],
          findings: [
            {
              description: "x",
              impact: "x",
              location: "x",
              severity: "major",
              suggestedOwner: "botas",
              resolutionCondition: "x",
            },
          ],
        },
        reviewId: GarrsReviewId.make("r1"),
        currentSubjectHash: "subject-1",
        newTaskId: () => GarrsTaskId.make("unused"),
        maxCorrectionCycles: 3,
        now: NOW,
      }),
    ).toThrow(GarrsRejection);
  });

  it("routes review corrections to each finding's verified project", () => {
    const other = ProjectId.make("p2");
    const start = aggregateOf(
      [
        spec({ key: "front", capability: "write" }),
        spec({ key: "back", capability: "write", projectId: other }),
      ],
      {
        projectContexts: [
          {
            projectId: other,
            bindingRevision: 0,
            rules: [],
            workspace: { projectId: other, checkoutPath: "/back", isolated: true, baseSha: "base" },
          },
        ],
      },
    );
    const written = report(report(running(step(start).aggregate), "front", "d"), "back", "d");
    const reviewing = running(step(written).aggregate);
    const attempt = reviewing.attempts.find((entry) => entry.agentId === "copito")!;
    const finding = {
      description: "Handle missing input",
      impact: "Throws",
      location: "service.ts:1",
      severity: "major" as const,
      suggestedOwner: "botas" as const,
      resolutionCondition: "Returns a typed error",
    };
    const submit = (findings: ReadonlyArray<typeof finding & { readonly projectId?: ProjectId }>) =>
      Decider.submitReview(reviewing, {
        attemptId: attempt.id,
        review: {
          verdict: "changes_requested",
          criteria: [{ criterion: "Works", status: "failed", evidence: "Throws" }],
          findings,
        },
        reviewId: GarrsReviewId.make("multi-review"),
        currentSubjectHash: "subject-1",
        newTaskId: (() => {
          let number = 0;
          return () => GarrsTaskId.make(`correction-${++number}`);
        })(),
        maxCorrectionCycles: 3,
        now: NOW,
      });
    expect(() => submit([finding])).toThrow("projectId");
    expect(() => submit([{ ...finding, projectId: ProjectId.make("outside") }])).toThrow("project");
    const corrected = submit([
      { ...finding, projectId: start.workItem.projectId },
      { ...finding, projectId: other },
    ]).aggregate;
    expect(
      corrected.tasks
        .filter((task) => task.key.startsWith("fix-"))
        .map((task) => [task.agentId, task.projectId]),
    ).toEqual([
      ["botas", start.workItem.projectId],
      ["botas", other],
    ]);
  });

  const copitoReview = (
    aggregate: WorkAggregate,
    currentSubjectHash: string | null,
    verdict: "approved" | "changes_requested",
  ) => {
    const review = aggregate.tasks.find(
      (task) => task.agentId === "copito" && task.status === "running",
    )!;
    return Decider.submitReview(aggregate, {
      attemptId: aggregate.attempts.find((attempt) => attempt.taskId === review.id)!.id,
      review:
        verdict === "approved"
          ? {
              verdict,
              criteria: [{ criterion: "Works", status: "verified", evidence: "test passed" }],
              findings: [],
            }
          : {
              verdict,
              criteria: [{ criterion: "Works", status: "failed", evidence: "a.ts:3" }],
              findings: [
                {
                  description: "Broken",
                  impact: "Fails",
                  location: "a.ts:3",
                  severity: "major",
                  suggestedOwner: "botas",
                  resolutionCondition: "Works",
                },
              ],
            },
      reviewId: GarrsReviewId.make(`r-${aggregate.reviews.length + 1}`),
      currentSubjectHash,
      newTaskId: () => GarrsTaskId.make("fix-task"),
      maxCorrectionCycles: 3,
      now: NOW,
    });
  };

  it("binds Copito's review to the subject it was launched with, not the state at submission", () => {
    const launched = running(
      step(aggregateOf([spec({ key: "api", capability: "write" })])).aggregate,
    );
    const reviewing = running(step(report(launched, "api", "diff-1")).aggregate);
    const reviewAttempt = reviewing.attempts.find((attempt) => attempt.agentId === "copito")!;
    expect(reviewAttempt.reviewSubjectHash).toBe("subject-1");

    // Files changed while Copito reviewed: the approval is kept for reference but never counts.
    const drifted = copitoReview(reviewing, "subject-2", "approved");
    expect(drifted.aggregate.reviews[0]).toMatchObject({
      subjectHash: "subject-1",
      status: "invalidated",
      invalidatedReason: "Files or rules changed while Copito was reviewing.",
    });
    expect(deliveryBlockers(drifted.aggregate, true, "subject-2")).toContain(
      "Copito has not approved the current integrated changes.",
    );
    expect(deliveryBlockers(drifted.aggregate, true, "subject-1")).toContain(
      "Copito has not approved the current integrated changes.",
    );

    // A fresh review is scheduled and bound to the current subject.
    const rescheduled = step(drifted.aggregate, { subjectHash: "subject-2" }).aggregate;
    const fresh = rescheduled.attempts.filter((attempt) => attempt.agentId === "copito");
    expect(fresh.map((attempt) => attempt.reviewSubjectHash)).toEqual(["subject-1", "subject-2"]);

    const approved = copitoReview(running(rescheduled), "subject-2", "approved").aggregate;
    expect(deliveryBlockers(approved, true, "subject-2")).toEqual([]);
  });

  it("does not open correction tasks from findings about a state that changed during review", () => {
    const launched = running(
      step(aggregateOf([spec({ key: "api", capability: "write" })])).aggregate,
    );
    const reviewing = running(step(report(launched, "api", "diff-1")).aggregate);
    const drifted = copitoReview(reviewing, "subject-2", "changes_requested").aggregate;
    expect(drifted.tasks.some((task) => task.id === "fix-task")).toBe(false);
    expect(drifted.workItem.correctionCycles).toBe(0);
    expect(drifted.reviews[0]!.status).toBe("invalidated");
  });

  it("requires a fresh diagnosis review when rules change or become unavailable", () => {
    const initial = aggregateOf(
      [
        spec({ key: "diagnose" }),
        spec({ key: "review-diagnosis", agentId: "copito", dependsOn: ["diagnose"] }),
      ],
      { access: "read_only" },
    );
    const launched = running(step(initial).aggregate);
    const reviewing = running(
      step(report(launched, "diagnose"), { subjectHash: "rules-1" }).aggregate,
    );
    const drifted = copitoReview(reviewing, null, "changes_requested").aggregate;
    expect(drifted.reviews[0]!.status).toBe("invalidated");
    expect(drifted.workItem.correctionCycles).toBe(0);
    expect(drifted.tasks.some((task) => task.id === "fix-task")).toBe(false);
    expect(deliveryBlockers(drifted, true, null)).not.toEqual([]);
    const fresh = step(drifted, { subjectHash: "rules-2" }).aggregate;
    expect(
      fresh.attempts
        .filter((attempt) => attempt.agentId === "copito")
        .map((attempt) => attempt.reviewSubjectHash),
    ).toEqual(["rules-1", "rules-2"]);
    const approved = copitoReview(running(fresh), "rules-2", "approved").aggregate;
    expect(deliveryBlockers(approved, true, "rules-2")).toEqual([]);
    expect(deliveryBlockers(approved, true, "rules-3")).not.toEqual([]);
    const stale = step(approved, { subjectHash: "rules-3" }).aggregate;
    expect(stale.reviews.at(-1)!.status).toBe("invalidated");
  });

  it("does not count a review whose subject could not be read at launch", () => {
    const launched = running(
      step(aggregateOf([spec({ key: "api", capability: "write" })])).aggregate,
    );
    const reported = report(launched, "api", "diff-1");
    // Unreadable workspace: no review is scheduled until the subject can be read.
    expect(
      step(reported, { subjectHash: null }).aggregate.tasks.some(
        (task) => task.agentId === "copito",
      ),
    ).toBe(false);
    const reviewing = running(step(reported).aggregate);
    const unbound = {
      ...reviewing,
      attempts: reviewing.attempts.map((attempt) =>
        attempt.agentId === "copito" ? { ...attempt, reviewSubjectHash: null } : attempt,
      ),
    };
    expect(copitoReview(unbound, "subject-1", "approved").aggregate.reviews[0]!.status).toBe(
      "invalidated",
    );
  });
});

describe("temporary helpers", () => {
  it.each(["asta", "copito"] as const)(
    "allows %s a read-only helper without giving it planning or review authority",
    (agentId) => {
      const parent = running(
        step(aggregateOf([spec({ key: "investigate", agentId })], { access: "read_only" }))
          .aggregate,
      );
      const requested = Helpers.request(parent, {
        attemptId: parent.attempts[0]!.id,
        taskId: GarrsTaskId.make("helper-1"),
        objective: "Inspect the independent trace",
        reason: "A second analysis path needs verification",
        deadline: "2026-10-31T12:10:00.000Z",
        now: NOW,
      }).aggregate;
      const launched = running(step(requested).aggregate);
      const helper = launched.tasks.find((task) => task.helper !== undefined)!;
      const attempt = launched.attempts.find((entry) => entry.taskId === helper.id)!;
      expect(helper.capability).toBe("read");
      expect(attempt.readOnlyEnforced).toBe(true);
      const forged = {
        ...launched,
        tasks: launched.tasks.map((task) =>
          task.id === helper.id ? { ...task, key: "plan-forged" } : task,
        ),
        attempts: launched.attempts.map((entry) =>
          entry.id === attempt.id ? { ...entry, reviewSubjectHash: "subject-1" } : entry,
        ),
      };
      expect(() =>
        Decider.submitPlan(forged, {
          attemptId: attempt.id,
          plan: { summary: "Plan", risks: [], tasks: [] },
          planId: GarrsPlanRevisionId.make("forged"),
          newTaskId: () => GarrsTaskId.make("new"),
          autonomy: "auto",
          now: NOW,
        }),
      ).toThrow(GarrsRejection);
      expect(() =>
        Decider.submitReview(forged, {
          attemptId: attempt.id,
          review: { verdict: "approved", criteria: [], findings: [] },
          reviewId: GarrsReviewId.make("forged"),
          currentSubjectHash: "subject-1",
          newTaskId: () => GarrsTaskId.make("new"),
          maxCorrectionCycles: 2,
          now: NOW,
        }),
      ).toThrow(GarrsRejection);
      expect(report(launched, helper.key).tasks.find((task) => task.id === helper.id)?.status).toBe(
        "completed",
      );
    },
  );
  it("links a bounded read-only helper to its requester and blocks recursion", () => {
    const parent = running(
      step(aggregateOf([spec({ key: "api", agentId: "botas", capability: "write" })])).aggregate,
    );
    const requested = Helpers.request(parent, {
      attemptId: parent.attempts[0]!.id,
      taskId: GarrsTaskId.make("helper-1"),
      objective: "Check the error handling",
      reason: "The failure has an independent cause to investigate",
      deadline: "2026-10-31T12:10:00.000Z",
      now: NOW,
    }).aggregate;
    const helper = requested.tasks.find((task) => task.id === "helper-1")!;
    expect(helper).toMatchObject({
      capability: "read",
      agentId: "botas",
      projectId: parent.tasks[0]!.projectId,
      helper: { parentAttemptId: parent.attempts[0]!.id, parentTaskId: parent.tasks[0]!.id },
    });
    expect(requested.tasks[0]!.status).toBe("waiting_response");
    expect(() =>
      Helpers.request(requested, {
        attemptId: parent.attempts[0]!.id,
        taskId: GarrsTaskId.make("another"),
        objective: "x",
        reason: "y",
        deadline: NOW,
        now: NOW,
      }),
    ).toThrow(GarrsRejection);
    const launched = running(step(requested).aggregate);
    const helperAttempt = launched.attempts.find((attempt) => attempt.taskId === helper.id)!;
    expect(helperAttempt.readOnlyEnforced).toBe(true);
    const message = Decider.sendMessage(launched, {
      from: "pixi",
      fromTaskId: null,
      message: { to: "botas", kind: "note", body: "For the owner" },
      messageId: GarrsMessageId.make("owner-message"),
      maxMessagesPerTask: 20,
      now: NOW,
    });
    expect(message.effects).not.toContainEqual({
      kind: "deliver_message",
      messageId: GarrsMessageId.make("owner-message"),
      attemptId: helperAttempt.id,
    });
    expect(Decider.pendingMessageEffects(message.aggregate, helperAttempt.id)).toEqual([]);
    expect(() =>
      Helpers.request(launched, {
        attemptId: helperAttempt.id,
        taskId: GarrsTaskId.make("recursive"),
        objective: "x",
        reason: "y",
        deadline: NOW,
        now: NOW,
      }),
    ).toThrow(GarrsRejection);
    const reported = report(launched, helper.key);
    const ready = Helpers.deliveries(reported);
    expect(ready).toEqual([{ kind: "deliver_helper_result", taskId: helper.id }]);
    const acknowledged = Helpers.acknowledge(reported, helper.id, NOW).aggregate;
    expect(acknowledged.tasks.find((task) => task.id === parent.tasks[0]!.id)!.status).toBe(
      "running",
    );
    expect(Helpers.deliveries(acknowledged)).toEqual([]);
    const second = Helpers.request(acknowledged, {
      attemptId: parent.attempts[0]!.id,
      taskId: GarrsTaskId.make("helper-2"),
      objective: "Check the independent trace",
      reason: "A separate call path needs inspection",
      deadline: "2026-10-31T12:10:00.000Z",
      now: NOW,
    }).aggregate;
    expect(Helpers.deliveries(second)).toEqual([]);
  });

  it("expires queued or running helpers and notifies the requester without consuming review cycles", () => {
    const parent = running(
      step(aggregateOf([spec({ key: "api", agentId: "botas", capability: "write" })])).aggregate,
    );
    const requested = Helpers.request(parent, {
      attemptId: parent.attempts[0]!.id,
      taskId: GarrsTaskId.make("helper-1"),
      objective: "Examine timeout handling",
      reason: "Independent check of the timeout path",
      deadline: "2026-10-31T12:10:00.000Z",
      now: NOW,
    }).aggregate;
    const limited = step(requested, {
      limits: { ...config.limits, maxConcurrentAttemptsPerWorkItem: 1 },
    }).aggregate;
    expect(limited.attempts).toHaveLength(1);
    const launched = running(step(requested).aggregate);
    const expired = Helpers.expire(launched, "2026-10-31T12:10:00.000Z");
    expect(expired.aggregate.tasks.find((task) => task.helper !== undefined)?.status).toBe(
      "failed",
    );
    expect(expired.effects).toEqual([
      { kind: "stop_attempt", attemptId: launched.attempts[1]!.id },
    ]);
    expect(Helpers.deliveries(expired.aggregate)).toEqual([
      { kind: "deliver_helper_result", taskId: GarrsTaskId.make("helper-1") },
    ]);
    expect(expired.aggregate.workItem.correctionCycles).toBe(0);
    expect(() =>
      Decider.control(
        expired.aggregate,
        { type: "retry_task", taskId: GarrsTaskId.make("helper-1") },
        NOW,
      ),
    ).toThrow(GarrsRejection);
  });
});

describe("attempt outcomes", () => {
  const launched = () =>
    running(step(aggregateOf([spec({ key: "a" })], { access: "read_only" })).aggregate);

  it("records the provider end after an attempt has already reported its result", () => {
    const reported = report(launched(), "a");
    const attempt = reported.attempts[0]!;
    expect(attempt.endedAt).toBeNull();
    const ended = applyRunEnded(reported, {
      attemptId: attempt.id,
      runStatus: "completed",
      now: NOW,
      remindersSent: 0,
      usage: unknownUsage(),
      effectiveModel: null,
    });
    expect(ended.aggregate.attempts[0]!.status).toBe("succeeded");
    expect(ended.aggregate.attempts[0]!.endedAt).toBe(NOW);
    expect(ended.aggregate.tasks[0]!.status).toBe("completed");
    expect(ended.effects).toEqual([]);
  });

  it("ignores a late run end from a cancelled attempt", () => {
    const cancelled = Decider.control(launched(), { type: "cancel" }, NOW).aggregate;
    const attempt = cancelled.attempts[0]!;
    const late = applyRunEnded(cancelled, {
      attemptId: attempt.id,
      runStatus: "completed",
      now: NOW,
      remindersSent: 1,
      usage: unknownUsage(),
      effectiveModel: null,
    });
    expect(late.aggregate.tasks[0]!.status).toBe("cancelled");
    expect(late.aggregate.attempts[0]!.status).toBe("cancelled");
    expect(late.effects).toEqual([]);
  });

  it.each(["running", "waiting_response"] as const)(
    "allows retry after stopping a %s task",
    (status) => {
      const initial = launched();
      const start = { ...initial, tasks: initial.tasks.map((task) => ({ ...task, status })) };
      const attemptId = start.attempts[0]!.id;
      const stopped = Decider.control(start, { type: "stop_attempt", attemptId }, NOW).aggregate;
      const ended = applyRunEnded(stopped, {
        attemptId,
        runStatus: "interrupted",
        now: NOW,
        remindersSent: 0,
        usage: unknownUsage(),
        effectiveModel: null,
      }).aggregate;
      expect(ended.attempts[0]!.status).toBe("cancelled");
      expect(ended.tasks[0]!.status).toBe("failed");
      expect(
        Decider.control(ended, { type: "retry_task", taskId: ended.tasks[0]!.id }, NOW).aggregate
          .tasks[0]!.status,
      ).toBe("pending");
    },
  );

  it("refuses a report from a superseded attempt", () => {
    const start = launched();
    const failed = applyRunEnded(start, {
      attemptId: start.attempts[0]!.id,
      runStatus: "failed",
      now: NOW,
      remindersSent: 0,
      usage: unknownUsage(),
      effectiveModel: null,
      failureMessage: "Garrs cannot start while an external MCP server is available to the thread.",
    }).aggregate;
    expect(failed.attempts[0]!.error).toContain("external MCP server");
    expect(failed.tasks[0]!.statusReason).toContain("external MCP server");
    const untrusted = applyRunEnded(start, {
      attemptId: start.attempts[0]!.id,
      runStatus: "failed",
      now: NOW,
      remindersSent: 0,
      usage: unknownUsage(),
      effectiveModel: null,
      failureMessage: "provider token: secret at /private/path",
    });
    expect(JSON.stringify(untrusted)).not.toContain("secret");
    expect(JSON.stringify(untrusted)).not.toContain("/private/path");
    expect(() => report(failed, "a")).toThrow(GarrsRejection);
  });

  it("reminds once when a run ends without a report, then fails and retries", () => {
    const start = launched();
    const attemptId = start.attempts[0]!.id;
    const reminded = applyRunEnded(start, {
      attemptId,
      runStatus: "completed",
      now: NOW,
      remindersSent: 0,
      usage: unknownUsage(),
      effectiveModel: null,
    });
    expect(reminded.effects).toMatchObject([{ kind: "resume_attempt", attemptId }]);
    const second = applyRunEnded(reminded.aggregate, {
      attemptId,
      runStatus: "completed",
      now: NOW,
      remindersSent: 1,
      usage: unknownUsage(),
      effectiveModel: null,
    });
    expect(second.aggregate.attempts[0]!.status).toBe("failed");
    expect(second.aggregate.tasks[0]!.status).toBe("ready");
  });

  it("refuses a read-only report that changed files", () => {
    const start = launched();
    expect(() =>
      Decider.report(start, {
        attemptId: start.attempts[0]!.id,
        report: { outcome: "done", kind: "diagnosis", summary: "s", body: "b", evidence: [] },
        artifactId: "x" as never,
        contentHash: "h",
        workspace: { checkoutPath: "/p", headSha: null, diffHash: "d", changedFiles: ["a.ts"] },
        now: NOW,
      }),
    ).toThrow("read-only task changed files");
  });

  it("preserves pre-existing project changes while rejecting drift during a read-only task", () => {
    const initial = launched();
    const start = {
      ...initial,
      workItem: {
        ...initial.workItem,
        readOnlyBaseline: { headSha: "commit", diffHash: "initial" },
      },
    };
    const input = {
      attemptId: start.attempts[0]!.id,
      report: {
        outcome: "done" as const,
        kind: "diagnosis" as const,
        summary: "s",
        body: "b",
        evidence: [],
      },
      artifactId: "x" as never,
      contentHash: "h",
      workspace: {
        checkoutPath: "/p",
        headSha: "commit",
        diffHash: "initial",
        changedFiles: ["user-change.ts"],
      },
      now: NOW,
    };
    expect(Decider.report(start, input).aggregate.artifacts).toHaveLength(1);
    expect(() =>
      Decider.report(start, { ...input, workspace: { ...input.workspace, diffHash: "changed" } }),
    ).toThrow("state changed");
    expect(() => Decider.report(start, { ...input, workspace: null })).toThrow(
      "could not be verified",
    );
  });

  it("stops retrying at the attempt limit", () => {
    let aggregate = launched();
    for (let index = 0; index < config.limits.maxAttemptsPerTask; index++) {
      aggregate = applyRunEnded(aggregate, {
        attemptId: aggregate.attempts.at(-1)!.id,
        runStatus: "failed",
        now: NOW,
        remindersSent: 0,
        usage: unknownUsage(),
        effectiveModel: null,
      }).aggregate;
      aggregate = running(step(aggregate).aggregate);
    }
    expect(aggregate.tasks[0]).toMatchObject({
      status: "failed",
      statusReason: "Attempt limit reached.",
    });
    expect(aggregate.attempts).toHaveLength(config.limits.maxAttemptsPerTask);
  });
});

describe("messages and controls", () => {
  it("addresses a task when one member owns several projects and keeps replies on that task", () => {
    const start = running(
      step(
        aggregateOf(
          [
            spec({ key: "ui", agentId: "pixi" }),
            spec({ key: "api-front", agentId: "botas" }),
            spec({ key: "api-back", agentId: "botas", projectId: ProjectId.make("p2") }),
          ],
          { access: "read_only" },
        ),
      ).aggregate,
    );
    const sender = taskByKey(start, "ui");
    const back = taskByKey(start, "api-back");
    const front = taskByKey(start, "api-front");
    const input = {
      from: "pixi" as const,
      fromTaskId: sender.id,
      message: { to: "botas" as const, kind: "question" as const, body: "Which error contract?" },
      messageId: GarrsMessageId.make("scoped-question"),
      maxMessagesPerTask: 20,
      now: NOW,
    };
    expect(() => Decider.sendMessage(start, input)).toThrow("toTaskId");
    const sent = Decider.sendMessage(start, {
      ...input,
      message: { ...input.message, toTaskId: back.id },
    });
    expect(sent.aggregate.messages[0]!.toTaskId).toBe(back.id);
    expect(sent.effects).toEqual([
      {
        kind: "deliver_message",
        messageId: input.messageId,
        attemptId: attemptFor(start, "api-back").id,
      },
    ]);
    expect(
      Decider.pendingMessageEffects(sent.aggregate, attemptFor(start, "api-front").id),
    ).toEqual([]);
    const reply = {
      from: "botas" as const,
      fromTaskId: back.id,
      message: {
        to: "pixi" as const,
        kind: "answer" as const,
        body: "Use typed errors",
        replyTo: input.messageId,
      },
      messageId: GarrsMessageId.make("scoped-answer"),
      maxMessagesPerTask: 20,
      now: NOW,
    };
    expect(() => Decider.sendMessage(sent.aggregate, { ...reply, fromTaskId: front.id })).toThrow(
      "recipient",
    );
    expect(Decider.sendMessage(sent.aggregate, reply).aggregate.messages[1]!.toTaskId).toBe(
      sender.id,
    );
  });

  it("resumes a waiting member only with an answer, and caps messages per task", () => {
    const start = running(
      step(aggregateOf([spec({ key: "ui", agentId: "pixi" })], { access: "read_only" })).aggregate,
    );
    const waiting = Decider.report(start, {
      attemptId: start.attempts[0]!.id,
      report: {
        outcome: "needs_input",
        kind: "answer",
        summary: "Which API?",
        body: "",
        evidence: [],
        question: "Which API shape?",
      },
      artifactId: "x" as never,
      contentHash: "h",
      workspace: null,
      now: NOW,
    }).aggregate;
    const note = Decider.sendMessage(waiting, {
      from: "pixi",
      fromTaskId: null,
      message: { to: "botas", kind: "question", body: "Which API?" },
      messageId: GarrsMessageId.make("m1"),
      maxMessagesPerTask: 2,
      now: NOW,
    });
    expect(note.effects).toEqual([]);
    expect(note.aggregate.messages[0]!.deliveryStatus).toBe("pending");
    expect(() =>
      Decider.sendMessage(note.aggregate, {
        from: "asta",
        fromTaskId: null,
        message: {
          to: "pixi",
          kind: "answer",
          body: "Unrelated",
          replyTo: GarrsMessageId.make("m1"),
        },
        messageId: GarrsMessageId.make("wrong-answer"),
        maxMessagesPerTask: 2,
        now: NOW,
      }),
    ).toThrow("recipient");
    const answer = Decider.sendMessage(note.aggregate, {
      from: "botas",
      fromTaskId: null,
      message: {
        to: "pixi",
        kind: "answer",
        body: "Use {id, name}",
        replyTo: GarrsMessageId.make("m1"),
      },
      messageId: GarrsMessageId.make("m2"),
      maxMessagesPerTask: 2,
      now: NOW,
    });
    expect(answer.aggregate.tasks[0]!.status).toBe("waiting_response");
    expect(answer.aggregate.messages[1]!.deliveryStatus).toBe("pending");
    expect(answer.effects).toMatchObject([{ kind: "deliver_message", messageId: "m2" }]);
    const accepted = Decider.acknowledgeMessage(
      answer.aggregate,
      GarrsMessageId.make("m2"),
      answer.aggregate.attempts[0]!.id,
      NOW,
    );
    expect(accepted.aggregate.tasks[0]!.status).toBe("running");
    expect(accepted.aggregate.messages[1]!.deliveryStatus).toBe("queued");
    expect(
      Decider.acknowledgeMessage(
        accepted.aggregate,
        GarrsMessageId.make("m2"),
        accepted.aggregate.attempts[0]!.id,
        NOW,
      ).activity,
    ).toEqual([]);
    const pendingNote = Decider.sendMessage(waiting, {
      from: "botas",
      fromTaskId: null,
      message: { to: "pixi", kind: "note", body: "The contract is documented" },
      messageId: GarrsMessageId.make("waiting-note"),
      maxMessagesPerTask: 20,
      now: NOW,
    });
    expect(pendingNote.effects).toEqual([]);
    const resume = Decider.sendMessage(pendingNote.aggregate, {
      from: "botas",
      fromTaskId: null,
      message: { to: "pixi", kind: "answer", body: "Use the documented shape" },
      messageId: GarrsMessageId.make("resume-answer"),
      maxMessagesPerTask: 20,
      now: NOW,
    });
    expect(
      Decider.acknowledgeMessage(
        resume.aggregate,
        GarrsMessageId.make("resume-answer"),
        resume.aggregate.attempts[0]!.id,
        NOW,
      ).effects,
    ).toEqual([
      {
        kind: "deliver_message",
        messageId: "waiting-note",
        attemptId: resume.aggregate.attempts[0]!.id,
      },
    ]);

    const taskId = answer.aggregate.tasks[0]!.id;
    const capped = {
      ...answer.aggregate,
      messages: answer.aggregate.messages.map((m) => ({ ...m, taskId })),
    };
    expect(() =>
      Decider.sendMessage(capped, {
        from: "pixi",
        fromTaskId: taskId,
        message: { to: "botas", kind: "question", body: "again?" },
        messageId: GarrsMessageId.make("m3"),
        maxMessagesPerTask: 2,
        now: NOW,
      }),
    ).toThrow("Message limit");
  });

  it("queues a stored message when its recipient starts", () => {
    const start = aggregateOf([spec({ key: "ui", agentId: "pixi" })], { access: "read_only" });
    const message = Decider.sendMessage(start, {
      from: "botas",
      fromTaskId: null,
      message: { to: "pixi", kind: "question", body: "Which component?" },
      messageId: GarrsMessageId.make("pending-1"),
      maxMessagesPerTask: 2,
      now: NOW,
    });
    expect(message.effects).toEqual([]);
    const started = running(step(message.aggregate).aggregate);
    expect(Decider.pendingMessageEffects(started, started.attempts[0]!.id)).toEqual([
      { kind: "deliver_message", messageId: "pending-1", attemptId: started.attempts[0]!.id },
    ]);
    expect(started.messages[0]!.deliveryStatus).toBe("pending");
    const cancelling = {
      ...started,
      attempts: started.attempts.map((attempt) => ({
        ...attempt,
        status: "cancel_requested" as const,
      })),
    };
    expect(Decider.pendingMessageEffects(cancelling, cancelling.attempts[0]!.id)).toEqual([]);
  });

  it("says plainly that pause leaves running attempts running", () => {
    const start = running(step(aggregateOf([spec({ key: "a" })])).aggregate);
    const paused = Decider.control(start, { type: "pause" }, NOW);
    expect(paused.effect).toContain("1 running attempt(s) continue");
    expect(paused.effects).toEqual([]);
  });

  it("cancel requests stops and only confirms after the run ends", () => {
    const start = running(step(aggregateOf([spec({ key: "a" })])).aggregate);
    const cancelled = Decider.control(start, { type: "cancel" }, NOW);
    expect(cancelled.aggregate.attempts[0]!.status).toBe("cancel_requested");
    expect(cancelled.effects).toMatchObject([{ kind: "stop_attempt" }]);
  });

  it.each([
    ["approve_plan", "read", true],
    ["approve_plan", "write", true],
    ["auto_read", "read", false],
    ["auto_read", "write", true],
    ["auto", "read", false],
    ["auto", "write", false],
  ] as const)("applies autonomy %s to %s plans", (autonomy, capability, awaiting) => {
    const live = running(
      step(
        aggregateOf([planTaskSpec("Goal")], {
          access: capability === "read" ? "read_only" : "write",
        }),
      ).aggregate,
    );
    const decision = Decider.submitPlan(live, {
      attemptId: live.attempts[0]!.id,
      plan: {
        summary: "Plan",
        risks: [],
        tasks: [
          spec({
            key: "task",
            capability,
            selection: selection("codex", "model-b"),
            selectionReason: "Asta's proposal",
            fallbackSelections: [selection("codex", "model-a")],
          }),
        ],
      },
      planId: GarrsPlanRevisionId.make("plan-preference"),
      newTaskId: () => GarrsTaskId.make("planned-task"),
      autonomy,
      now: NOW,
    });
    expect(decision.aggregate.workItem.status).toBe(awaiting ? "awaiting_approval" : "active");
    expect(decision.aggregate.plans.at(-1)?.status).toBe(awaiting ? "awaiting_approval" : "active");
    expect(decision.aggregate.plans.at(-1)?.tasks[0]?.selection).toEqual(
      selection("codex", "model-b"),
    );
    const planned = decision.aggregate.tasks.find((task) => task.id === "planned-task")!;
    expect(planned.pinnedSelection).toBeNull();
    expect(planned.selectionReason).toBeUndefined();
    expect(planned.fallbackSelections).toBeUndefined();
    const scheduled = step(decision.aggregate);
    expect(scheduled.effects.some((effect) => effect.kind === "launch_attempt")).toBe(!awaiting);
  });

  it("replans from completed results without duplicating them or launching superseded work", () => {
    const doneSpec = spec({ key: "contract" });
    const initial = running(
      step(aggregateOf([doneSpec, spec({ key: "backend", dependsOn: ["contract"] })])).aggregate,
    );
    const completed = report(initial, "contract");
    const revised = Decider.revise(completed, {
      feedback: "Continue the remaining implementation",
      access: undefined,
      newTaskId: () => GarrsTaskId.make("replan"),
      now: NOW,
    }).aggregate;
    const planning = running(step(revised).aggregate);
    expect(taskByKey(planning, "backend").status).toBe("cancelled");
    const planner = attemptFor(planning, "plan-r2");
    const decision = Decider.submitPlan(planning, {
      attemptId: planner.id,
      plan: {
        summary: "Continue",
        risks: [],
        tasks: [doneSpec, spec({ key: "backend", dependsOn: ["contract"] })],
      },
      planId: GarrsPlanRevisionId.make("continuation"),
      newTaskId: () => GarrsTaskId.make("continued-backend"),
      autonomy: "auto",
      now: NOW,
    });
    expect(decision.aggregate.tasks.filter((task) => task.key === "contract")).toEqual([
      taskByKey(completed, "contract"),
    ]);
    expect(decision.aggregate.artifacts).toEqual(completed.artifacts);
    const scheduled = step(decision.aggregate);
    expect(scheduled.aggregate.tasks.find((task) => task.id === "continued-backend")?.status).toBe(
      "running",
    );
  });

  it("approves only the exact plan revision the user saw", () => {
    const planned = (aggregate: WorkAggregate, planId: string) => {
      const live = running(step(aggregate).aggregate);
      const planTask = live.tasks.find(
        (task) => task.agentId === "asta" && task.status === "running",
      )!;
      return Decider.submitPlan(live, {
        attemptId: live.attempts.find((attempt) => attempt.taskId === planTask.id)!.id,
        plan: {
          summary: `Plan ${planId}`,
          risks: [],
          tasks: [spec({ key: `api-${planId}`, capability: "write" })],
        },
        planId: GarrsPlanRevisionId.make(planId),
        newTaskId: () => GarrsTaskId.make(`task-${planId}`),
        autonomy: "approve_plan",
        now: NOW,
      }).aggregate;
    };
    const first = planned(aggregateOf([planTaskSpec("Goal")]), "plan-a");
    expect(first.workItem.status).toBe("awaiting_approval");

    // Garras asks Asta to replan before the user answers.
    const revised = Decider.revise(first, {
      feedback: "Smaller scope",
      access: undefined,
      newTaskId: () => GarrsTaskId.make("replan"),
      now: NOW,
    }).aggregate;
    const second = planned(revised, "plan-b");
    expect(second.plans.find((plan) => plan.id === "plan-a")!.status).toBe("superseded");

    expect(() =>
      Decider.control(
        second,
        { type: "approve_plan", planId: GarrsPlanRevisionId.make("plan-a") },
        NOW,
      ),
    ).toThrow("The plan changed: you approved revision 2, but revision 3 awaits approval");
    expect(() =>
      Decider.control(
        second,
        { type: "approve_plan", planId: GarrsPlanRevisionId.make("plan-z") },
        NOW,
      ),
    ).toThrow("an unknown plan");

    const approved = Decider.control(
      second,
      { type: "approve_plan", planId: GarrsPlanRevisionId.make("plan-b") },
      NOW,
    );
    expect(approved.aggregate.plans.find((plan) => plan.id === "plan-b")!.status).toBe("active");
    expect(approved.aggregate.workItem.status).toBe("active");
    // Repeating the stale approval afterwards still approves nothing.
    expect(() =>
      Decider.control(
        approved.aggregate,
        { type: "approve_plan", planId: GarrsPlanRevisionId.make("plan-a") },
        NOW,
      ),
    ).toThrow("No plan awaits approval");
  });

  it("rejects Asta's plan if a task targets another project", () => {
    const live = running(step(aggregateOf([planTaskSpec("Goal")])).aggregate);
    expect(() =>
      Decider.submitPlan(live, {
        attemptId: live.attempts[0]!.id,
        plan: {
          summary: "Frontend and API",
          risks: [],
          tasks: [spec({ key: "api", projectId: ProjectId.make("other-project") })],
        },
        planId: GarrsPlanRevisionId.make("cross-project"),
        newTaskId: () => GarrsTaskId.make("task-cross-project"),
        autonomy: "auto",
        now: NOW,
      }),
    ).toThrow("another project");
  });

  it("refuses delivery while work remains", () => {
    const start = step(aggregateOf([spec({ key: "a" })])).aggregate;
    expect(() =>
      Decider.deliver(start, { blockers: deliveryBlockers(start, true, null), now: NOW }),
    ).toThrow("Not ready to deliver");
  });
});
