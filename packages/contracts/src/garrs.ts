import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { OrchestrationV2ProviderFailure } from "./orchestrationV2.ts";
import { ProviderReportedCost } from "./providerRuntime.ts";

export const GarrsWorkItemId = TrimmedNonEmptyString.pipe(Schema.brand("GarrsWorkItemId"));
export type GarrsWorkItemId = typeof GarrsWorkItemId.Type;
export const GarrsTaskId = TrimmedNonEmptyString.pipe(Schema.brand("GarrsTaskId"));
export type GarrsTaskId = typeof GarrsTaskId.Type;
export const GarrsAttemptId = TrimmedNonEmptyString.pipe(Schema.brand("GarrsAttemptId"));
export type GarrsAttemptId = typeof GarrsAttemptId.Type;
export const GarrsPlanRevisionId = TrimmedNonEmptyString.pipe(Schema.brand("GarrsPlanRevisionId"));
export type GarrsPlanRevisionId = typeof GarrsPlanRevisionId.Type;
export const GarrsMessageId = TrimmedNonEmptyString.pipe(Schema.brand("GarrsMessageId"));
export type GarrsMessageId = typeof GarrsMessageId.Type;
export const GarrsArtifactId = TrimmedNonEmptyString.pipe(Schema.brand("GarrsArtifactId"));
export type GarrsArtifactId = typeof GarrsArtifactId.Type;
export const GarrsReviewId = TrimmedNonEmptyString.pipe(Schema.brand("GarrsReviewId"));
export type GarrsReviewId = typeof GarrsReviewId.Type;
export const GarrsMemoryId = TrimmedNonEmptyString.pipe(Schema.brand("GarrsMemoryId"));
export type GarrsMemoryId = typeof GarrsMemoryId.Type;

/** Stable internal identities. Display names and personalities are configurable; these are not. */
export const GarrsAgentId = Schema.Literals(["garras", "asta", "pixi", "botas", "copito", "kex"]);
export type GarrsAgentId = typeof GarrsAgentId.Type;
export const GARRS_AGENT_IDS: ReadonlyArray<GarrsAgentId> = GarrsAgentId.literals;

/** What a task may do to the workspace. Fixed per role in code; personality never widens it. */
export const GarrsCapability = Schema.Literals(["read", "write", "git"]);
export type GarrsCapability = typeof GarrsCapability.Type;

export const GarrsIntent = Schema.Literals([
  "consult",
  "diagnose",
  "plan",
  "implement",
  "review",
  "git",
]);
export type GarrsIntent = typeof GarrsIntent.Type;

export const GarrsAccess = Schema.Literals(["read_only", "write"]);
export type GarrsAccess = typeof GarrsAccess.Type;

const ShortText = Schema.String.check(Schema.isMaxLength(2_000));
const LongText = Schema.String.check(Schema.isMaxLength(64_000));
const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const TextList = Schema.Array(ShortText).check(Schema.isMaxLength(50));

export const GarrsModelInstruction = Schema.Struct({
  messageId: MessageId,
  quote: ShortText.check(Schema.isMinLength(1)),
});
export type GarrsModelInstruction = typeof GarrsModelInstruction.Type;

// ── Configuration ──────────────────────────────────────────────────────────

export const GarrsAgentProfile = Schema.Struct({
  agentId: GarrsAgentId,
  displayName: Label,
  description: ShortText,
  personality: ShortText,
});
export type GarrsAgentProfile = typeof GarrsAgentProfile.Type;

export const GarrsAgentModelPolicy = Schema.Struct({
  agentId: GarrsAgentId,
  /** Ordered preferences; the first available one is used. Empty means "coordinator decides". */
  candidates: Schema.Array(ModelSelection).check(Schema.isMaxLength(8)),
  /** When false, an unavailable first candidate blocks instead of falling back. */
  allowFallback: Schema.Boolean,
});
export type GarrsAgentModelPolicy = typeof GarrsAgentModelPolicy.Type;

export const GarrsLimits = Schema.Struct({
  maxConcurrentAttempts: PositiveInt,
  maxConcurrentAttemptsPerWorkItem: PositiveInt,
  maxConcurrentAttemptsPerProvider: PositiveInt,
  maxAttemptsPerTask: PositiveInt,
  maxCorrectionCycles: PositiveInt,
  attemptTimeoutMinutes: PositiveInt,
  maxMessagesPerTask: PositiveInt,
  /** Warn (not block) above this many tokens per work item; null disables. */
  tokenWarningPerWorkItem: Schema.NullOr(PositiveInt),
  /** Pause new assignments at this many tokens per work item; null disables. */
  tokenLimitPerWorkItem: Schema.NullOr(PositiveInt),
});
export type GarrsLimits = typeof GarrsLimits.Type;

export const GarrsReviewPolicy = Schema.Struct({
  /** Writes need an independent Copito review before delivery unless the user waives it. */
  requireReviewForWrites: Schema.Boolean,
  reviewDiagnoses: Schema.Boolean,
});
export type GarrsReviewPolicy = typeof GarrsReviewPolicy.Type;

