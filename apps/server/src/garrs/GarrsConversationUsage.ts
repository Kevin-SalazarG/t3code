import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { usageFrom } from "./GarrsUsage.ts";

const TERMINAL_RUNS = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

export interface ConversationCandidate {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly run: OrchestrationV2Run;
}

export interface ConversationTurn {
  readonly threadId: string;
  readonly turn: OrchestrationV2ProviderTurn;
  readonly attemptRun: string | null;
  readonly attemptRoot: string | null;
  readonly nodeRun: string | null;
  readonly inconsistent?: boolean;
}

interface AttributionState {
  readonly candidate: ConversationCandidate;
  readonly turns: Map<string, OrchestrationV2ProviderTurn>;
  ambiguous: boolean;
}

export function conversationUsage(
  candidates: ReadonlyArray<ConversationCandidate>,
  records: ReadonlyArray<ConversationTurn>,
  truncated: boolean,
) {
  const states = new Map<string, AttributionState>(
    candidates.map((candidate) => [
      candidate.run.id as string,
      { candidate, turns: new Map<string, OrchestrationV2ProviderTurn>(), ambiguous: truncated },
    ]),
  );
  const byThread = new Map<string, AttributionState[]>();
  for (const state of states.values()) {
    const list = byThread.get(state.candidate.threadId) ?? [];
    list.push(state);
    byThread.set(state.candidate.threadId, list);
  }
  for (const record of records) {
    const byAttempt = record.attemptRun === null ? undefined : states.get(record.attemptRun);
    const byNode = record.nodeRun === null ? undefined : states.get(record.nodeRun);
    if (record.inconsistent === true) {
      for (const entry of byThread.get(record.threadId) ?? []) entry.ambiguous = true;
      continue;
    }
    const target = record.turn.runAttemptId === null ? byNode : byAttempt;
    const root =
      record.turn.runAttemptId === null ? target?.candidate.run.rootNodeId : record.attemptRoot;
    if (
      target !== undefined &&
      target.candidate.threadId === record.threadId &&
      record.turn.nodeId === root &&
      (record.nodeRun === null || record.nodeRun === target.candidate.run.id)
    ) {
      target.turns.set(record.turn.id, record.turn);
      continue;
    }
    if (byAttempt !== undefined) byAttempt.ambiguous = true;
    if (byNode !== undefined) byNode.ambiguous = true;
    if (record.attemptRun === null && record.nodeRun === null)
      for (const entry of byThread.get(record.threadId) ?? []) entry.ambiguous = true;
  }
  return candidates.map((candidate) => {
    const state = states.get(candidate.run.id)!;
    const measured = usageFrom(
      { runs: [candidate.run], providerTurns: [...state.turns.values()] },
      candidate.run.modelSelection,
    );
    const incomplete =
      state.ambiguous ||
      !TERMINAL_RUNS.has(candidate.run.status) ||
      candidate.run.providerInstanceId !== candidate.run.modelSelection.instanceId;
    const usage = incomplete
      ? {
          ...measured,
          quality: measured.quality === "unknown" ? ("unknown" as const) : ("partial" as const),
          pricingSelectionConsistent: false,
          ...(measured.reportedModels === undefined ? {} : { modelIdentityComplete: false }),
          ...(measured.reportedCost === undefined
            ? {}
            : { reportedCost: { ...measured.reportedCost, status: "partial" as const } }),
        }
      : measured;
    return { ...candidate, usage };
  });
}
