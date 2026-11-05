import type {
  GarrsAttemptStatus,
  GarrsConversationUsageRow,
  GarrsModelDecision,
  GarrsTaskStatus,
  GarrsUsageRow,
  GarrsUsageAttribution,
  GarrsWorkItemStatus,
} from "@t3tools/contracts";

const UNKNOWN_VALUE = "Unknown";

export function formatCount(value: number | null): string {
  return value === null ? UNKNOWN_VALUE : value.toLocaleString("en-US");
}

export function formatDurationMs(value: number | null): string {
  if (value === null) return UNKNOWN_VALUE;
  if (value < 1_000) return `${value}ms`;
  const totalSeconds = Math.round(value / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function shortHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash;
}

export function effectiveModelLabel(decision: GarrsModelDecision): string {
  if (decision.effectiveModelSource !== "provider_response" || decision.effectiveModel === null) {
    return "Not verifiable";
  }
  return decision.effectiveModel;
}

export function reportedModelsLabel(
  usage: Pick<GarrsUsageAttribution, "reportedModels" | "modelIdentityComplete">,
): string {
  const models = usage.reportedModels?.join(", ");
  if (!models) return UNKNOWN_VALUE;
  return `${models}${usage.modelIdentityComplete === true ? "" : usage.modelIdentityComplete === false ? " · partial" : " · completeness unknown"}`;
}

export function humanize(value: string): string {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The end is exclusive: midnight at the start of the next local day. */
export function dateInputToIso(value: string, edge: "start" | "end"): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000`);
  if (Number.isNaN(date.getTime())) return undefined;
  if (edge === "end") date.setDate(date.getDate() + 1);
  return date.toISOString();
}

const USAGE_CSV_COLUMNS = [
  "exportTruncated",
  "attemptId",
  "workItemId",
  "projectId",
  "taskId",
  "helperParentTaskId",
  "helperParentAttemptId",
  "helperDeadline",
  "agentId",
  "providerInstanceId",
  "model",
  "effectiveModel",
  "status",
  "createdAt",
  "startedAt",
  "endedAt",
  "quality",
  "pricingSelectionConsistent",
  "inputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "providerTurns",
  "queueWaitMs",
  "runDurationMs",
  "reportedModels",
  "modelIdentityComplete",
  "nativeProviderEstimateUsd",
  "nativeProviderEstimateSource",
  "nativeProviderEstimateScope",
  "nativeProviderEstimateStatus",
  "estimatedCostUsd",
  "estimatePriceSource",
  "subscriptionChargeUsd",
] as const;

function csvField(value: string | number | boolean | null | undefined): string {
  // Unknown stays an empty cell so spreadsheets never read it as zero.
  if (value == null) return "";
  const raw = String(value);
  const text =
    typeof value === "string" && (/^[\t\r\n]/.test(raw) || /^[\s]*[=+@-]/.test(raw))
      ? `'${raw}`
      : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function usageRowsToCsv(rows: ReadonlyArray<GarrsUsageRow>, truncated = false): string {
  const lines = rows.map((row) => {
    const record: Record<(typeof USAGE_CSV_COLUMNS)[number], string | number | null> = {
      exportTruncated: String(truncated),
      attemptId: row.attemptId,
      workItemId: row.workItemId,
      projectId: row.projectId,
      taskId: row.taskId,
      helperParentTaskId: row.helper?.parentTaskId ?? null,
      helperParentAttemptId: row.helper?.parentAttemptId ?? null,
      helperDeadline: row.helper?.deadline ?? null,
      agentId: row.agentId,
      providerInstanceId: row.providerInstanceId,
      model: row.model,
      effectiveModel: row.effectiveModel ?? null,
      status: row.status,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      quality: row.usage.quality,
      pricingSelectionConsistent:
        row.usage.pricingSelectionConsistent === undefined
          ? null
          : String(row.usage.pricingSelectionConsistent),
      inputTokens: row.usage.inputTokens,
      cachedInputTokens: row.usage.cachedInputTokens,
      cacheCreationTokens: row.usage.cacheCreationTokens ?? null,
      outputTokens: row.usage.outputTokens,
      reasoningOutputTokens: row.usage.reasoningOutputTokens,
      providerTurns: row.usage.providerTurns,
      queueWaitMs: row.usage.queueWaitMs,
      runDurationMs: row.usage.runDurationMs,
      reportedModels: row.usage.reportedModels?.join(" | ") ?? null,
      modelIdentityComplete:
        row.usage.modelIdentityComplete === undefined
          ? null
          : String(row.usage.modelIdentityComplete),
      nativeProviderEstimateUsd: row.usage.reportedCost?.amountUsd ?? null,
      nativeProviderEstimateSource: row.usage.reportedCost?.source ?? null,
      nativeProviderEstimateScope: row.usage.reportedCost?.scope ?? null,
      nativeProviderEstimateStatus: row.usage.reportedCost?.status ?? null,
      estimatedCostUsd: row.estimatedCostUsd ?? null,
      estimatePriceSource: row.estimatePriceSource ?? null,
      subscriptionChargeUsd: null,
    };
    return USAGE_CSV_COLUMNS.map((column) => csvField(record[column])).join(",");
  });
  return [USAGE_CSV_COLUMNS.join(","), ...lines].join("\n");
}

export function usageRowsForExport(rows: ReadonlyArray<GarrsUsageRow>) {
  return rows.map(({ workItemTitle: _workItemTitle, ...row }) => ({
    ...row,
    subscriptionChargeUsd: null,
  }));
}

export function conversationUsageRowsForExport(rows: ReadonlyArray<GarrsConversationUsageRow>) {
  return rows.map((row) => ({
    threadId: row.threadId,
    runId: row.runId,
    projectId: row.projectId,
    agentId: row.agentId,
    providerInstanceId: row.providerInstanceId,
    model: row.model,
    effectiveModel: row.effectiveModel,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    estimatedCostUsd: row.estimatedCostUsd,
    estimatePriceSource: row.estimatePriceSource,
    subscriptionChargeUsd: null,
    usage: {
      quality: row.usage.quality,
      pricingSelectionConsistent: row.usage.pricingSelectionConsistent ?? null,
      inputTokens: row.usage.inputTokens,
      cachedInputTokens: row.usage.cachedInputTokens,
      cacheCreationTokens: row.usage.cacheCreationTokens ?? null,
      outputTokens: row.usage.outputTokens,
      reasoningOutputTokens: row.usage.reasoningOutputTokens,
      providerTurns: row.usage.providerTurns,
      queueWaitMs: row.usage.queueWaitMs,
      runDurationMs: row.usage.runDurationMs,
      reportedModels: row.usage.reportedModels ?? null,
      modelIdentityComplete: row.usage.modelIdentityComplete ?? null,
      reportedCost: row.usage.reportedCost ?? null,
    },
  }));
}

export function conversationUsageRowsToCsv(
  rows: ReadonlyArray<GarrsConversationUsageRow>,
  truncated: boolean | null = null,
  evidenceTruncated: boolean | null = null,
): string {
  const columns = [
    "exportTruncated",
    "evidenceTruncated",
    "threadId",
    "runId",
    "projectId",
    "agentId",
    "providerInstanceId",
    "model",
    "effectiveModel",
    "status",
    "createdAt",
    "startedAt",
    "endedAt",
    "quality",
    "pricingSelectionConsistent",
    "inputTokens",
    "cachedInputTokens",
    "cacheCreationTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "providerTurns",
    "queueWaitMs",
    "runDurationMs",
    "reportedModels",
    "modelIdentityComplete",
    "nativeProviderEstimateUsd",
    "nativeProviderEstimateSource",
    "nativeProviderEstimateScope",
    "nativeProviderEstimateStatus",
    "estimatedCostUsd",
    "estimatePriceSource",
    "subscriptionChargeUsd",
  ] as const;
  const lines = conversationUsageRowsForExport(rows).map(({ usage, ...row }) => {
    const data = {
      exportTruncated: truncated === null ? null : String(truncated),
      evidenceTruncated: evidenceTruncated === null ? null : String(evidenceTruncated),
      ...row,
      ...usage,
      reportedModels: usage.reportedModels?.join(" | ") ?? null,
      nativeProviderEstimateUsd: usage.reportedCost?.amountUsd ?? null,
      nativeProviderEstimateSource: usage.reportedCost?.source ?? null,
      nativeProviderEstimateScope: usage.reportedCost?.scope ?? null,
      nativeProviderEstimateStatus: usage.reportedCost?.status ?? null,
    };
    return columns.map((column) => csvField(data[column])).join(",");
  });
  return [columns.join(","), ...lines].join("\n");
}

export function conversationUsageExport(
  rows: ReadonlyArray<GarrsConversationUsageRow>,
  truncated: boolean | null,
  evidenceTruncated: boolean | null,
) {
  return { rows: conversationUsageRowsForExport(rows), truncated, evidenceTruncated };
}

const TERMINAL_WORK_ITEM_STATUSES: ReadonlySet<GarrsWorkItemStatus> = new Set([
  "accepted",
  "cancelled",
  "failed",
]);

export interface GarrsWorkItemControls {
  readonly pause: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
  readonly accept: boolean;
  readonly waiveReview: boolean;
  readonly authorize: boolean;
}

/** Obvious per-status offers only; the server validates every control. */
export function workItemControls(status: GarrsWorkItemStatus): GarrsWorkItemControls {
  const open = !TERMINAL_WORK_ITEM_STATUSES.has(status);
  return {
    pause: status === "planning" || status === "active" || status === "in_review",
    resume: status === "paused" || status === "blocked",
    cancel: open,
    accept: status === "delivered",
    waiveReview: status === "in_review" || status === "blocked",
    authorize: open && status !== "delivered",
  };
}

export function attemptIsStoppable(status: GarrsAttemptStatus): boolean {
  return status === "launching" || status === "running";
}

export function taskIsRetryable(status: GarrsTaskStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "needs_changes";
}

export function taskIsReassignable(status: GarrsTaskStatus): boolean {
  return status !== "completed" && status !== "cancelled" && status !== "running";
}