export const GarrsRetentionPolicy = Schema.Struct({
  keepAttemptThreadsDays: Schema.NullOr(PositiveInt),
  storeArtifactBodies: Schema.Boolean,
});
export type GarrsRetentionPolicy = typeof GarrsRetentionPolicy.Type;

const GARRS_CONFIG_SCHEMA_VERSION = 1 as const;

/** Environment-owned team definition. Credentials never live here. */
export const GarrsTeamConfig = Schema.Struct({
  schemaVersion: Schema.Literal(GARRS_CONFIG_SCHEMA_VERSION),
  profiles: Schema.Array(GarrsAgentProfile),
  modelPolicy: Schema.Array(GarrsAgentModelPolicy),
  modelGuidance: Schema.optional(ShortText),
  limits: GarrsLimits,
  review: GarrsReviewPolicy,
  retention: GarrsRetentionPolicy,
  knowledgeSources: TextList,
});
export type GarrsTeamConfig = typeof GarrsTeamConfig.Type;

export const GarrsAutonomy = Schema.Literals([
  /** Plans need the user's approval before any write task starts. */
  "approve_plan",
  /** Read-only work runs freely; writes still follow the plan approval. */
  "auto_read",
  /** Plans run without approval inside the work item's authorized access. */
  "auto",
]);
export type GarrsAutonomy = typeof GarrsAutonomy.Type;

/** Project-owned binding, stored on the environment that owns the project. */
export const GarrsProjectBinding = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
  rulePaths: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(40)),
  linkedProjectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(20)),
  autonomy: GarrsAutonomy,
  /** Null allows every instance enabled for the project. */
  allowedProviderInstanceIds: Schema.NullOr(Schema.Array(ProviderInstanceId)),
  modelOverrides: Schema.Array(GarrsAgentModelPolicy),
});
export type GarrsProjectBinding = typeof GarrsProjectBinding.Type;

export const GarrsConfigSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  config: GarrsTeamConfig,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type GarrsConfigSnapshot = typeof GarrsConfigSnapshot.Type;

export const GarrsProjectBindingSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  binding: GarrsProjectBinding,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type GarrsProjectBindingSnapshot = typeof GarrsProjectBindingSnapshot.Type;

// ── Work state ─────────────────────────────────────────────────────────────

export const GarrsWorkItemStatus = Schema.Literals([
  "planning",
  "awaiting_approval",
  "active",
  "paused",
  "in_review",
  "ready_to_deliver",
  "delivered",
  "accepted",
  "blocked",
  "cancelled",
  "failed",
]);
export type GarrsWorkItemStatus = typeof GarrsWorkItemStatus.Type;

export const GarrsTaskStatus = Schema.Literals([
  "pending",
  "ready",
  "running",
  "waiting_dependency",
  "waiting_response",
  "waiting_authorization",
  "in_review",
  "needs_changes",
  "completed",
  "failed",
  "cancelled",
]);
export type GarrsTaskStatus = typeof GarrsTaskStatus.Type;

export const GarrsAttemptStatus = Schema.Literals([
  "launching",
  "running",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
  "superseded",
  "interrupted",
]);
export type GarrsAttemptStatus = typeof GarrsAttemptStatus.Type;

export const GarrsRuleSnapshot = Schema.Struct({
  path: TrimmedNonEmptyString,
  status: Schema.Literals(["read", "missing", "unreadable", "truncated", "outside_project"]),
  sha256: Schema.NullOr(TrimmedNonEmptyString),
  bytes: NonNegativeInt,
  readAt: IsoDateTime,
});
export type GarrsRuleSnapshot = typeof GarrsRuleSnapshot.Type;

export const GarrsWorkspaceBinding = Schema.Struct({
  projectId: ProjectId,
  /** Null until the isolated checkout of write work has been prepared. */
  checkoutPath: Schema.NullOr(TrimmedNonEmptyString),
  isolated: Schema.Boolean,
  baseSha: Schema.NullOr(TrimmedNonEmptyString),
});
export type GarrsWorkspaceBinding = typeof GarrsWorkspaceBinding.Type;

export const GarrsProjectContext = Schema.Struct({
  projectId: ProjectId,
  repositoryIdentity: Schema.optional(TrimmedNonEmptyString),
  projectRoot: Schema.optional(TrimmedNonEmptyString),
  bindingRevision: NonNegativeInt,
  rules: Schema.Array(GarrsRuleSnapshot),
  workspace: GarrsWorkspaceBinding,
  baselineDiffHash: Schema.optional(TrimmedNonEmptyString),
});
export type GarrsProjectContext = typeof GarrsProjectContext.Type;

export const GarrsAuthorizationRecord = Schema.Struct({
  kind: Schema.Literals(["write", "git_commit", "git_push", "review_waiver", "plan_approval"]),
  grantedBy: Schema.Literals(["user"]),
  note: ShortText,
  grantedAt: IsoDateTime,
});
export type GarrsAuthorizationRecord = typeof GarrsAuthorizationRecord.Type;

