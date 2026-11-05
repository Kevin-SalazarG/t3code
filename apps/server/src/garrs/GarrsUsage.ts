import type { GarrsAttempt, OrchestrationV2Run, TurnTokenUsage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { priceUsage, type RateTable } from "../usage/usagePricing.ts";

interface UsageProjection {
  readonly providerTurns: ReadonlyArray<{
    readonly id: string;
    readonly turnTokenUsage?: TurnTokenUsage | undefined;
  }>;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "requestedAt" | "startedAt" | "completedAt"> & {
      readonly modelSelection?: Selection | undefined;
    }
  >;
}

interface Selection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | undefined;
}

const optionKey = (option: NonNullable<Selection["options"]>[number]) =>
  `${option.id}\0${typeof option.value}\0${String(option.value)}`;

const sameSelection = (a: Selection, b: Selection) => {
  if (a.instanceId !== b.instanceId || a.model !== b.model) return false;
  const left = (a.options ?? []).map(optionKey).sort();
  const right = (b.options ?? []).map(optionKey).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

const usesStandardPrice = (selection: Selection) =>
  (selection.options ?? []).every(
    (option) =>
      (option.id === "fastMode" && option.value === false) ||
      (option.id === "serviceTier" &&
        (option.value === "default" || option.value === "standard")) ||
      ["reasoningEffort", "reasoning_effort", "effort"].includes(option.id),
  );

const millisBetween = (from: DateTime.Utc | null, to: DateTime.Utc | null) =>
  from === null || to === null
    ? null
    : Math.max(0, DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from));

export function usageFrom(
  projection: UsageProjection,
  requested?: Selection,
): GarrsAttempt["usage"] {
  const turns = [...new Map(projection.providerTurns.map((turn) => [turn.id, turn])).values()];
  const measured = turns.flatMap((turn) => {
    const usage = turn.turnTokenUsage;
    if (usage === undefined) return [];
    if (
      usage.usageStatus === "partial" &&
      [
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.cacheCreationTokens,
        usage.outputTokens,
        usage.reasoningTokens,
      ].every((value) => value === undefined || value === 0)
    ) {
      return [
        {
          usageStatus: "unavailable" as const,
          usageScope: usage.usageScope,
          hasSubagents: usage.hasSubagents,
        },
      ];
    }
    return [usage];
  });
  const sum = (pick: (usage: (typeof measured)[number]) => number | undefined) => {
    if (measured.length === 0 || measured.length !== turns.length) return null;
    const values = measured.map(pick);
    if (values.some((value) => value === undefined)) return null;
    return values.reduce<number>((total, value) => total + (value ?? 0), 0);
  };
  const complete =
    measured.length > 0 &&
    measured.length === turns.length &&
    measured.every((usage) => usage.usageStatus === "complete" && !usage.hasSubagents);
  const totalDuration = (pick: (run: UsageProjection["runs"][number]) => number | null) => {
    if (projection.runs.length === 0) return null;
    const durations = projection.runs.map(pick);
    if (durations.some((duration) => duration === null)) return null;
    return durations.reduce<number>((total, duration) => total + (duration ?? 0), 0);
  };
  const firstSelection = requested ?? projection.runs[0]?.modelSelection;
  const pricingSelectionConsistent =
    firstSelection !== undefined &&
    projection.runs.length > 0 &&
    usesStandardPrice(firstSelection) &&
    projection.runs.every(
      (run) =>
        run.modelSelection !== undefined && sameSelection(firstSelection, run.modelSelection),
    );
  const models = [...new Set(turns.flatMap((turn) => turn.turnTokenUsage?.models ?? []))];
  const costs = turns.flatMap((turn) =>
    turn.turnTokenUsage?.reportedCost === undefined ? [] : [turn.turnTokenUsage.reportedCost],
  );
  return {
    ...(firstSelection === undefined ? {} : { pricingSelectionConsistent }),
    quality: measured.every((usage) => usage.usageStatus === "unavailable")
      ? "unknown"
      : complete
        ? "reported"
        : "partial",
    inputTokens: sum((usage) => usage.inputTokens),
    cachedInputTokens: sum((usage) => usage.cachedInputTokens),
    cacheCreationTokens: sum((usage) => usage.cacheCreationTokens),
    outputTokens: sum((usage) => usage.outputTokens),
    reasoningOutputTokens: sum((usage) => usage.reasoningTokens),
    providerTurns: turns.length,
    queueWaitMs: totalDuration((run) => millisBetween(run.requestedAt, run.startedAt)),
    runDurationMs: totalDuration((run) => millisBetween(run.startedAt, run.completedAt)),
    ...(models.length === 0
      ? {}
      : {
          reportedModels: models,
          modelIdentityComplete: turns.every(
            (turn) => (turn.turnTokenUsage?.models?.length ?? 0) > 0,
          ),
        }),
    ...(costs.length === 0
      ? {}
      : {
          reportedCost: {
            amountUsd: costs.reduce((sum, cost) => sum + cost.amountUsd, 0),
            source: "provider_api_report" as const,
            scope: "query_delta" as const,
            status:
              costs.length === turns.length && costs.every((cost) => cost.status === "complete")
                ? ("complete" as const)
                : ("partial" as const),
          },
        }),
  };
}

export const confirmedUsageModel = (usage: GarrsAttempt["usage"]): string | null =>
  usage.modelIdentityComplete === true && usage.reportedModels?.length === 1
    ? usage.reportedModels[0]!
    : null;

export function estimateUsage(
  usage: GarrsAttempt["usage"],
  model: string,
  rates: RateTable,
  overrides: RateTable,
  confirmedEffectiveModel?: string | null,
): number | null {
  if (
    !canEstimateUsage(usage) ||
    (confirmedEffectiveModel != null && confirmedEffectiveModel !== model)
  )
    return null;
  const { inputTokens, cachedInputTokens, cacheCreationTokens, outputTokens } = usage;
  const priced = priceUsage(
    rates,
    {
      model,
      speed: "standard",
      reportedCostUsd: null,
      totals: {
        uncachedInputTokens: inputTokens - cachedInputTokens - cacheCreationTokens,
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningTokens: usage.reasoningOutputTokens ?? 0,
      },
    },
    overrides,
  );
  return priced.costSource === "unpriced" ? null : priced.costUsd;
}

export function canEstimateUsage(usage: GarrsAttempt["usage"]): usage is GarrsAttempt["usage"] & {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
} {
  const { inputTokens, cachedInputTokens, cacheCreationTokens, outputTokens } = usage;
  return (
    usage.quality === "reported" &&
    usage.pricingSelectionConsistent === true &&
    inputTokens !== null &&
    cachedInputTokens !== null &&
    cacheCreationTokens != null &&
    outputTokens !== null &&
    cachedInputTokens + cacheCreationTokens <= inputTokens
  );
}
