import type {
  GarrsAgentId,
  GarrsAttempt,
  GarrsConfigSnapshot,
  GarrsModelDecision,
  GarrsTask,
  GarrsWorkItemStatus,
  ModelSelection,
} from "@t3tools/contracts";

const UNKNOWN_VALUE = "Unknown";

export const humanize = (value: string) => {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function garrsAgentName(
  config: GarrsConfigSnapshot | null,
  agentId: GarrsAgentId | "user" | "system",
): string {
  if (agentId === "user") return "You";
  if (agentId === "system") return "System";
  return (
    config?.config.profiles.find((profile) => profile.agentId === agentId)?.displayName ??
    humanize(agentId)
  );
}

export const modelLabel = (selection: ModelSelection) =>
  `${selection.instanceId} / ${selection.model}`;

/** Only a provider-reported model counts as verified. */
export const effectiveModelLabel = (decision: GarrsModelDecision) =>
  decision.effectiveModelSource === "provider_session" && decision.effectiveModel !== null
    ? decision.effectiveModel
    : "Not verifiable";

/** Null means the provider did not report it; it is never shown as zero. */
export const formatCount = (value: number | null) =>
  value === null ? UNKNOWN_VALUE : value.toLocaleString();

export const formatDuration = (ms: number | null) => {
  if (ms === null) return UNKNOWN_VALUE;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const TERMINAL_WORK: ReadonlySet<GarrsWorkItemStatus> = new Set([
  "delivered",
  "accepted",
  "cancelled",
  "failed",
]);

/** Which work item controls apply now. The server still decides; this only hides dead buttons. */
export function workItemControls(status: GarrsWorkItemStatus) {
  const terminal = TERMINAL_WORK.has(status);
  return {
    pause: !terminal && status !== "paused",
    resume: status === "paused" || status === "blocked" || status === "cancelled",
    cancel: !terminal,
    accept: status === "delivered",
  };
}

export const canStopAttempt = (attempt: GarrsAttempt) =>
  attempt.status === "launching" || attempt.status === "running";

export const canRetryTask = (task: GarrsTask) =>
  task.status === "failed" || task.status === "cancelled";