export const GarrsCommitProposal = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  checkoutPath: TrimmedNonEmptyString,
  branchRef: TrimmedNonEmptyString,
  parentSha: TrimmedNonEmptyString,
  treeSha: TrimmedNonEmptyString,
  diff: Schema.optional(LongText),
  reviewSubjectHash: TrimmedNonEmptyString,
  message: Label,
  attemptId: GarrsAttemptId,
  status: Schema.Literals([
    "proposed",
    "approved",
    "prepared",
    "committed",
    "failed",
    "outcome_unknown",
  ]),
  commitSha: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  failureReason: Schema.optional(Schema.NullOr(ShortText)),
  createdAt: IsoDateTime,
  approvedAt: Schema.NullOr(IsoDateTime),
});
export type GarrsCommitProposal = typeof GarrsCommitProposal.Type;

export const GarrsPushProposal = Schema.Struct({
  id: TrimmedNonEmptyString,
  commitProposalId: TrimmedNonEmptyString,
  commitSha: TrimmedNonEmptyString,
  remote: Label,
  destination: TrimmedNonEmptyString,
  destinationHash: TrimmedNonEmptyString,
  branchRef: TrimmedNonEmptyString,
  expectedRemoteSha: Schema.NullOr(TrimmedNonEmptyString),
  subjectHash: TrimmedNonEmptyString,
  userRequest: GarrsModelInstruction,
  attemptId: GarrsAttemptId,
  status: Schema.Literals([
    "proposed",
    "approved",
    "sending",
    "pushed",
    "failed",
    "outcome_unknown",
  ]),
  failureReason: Schema.optional(Schema.NullOr(ShortText)),
  createdAt: IsoDateTime,
  approvedAt: Schema.NullOr(IsoDateTime),
});
export type GarrsPushProposal = typeof GarrsPushProposal.Type;

export const GarrsWorkItem = Schema.Struct({
  id: GarrsWorkItemId,
  projectId: ProjectId,
  garrasThreadId: ThreadId,
  title: Label,
  objective: LongText,
  intent: GarrsIntent,
  access: GarrsAccess,
  status: GarrsWorkItemStatus,
  statusReason: Schema.NullOr(ShortText),
  configRevision: NonNegativeInt,
  bindingRevision: NonNegativeInt,
  /** Increments with each round of user feedback. */
  revision: PositiveInt,
  correctionCycles: NonNegativeInt,
  rules: Schema.Array(GarrsRuleSnapshot),
  workspace: Schema.NullOr(GarrsWorkspaceBinding),
  projectContexts: Schema.optional(Schema.Array(GarrsProjectContext)),
  repositoryIdentity: Schema.optional(TrimmedNonEmptyString),
  projectRoot: Schema.optional(TrimmedNonEmptyString),
  readOnlyBaseline: Schema.optional(
    Schema.Struct({
      headSha: TrimmedNonEmptyString,
      diffHash: TrimmedNonEmptyString,
    }),
  ),
  authorizations: Schema.Array(GarrsAuthorizationRecord),
  commitProposal: Schema.optional(GarrsCommitProposal),
  commitProposalHistory: Schema.optional(Schema.Array(GarrsCommitProposal)),
  commitPreparation: Schema.optional(
    Schema.Struct({
      taskId: GarrsTaskId,
      status: Schema.Literals(["pending", "prepared", "failed"]),
      subjectHash: Schema.NullOr(TrimmedNonEmptyString),
      reason: Schema.NullOr(ShortText),
    }),
  ),
  pushProposal: Schema.optional(GarrsPushProposal),
  pushProposalHistory: Schema.optional(Schema.Array(GarrsPushProposal)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime),
  acceptedAt: Schema.NullOr(IsoDateTime),
});
export type GarrsWorkItem = typeof GarrsWorkItem.Type;

export const GarrsTaskKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/),
).annotate({ description: "Plan-local key, lowercase letters, digits and dashes." });
export type GarrsTaskKey = typeof GarrsTaskKey.Type;

export const GarrsTaskSpec = Schema.Struct({
  key: GarrsTaskKey,
  projectId: Schema.optional(ProjectId),
  agentId: GarrsAgentId,
  title: Label,
  objective: LongText,
  reason: ShortText.annotate({ description: "Why this agent participates." }),
  inputs: TextList,
  deliverables: TextList.check(Schema.isMinLength(1)),
  acceptanceCriteria: TextList.check(Schema.isMinLength(1)),
  dependsOn: Schema.Array(GarrsTaskKey).check(Schema.isMaxLength(20)),
  capability: GarrsCapability,
  selection: Schema.optional(
    ModelSelection.annotate({
      description:
        "Garras's choice from garrs action models. Supply selectionReason; only declared, policy-permitted alternatives may be used.",
    }),
  ),
  selectionReason: Schema.optional(ShortText),
  fallbackSelections: Schema.optional(Schema.Array(ModelSelection).check(Schema.isMaxLength(8))),
});
export type GarrsTaskSpec = typeof GarrsTaskSpec.Type;

export const GarrsPlanRevision = Schema.Struct({
  id: GarrsPlanRevisionId,
  workItemId: GarrsWorkItemId,
  revision: PositiveInt,
  authorAttemptId: Schema.NullOr(GarrsAttemptId),
  summary: LongText,
  risks: TextList,
  tasks: Schema.Array(GarrsTaskSpec),
  status: Schema.Literals(["active", "superseded", "awaiting_approval", "rejected"]),
  createdAt: IsoDateTime,
});
export type GarrsPlanRevision = typeof GarrsPlanRevision.Type;

export const GarrsTask = Schema.Struct({
  id: GarrsTaskId,
  workItemId: GarrsWorkItemId,
  projectId: ProjectId,
  planRevision: NonNegativeInt,
  key: GarrsTaskKey,
  agentId: GarrsAgentId,
  title: Label,
  objective: LongText,
  reason: ShortText,
  inputs: TextList,
  deliverables: TextList,
  acceptanceCriteria: TextList,
  dependsOn: Schema.Array(GarrsTaskKey),
  capability: GarrsCapability,
  helper: Schema.optional(
    Schema.Struct({
      parentTaskId: GarrsTaskId,
      parentAttemptId: GarrsAttemptId,
      deadline: IsoDateTime,
    }),
  ),
  status: GarrsTaskStatus,
  statusReason: Schema.NullOr(ShortText),
  /** Bumped when the task is retried, reassigned or cancelled; stale attempts carry older ones. */
  generation: NonNegativeInt,
  attemptCount: NonNegativeInt,
  /** A user reassignment or coordinator choice; applies to every later attempt of this task. */
  pinnedSelection: Schema.NullOr(ModelSelection),
  pinnedBy: Schema.NullOr(Schema.Literals(["user", "coordinator"])),
  modelInstruction: Schema.optional(GarrsModelInstruction),
  selectionReason: Schema.optional(ShortText),
  fallbackSelections: Schema.optional(Schema.Array(ModelSelection).check(Schema.isMaxLength(8))),
  completionArtifactId: Schema.NullOr(GarrsArtifactId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GarrsTask = typeof GarrsTask.Type;

export const GarrsModelCandidate = Schema.Struct({
  selection: ModelSelection,
  available: Schema.Boolean,
  note: ShortText,
});
export type GarrsModelCandidate = typeof GarrsModelCandidate.Type;

export const GarrsModelDecision = Schema.Struct({
  source: Schema.Literals([
    "task_pin",
    "coordinator",
    "project_override",
    "team_policy",
    "catalog_default",
    "bootstrap",
    "automatic",
    "user_instruction",
  ]),
  candidates: Schema.Array(GarrsModelCandidate),
  requested: ModelSelection,
  reason: ShortText,
  userInstruction: Schema.optional(GarrsModelInstruction),
  fallbackUsed: Schema.Boolean,
  constraints: TextList,
  /** The model the provider reported running, when it reports one. */
  effectiveModel: Schema.NullOr(TrimmedNonEmptyString),
  effectiveModelSource: Schema.Literals([
    "provider_session",
    "provider_response",
    "unverifiable",
    "pending",
  ]),
});
export type GarrsModelDecision = typeof GarrsModelDecision.Type;

export const GarrsBootstrapDecision = Schema.Struct({
  runId: RunId,
  userMessageId: MessageId,
  failedSelection: ModelSelection,
  failure: OrchestrationV2ProviderFailure,
  observedAt: IsoDateTime,
  attemptNumber: PositiveInt,
  decision: Schema.NullOr(GarrsModelDecision),
  status: Schema.Literals(["selected", "queued", "blocked"]),
  reason: ShortText,
  queuedAt: Schema.NullOr(IsoDateTime),
});
export type GarrsBootstrapDecision = typeof GarrsBootstrapDecision.Type;

export const GarrsUsageQuality = Schema.Literals(["reported", "partial", "unknown"]);
export type GarrsUsageQuality = typeof GarrsUsageQuality.Type;

/** Usage of one attempt. Null means unknown, never zero. */
export const GarrsUsageAttribution = Schema.Struct({
  quality: GarrsUsageQuality,
  reportedModels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  modelIdentityComplete: Schema.optional(Schema.Boolean),
  reportedCost: Schema.optional(ProviderReportedCost),
  pricingSelectionConsistent: Schema.optional(Schema.Boolean),
  inputTokens: Schema.NullOr(NonNegativeInt),
  cachedInputTokens: Schema.NullOr(NonNegativeInt),
  cacheCreationTokens: Schema.optional(Schema.NullOr(NonNegativeInt)),
  outputTokens: Schema.NullOr(NonNegativeInt),
  /** Reported separately by some providers; usually already counted in output. */
  reasoningOutputTokens: Schema.NullOr(NonNegativeInt),
  providerTurns: NonNegativeInt,
  queueWaitMs: Schema.NullOr(NonNegativeInt),
  runDurationMs: Schema.NullOr(NonNegativeInt),
});
export type GarrsUsageAttribution = typeof GarrsUsageAttribution.Type;

export const GarrsAttempt = Schema.Struct({
  id: GarrsAttemptId,
  taskId: GarrsTaskId,
  workItemId: GarrsWorkItemId,
  agentId: GarrsAgentId,
  generation: NonNegativeInt,
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  readOnlyEnforced: Schema.Boolean,
  decision: GarrsModelDecision,
  status: GarrsAttemptStatus,
  error: Schema.NullOr(ShortText),
  failure: Schema.optional(OrchestrationV2ProviderFailure),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  cancelRequestedAt: Schema.NullOr(IsoDateTime),
  /** Review attempts only: the subject Copito was given at launch. The review is bound to it. */
  reviewSubjectHash: Schema.NullOr(TrimmedNonEmptyString),
  usage: GarrsUsageAttribution,
});
export type GarrsAttempt = typeof GarrsAttempt.Type;

export const GarrsMessageKind = Schema.Literals([
  "question",
  "answer",
  "contract_proposal",
  "contract_change",
  "blocker",
  "deliverable",
  "review_request",
  "finding",
  "note",
]);
export type GarrsMessageKind = typeof GarrsMessageKind.Type;

export const GarrsMessage = Schema.Struct({
  id: GarrsMessageId,
  workItemId: GarrsWorkItemId,
  taskId: Schema.NullOr(GarrsTaskId),
  fromAgent: Schema.Union([GarrsAgentId, Schema.Literal("user"), Schema.Literal("system")]),
  toAgent: Schema.Union([GarrsAgentId, Schema.Literal("user")]),
  toTaskId: Schema.optional(GarrsTaskId),
  kind: GarrsMessageKind,
  body: LongText,
  refs: TextList,
  replyTo: Schema.NullOr(GarrsMessageId),
  deliveryStatus: Schema.Literals(["pending", "queued", "delivered", "dropped"]),
  createdAt: IsoDateTime,
});
export type GarrsMessage = typeof GarrsMessage.Type;

export const GarrsArtifactKind = Schema.Literals([
  "answer",
  "diagnosis",
  "plan",
  "code_change",
  "test_report",
  "review",
  "summary",
]);
export type GarrsArtifactKind = typeof GarrsArtifactKind.Type;

export const GarrsWorkspaceState = Schema.Struct({
  checkoutPath: TrimmedNonEmptyString,
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  /** sha256 of the checkout's diff against the work item base, including untracked files. */
  diffHash: Schema.NullOr(TrimmedNonEmptyString),
  changedFiles: Schema.Array(TrimmedNonEmptyString),
  unavailableReason: Schema.optional(ShortText),
});
export type GarrsWorkspaceState = typeof GarrsWorkspaceState.Type;

export const GarrsArtifact = Schema.Struct({
  id: GarrsArtifactId,
  workItemId: GarrsWorkItemId,
  taskId: GarrsTaskId,
  attemptId: GarrsAttemptId,
  agentId: GarrsAgentId,
  kind: GarrsArtifactKind,
  summary: ShortText,
  body: LongText,
  evidence: TextList,
  contentHash: TrimmedNonEmptyString,
  workspace: Schema.NullOr(GarrsWorkspaceState),
  createdAt: IsoDateTime,
});
export type GarrsArtifact = typeof GarrsArtifact.Type;

export const GarrsCriterionStatus = Schema.Literals([
  "verified",
  "failed",
  "not_applicable",
  "unverifiable",
]);
export type GarrsCriterionStatus = typeof GarrsCriterionStatus.Type;

export const GarrsReviewCriterion = Schema.Struct({
  criterion: ShortText,
  status: GarrsCriterionStatus,
  evidence: ShortText,
});
export type GarrsReviewCriterion = typeof GarrsReviewCriterion.Type;

export const GarrsFindingSeverity = Schema.Literals(["blocker", "major", "minor", "info"]);
export type GarrsFindingSeverity = typeof GarrsFindingSeverity.Type;

export const GarrsFinding = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  description: ShortText,
  impact: ShortText,
  location: ShortText,
  severity: GarrsFindingSeverity,
  suggestedOwner: GarrsAgentId,
  resolutionCondition: ShortText,
});
export type GarrsFinding = typeof GarrsFinding.Type;

export const GarrsReview = Schema.Struct({
  id: GarrsReviewId,
  workItemId: GarrsWorkItemId,
  taskId: GarrsTaskId,
  attemptId: GarrsAttemptId,
  /** What was reviewed: workspace diff hash plus rule hashes for write work, artifact hashes otherwise. */
  subjectHash: TrimmedNonEmptyString,
  verdict: Schema.Literals(["approved", "changes_requested", "blocked"]),
  criteria: Schema.Array(GarrsReviewCriterion),
  findings: Schema.Array(GarrsFinding),
  status: Schema.Literals(["valid", "invalidated"]),
  invalidatedReason: Schema.NullOr(ShortText),
  createdAt: IsoDateTime,
});
export type GarrsReview = typeof GarrsReview.Type;

export const GarrsActivity = Schema.Struct({
  sequence: NonNegativeInt,
  workItemId: GarrsWorkItemId,
  type: TrimmedNonEmptyString,
  summary: ShortText,
  agentId: Schema.NullOr(GarrsAgentId),
  taskId: Schema.NullOr(GarrsTaskId),
  attemptId: Schema.NullOr(GarrsAttemptId),
  createdAt: IsoDateTime,
});
export type GarrsActivity = typeof GarrsActivity.Type;

export const GarrsWorkItemDetail = Schema.Struct({
  workItem: GarrsWorkItem,
  plans: Schema.Array(GarrsPlanRevision),
  tasks: Schema.Array(GarrsTask),
  attempts: Schema.Array(GarrsAttempt),
  messages: Schema.Array(GarrsMessage),
  artifacts: Schema.Array(GarrsArtifact),
  reviews: Schema.Array(GarrsReview),
  activity: Schema.Array(GarrsActivity),
  /** What still blocks delivery, computed by the server. Empty when delivery is allowed. */
  remaining: TextList,
});
export type GarrsWorkItemDetail = typeof GarrsWorkItemDetail.Type;

export const GarrsAgentStatus = Schema.Struct({
  agentId: GarrsAgentId,
  state: Schema.Literals(["idle", "working", "waiting", "blocked"]),
  workItemId: Schema.NullOr(GarrsWorkItemId),
  taskId: Schema.NullOr(GarrsTaskId),
  taskTitle: Schema.NullOr(Label),
  attemptId: Schema.NullOr(GarrsAttemptId),
  threadId: Schema.NullOr(ThreadId),
  selection: Schema.NullOr(ModelSelection),
  waitingFor: Schema.NullOr(ShortText),
});
export type GarrsAgentStatus = typeof GarrsAgentStatus.Type;

export const GarrsWorkItemSummary = Schema.Struct({
  id: GarrsWorkItemId,
  garrasThreadId: ThreadId,
  title: Label,
  intent: GarrsIntent,
  access: GarrsAccess,
  status: GarrsWorkItemStatus,
  statusReason: Schema.NullOr(ShortText),
  taskCount: NonNegativeInt,
  completedTaskCount: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type GarrsWorkItemSummary = typeof GarrsWorkItemSummary.Type;

export const GarrsProjectState = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
  garrasThreadIds: Schema.Array(ThreadId),
  garrasConversations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        decision: GarrsModelDecision,
        bootstrapDecisions: Schema.optional(Schema.Array(GarrsBootstrapDecision)),
      }),
    ),
  ),
  agents: Schema.Array(GarrsAgentStatus),
  workItems: Schema.Array(GarrsWorkItemSummary),
});
export type GarrsProjectState = typeof GarrsProjectState.Type;

export const GarrsMemoryEntry = Schema.Struct({
  id: GarrsMemoryId,
  projectId: ProjectId,
  kind: Schema.Literals(["fact", "decision", "preference", "hypothesis", "obsolete"]),
  body: ShortText,
  provenance: ShortText,
  scope: ShortText,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GarrsMemoryEntry = typeof GarrsMemoryEntry.Type;

export const GarrsUsageRow = Schema.Struct({
  attemptId: GarrsAttemptId,
  workItemId: GarrsWorkItemId,
  workItemTitle: Label,
  projectId: ProjectId,
  taskId: GarrsTaskId,
  helper: GarrsTask.fields.helper,
  agentId: GarrsAgentId,
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  effectiveModel: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  estimatedCostUsd: Schema.optional(
    Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  ),
  estimatePriceSource: Schema.optional(
    Schema.NullOr(Schema.Literals(["fresh", "cached", "override"])),
  ),
  status: GarrsAttemptStatus,
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  usage: GarrsUsageAttribution,
});
export type GarrsUsageRow = typeof GarrsUsageRow.Type;

/** Usage of a Garras conversation run, independent of any work item. */
export const GarrsConversationUsageRow = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  projectId: ProjectId,
  agentId: Schema.Literal("garras"),
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  effectiveModel: Schema.NullOr(TrimmedNonEmptyString),
  status: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  estimatedCostUsd: Schema.NullOr(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  estimatePriceSource: Schema.NullOr(Schema.Literals(["fresh", "cached", "override"])),
  usage: GarrsUsageAttribution.mapFields((fields) => ({
    ...fields,
    providerTurns: Schema.NullOr(NonNegativeInt),
  })),
});
export type GarrsConversationUsageRow = typeof GarrsConversationUsageRow.Type;

// ── RPC payloads ───────────────────────────────────────────────────────────

export class GarrsError extends Schema.TaggedError<GarrsError>()("GarrsError", {
  code: Schema.Literals([
    "not_found",
    "conflict",
    "invalid",
    "disabled",
    "forbidden",
    "unavailable",
    "persistence",
  ]),
  message: Schema.String,
}) {}

export const GarrsUpdateConfigInput = Schema.Struct({
  expectedRevision: NonNegativeInt,
  config: GarrsTeamConfig,
});
export type GarrsUpdateConfigInput = typeof GarrsUpdateConfigInput.Type;

export const GarrsProjectInput = Schema.Struct({ projectId: ProjectId });
export type GarrsProjectInput = typeof GarrsProjectInput.Type;

export const GarrsUpdateProjectBindingInput = Schema.Struct({
  expectedRevision: NonNegativeInt,
  binding: GarrsProjectBinding,
});
export type GarrsUpdateProjectBindingInput = typeof GarrsUpdateProjectBindingInput.Type;

export const GarrsStartConversationInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  message: Schema.optional(LongText),
});
export type GarrsStartConversationInput = typeof GarrsStartConversationInput.Type;

export const GarrsStartConversationResult = Schema.Struct({
  threadId: ThreadId,
  decision: GarrsModelDecision,
});
export type GarrsStartConversationResult = typeof GarrsStartConversationResult.Type;

export const GarrsWorkItemInput = Schema.Struct({ workItemId: GarrsWorkItemId });
export type GarrsWorkItemInput = typeof GarrsWorkItemInput.Type;

export const GarrsControlAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("pause") }),
  Schema.Struct({ type: Schema.Literal("resume") }),
  Schema.Struct({ type: Schema.Literal("cancel"), reason: Schema.optional(ShortText) }),
  Schema.Struct({ type: Schema.Literal("accept") }),
  Schema.Struct({
    type: Schema.Literal("approve_plan"),
    /** The revision the user saw. Rejected when another revision awaits approval. */
    planId: GarrsPlanRevisionId,
  }),
  Schema.Struct({ type: Schema.Literal("stop_attempt"), attemptId: GarrsAttemptId }),
  Schema.Struct({ type: Schema.Literal("retry_task"), taskId: GarrsTaskId }),
  Schema.Struct({
    type: Schema.Literal("reassign_task"),
    taskId: GarrsTaskId,
    selection: ModelSelection,
  }),
  Schema.Struct({ type: Schema.Literal("waive_review"), reason: ShortText }),
  Schema.Struct({ type: Schema.Literal("approve_commit"), proposalId: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("approve_push"), proposalId: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("authorize"),
    kind: Schema.Literals(["write", "git_commit", "git_push"]),
    note: ShortText,
  }),
]);
export type GarrsControlAction = typeof GarrsControlAction.Type;

export const GarrsControlInput = Schema.Struct({
  commandId: CommandId,
  workItemId: GarrsWorkItemId,
  action: GarrsControlAction,
});
export type GarrsControlInput = typeof GarrsControlInput.Type;

export const GarrsControlResult = Schema.Struct({
  workItem: GarrsWorkItem,
  /** Exactly what the control did, such as "Stop requested for 2 running attempts". */
  effect: ShortText,
});
export type GarrsControlResult = typeof GarrsControlResult.Type;

const GARRS_PORTABLE_FORMAT = "t3code.garrs.config" as const;

export const GarrsPortableConfig = Schema.Struct({
  format: Schema.Literal(GARRS_PORTABLE_FORMAT),
  schemaVersion: Schema.Literal(GARRS_CONFIG_SCHEMA_VERSION),
  exportedAt: IsoDateTime,
  team: GarrsTeamConfig,
  project: Schema.optional(
    Schema.Struct({
      rulePaths: Schema.Array(TrimmedNonEmptyString),
      autonomy: GarrsAutonomy,
      allowedProviderInstanceIds: Schema.NullOr(Schema.Array(ProviderInstanceId)),
      modelOverrides: Schema.Array(GarrsAgentModelPolicy),
    }),
  ),
});
export type GarrsPortableConfig = typeof GarrsPortableConfig.Type;

export const GarrsExportConfigInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type GarrsExportConfigInput = typeof GarrsExportConfigInput.Type;

export const GarrsImportConfigInput = Schema.Struct({
  /** Raw JSON text so version problems surface as a report, not a decode failure. */
  document: Schema.String.check(Schema.isMaxLength(512_000)),
  projectId: Schema.optional(ProjectId),
  apply: Schema.Boolean,
  expectedRevision: NonNegativeInt,
});
export type GarrsImportConfigInput = typeof GarrsImportConfigInput.Type;

export const GarrsImportIssue = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  path: Schema.String,
  message: ShortText,
});
export type GarrsImportIssue = typeof GarrsImportIssue.Type;

export const GarrsImportConfigResult = Schema.Struct({
  applied: Schema.Boolean,
  issues: Schema.Array(GarrsImportIssue),
  /** Top-level settings that differ from the current ones. */
  changes: TextList,
});
export type GarrsImportConfigResult = typeof GarrsImportConfigResult.Type;

export const GarrsUsageInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  agentId: Schema.optional(GarrsAgentId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  since: Schema.optional(IsoDateTime),
  until: Schema.optional(IsoDateTime),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(5_000))),
});
export type GarrsUsageInput = typeof GarrsUsageInput.Type;

export const GarrsUsageResult = Schema.Struct({
  rows: Schema.Array(GarrsUsageRow),
  truncated: Schema.Boolean,
  conversations: Schema.optional(Schema.Array(GarrsConversationUsageRow)),
  conversationsTruncated: Schema.optional(Schema.Boolean),
  conversationEvidenceTruncated: Schema.optional(Schema.Boolean),
});
export type GarrsUsageResult = typeof GarrsUsageResult.Type;

export const GarrsMemoryMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("upsert"),
    id: Schema.optional(GarrsMemoryId),
    projectId: ProjectId,
    kind: GarrsMemoryEntry.fields.kind,
    body: ShortText,
    provenance: ShortText,
    scope: ShortText,
  }),
  Schema.Struct({ type: Schema.Literal("delete"), id: GarrsMemoryId, projectId: ProjectId }),
]);
export type GarrsMemoryMutation = typeof GarrsMemoryMutation.Type;

export const GarrsMemoryListResult = Schema.Struct({ entries: Schema.Array(GarrsMemoryEntry) });
export type GarrsMemoryListResult = typeof GarrsMemoryListResult.Type;

// ── Agent tool payloads (MCP) ──────────────────────────────────────────────

export const GarrsStartWorkInput = Schema.Struct({
  title: Label,
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(30))),
  objective: LongText.annotate({
    description: "The user's goal in their words, with constraints such as 'no changes'.",
  }),
  intent: GarrsIntent,
  access: GarrsAccess.annotate({
    description:
      "'read_only' unless the user asked for changes. Questions and 'don't change anything' are read_only.",
  }),
  plan: Schema.Union([
    Schema.Literal("asta"),
    Schema.Struct({ tasks: Schema.Array(GarrsTaskSpec).check(Schema.isMinLength(1)) }),
  ]).annotate({
    description:
      "'asta' asks Asta to plan. Pass tasks directly only for small work with an obvious single owner.",
  }),
  plannerSelection: Schema.optional(
    ModelSelection.annotate({ description: "Model for Asta when plan is 'asta'." }),
  ),
  plannerSelectionReason: Schema.optional(ShortText),
  plannerFallbackSelections: Schema.optional(
    Schema.Array(ModelSelection).check(Schema.isMaxLength(8)),
  ),
  clientRequestId: Schema.optional(TrimmedNonEmptyString),
});
export type GarrsStartWorkInput = typeof GarrsStartWorkInput.Type;

export const GarrsStatusInput = Schema.Struct({
  workItemId: Schema.optional(GarrsWorkItemId),
});
export type GarrsStatusInput = typeof GarrsStatusInput.Type;

export const GarrsModelsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  agentId: GarrsAgentId,
  capability: GarrsCapability,
  search: Schema.optional(ShortText),
  offset: Schema.optional(NonNegativeInt),
});
export type GarrsModelsInput = typeof GarrsModelsInput.Type;

export const GarrsSelectModelInput = Schema.Struct({
  workItemId: GarrsWorkItemId,
  taskId: GarrsTaskId,
  selection: ModelSelection,
  reason: ShortText.check(Schema.isMinLength(1)),
  userInstruction: Schema.optional(GarrsModelInstruction),
  fallbackSelections: Schema.optional(Schema.Array(ModelSelection).check(Schema.isMaxLength(8))),
});
export type GarrsSelectModelInput = typeof GarrsSelectModelInput.Type;

export const GarrsSubmitPlanInput = Schema.Struct({
  summary: LongText,
  risks: TextList,
  tasks: Schema.Array(GarrsTaskSpec).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
});
export type GarrsSubmitPlanInput = typeof GarrsSubmitPlanInput.Type;

export const GarrsReportInput = Schema.Struct({
  outcome: Schema.Literals(["done", "blocked", "needs_input"]),
  kind: GarrsArtifactKind,
  summary: ShortText,
  body: LongText,
  evidence: TextList.annotate({
    description: "Commands run with their results, files read, test names. Only what you did.",
  }),
  question: Schema.optional(ShortText),
});
export type GarrsReportInput = typeof GarrsReportInput.Type;

export const GarrsRequestHelperInput = Schema.Struct({
  objective: LongText,
  reason: ShortText,
  minutes: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(15),
  ),
  clientRequestId: Schema.optional(TrimmedNonEmptyString),
});
export type GarrsRequestHelperInput = typeof GarrsRequestHelperInput.Type;

export const GarrsProposeCommitInput = Schema.Struct({
  message: Label,
});
export type GarrsProposeCommitInput = typeof GarrsProposeCommitInput.Type;

export const GarrsProposePushInput = Schema.Struct({
  remote: Label,
  branch: Label,
  userRequest: GarrsModelInstruction,
});
export type GarrsProposePushInput = typeof GarrsProposePushInput.Type;

export const GarrsSendMessageInput = Schema.Struct({
  to: GarrsAgentId,
  toTaskId: Schema.optional(GarrsTaskId),
  kind: GarrsMessageKind,
  body: LongText,
  refs: Schema.optional(TextList),
  replyTo: Schema.optional(GarrsMessageId),
  workItemId: Schema.optional(GarrsWorkItemId),
  clientRequestId: Schema.optional(TrimmedNonEmptyString),
});
export type GarrsSendMessageInput = typeof GarrsSendMessageInput.Type;

export const GarrsSubmitReviewInput = Schema.Struct({
  verdict: GarrsReview.fields.verdict,
  criteria: Schema.Array(GarrsReviewCriterion).check(Schema.isMinLength(1)),
  findings: Schema.Array(GarrsFinding),
});
export type GarrsSubmitReviewInput = typeof GarrsSubmitReviewInput.Type;

export const GarrsDeliverInput = Schema.Struct({
  workItemId: GarrsWorkItemId,
  summary: LongText,
});
export type GarrsDeliverInput = typeof GarrsDeliverInput.Type;

export const GarrsReviseInput = Schema.Struct({
  workItemId: GarrsWorkItemId,
  feedback: LongText,
  access: Schema.optional(GarrsAccess),
});
export type GarrsReviseInput = typeof GarrsReviseInput.Type;

export const GarrsToolResult = Schema.Struct({
  ok: Schema.Boolean,
  message: LongText,
  workItemId: Schema.optional(GarrsWorkItemId),
  status: Schema.optional(Schema.String),
  remaining: Schema.optional(TextList),
});
export type GarrsToolResult = typeof GarrsToolResult.Type;
