import {
  ProviderInstanceId,
  type GarrsAgentId,
  type GarrsAgentModelPolicy,
  type GarrsModelCandidate,
  type GarrsModelDecision,
  type GarrsModelInstruction,
  type ModelSelection,
  type ServerProviderModel,
  type ServerProviderUsageLimits,
  type OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import { garrsDriverRejection } from "./GarrsDomain.ts";

export interface CatalogInstance {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly allowed: boolean;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly models: ReadonlyArray<string>;
  readonly modelDetails?: ReadonlyArray<ServerProviderModel>;
  readonly defaultModel: string | null;
  readonly usageLimits?: ServerProviderUsageLimits;
}

interface ModelFailure {
  readonly selection: ModelSelection;
  readonly at: string;
  readonly failure: OrchestrationV2ProviderFailure;
}

interface SelectionRequirements {
  readonly readOnly: boolean;
  readonly coordinatorRequired?: boolean;
}

interface SelectionInput {
  readonly agentId: GarrsAgentId;
  readonly pinned: {
    readonly selection: ModelSelection;
    readonly by: "user" | "coordinator";
    readonly reason?: string | undefined;
    readonly fallbacks?: ReadonlyArray<ModelSelection> | undefined;
    readonly userInstruction?: GarrsModelInstruction | undefined;
  } | null;
  readonly projectOverrides: ReadonlyArray<GarrsAgentModelPolicy>;
  readonly teamPolicy: ReadonlyArray<GarrsAgentModelPolicy>;
  readonly catalog: ReadonlyArray<CatalogInstance>;
  readonly requirements: SelectionRequirements;
  readonly failures?: ReadonlyArray<ModelFailure>;
  readonly now?: string;
  readonly bootstrap?: boolean;
}

export type SelectionResult =
  | { readonly ok: true; readonly decision: GarrsModelDecision }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly candidates: ReadonlyArray<GarrsModelCandidate>;
    };

const selectionKey = (selection: ModelSelection) =>
  JSON.stringify([
    selection.instanceId,
    selection.model,
    [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  ]);

function quotaNote(instance: CatalogInstance, now: string | undefined): string | null {
  const limits = instance.usageLimits;
  if (limits === undefined || now === undefined) return null;
  const checked = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checked)) return null;
  const exhausted = limits.windows.find(
    (window) =>
      window.usedPercent >= 100 &&
      (window.resetsAt === undefined
        ? Date.parse(now) - checked <= 5 * 60_000
        : window.resetsAt > now),
  );
  return exhausted === undefined
    ? null
    : `Reported limit: ${exhausted.label} is exhausted (checked ${limits.checkedAt}; reset ${exhausted.resetsAt ?? "unknown"}).`;
}

function judge(selection: ModelSelection, input: SelectionInput): GarrsModelCandidate {
  const unavailable = (note: string): GarrsModelCandidate => ({
    selection,
    available: false,
    note,
  });
  const instance = input.catalog.find((entry) => entry.instanceId === selection.instanceId);
  if (instance === undefined) return unavailable("Provider instance is not configured here.");
  if (!instance.allowed) return unavailable("Provider instance is not allowed for this project.");
  if (!instance.available)
    return unavailable(instance.unavailableReason ?? "Provider instance is not available.");
  if (!instance.models.includes(selection.model))
    return unavailable(`Model ${selection.model} is not in ${instance.displayName}'s catalog.`);
  const rejection = garrsDriverRejection(instance.driver);
  if (rejection !== null) return unavailable(`${instance.displayName} ${rejection}`);
  const descriptors = instance.modelDetails?.find((model) => model.slug === selection.model)
    ?.capabilities?.optionDescriptors;
  for (const option of selection.options ?? []) {
    if (instance.modelDetails === undefined) continue;
    const descriptor = descriptors?.find((entry) => entry.id === option.id);
    if (
      descriptor === undefined ||
      (descriptor.type === "boolean"
        ? typeof option.value !== "boolean"
        : !descriptor.options.some((entry) => entry.id === option.value))
    ) {
      return unavailable(
        `The catalog cannot confirm option ${option.id}=${String(option.value)} for this model.`,
      );
    }
  }
  const limit = quotaNote(instance, input.now);
  if (limit !== null) return unavailable(limit);
  const recent = input.failures?.findLast(
    (entry) =>
      entry.failure.class === "usage_limit" &&
      entry.selection.instanceId === selection.instanceId &&
      input.now !== undefined &&
      ((entry.failure.resetAt != null && entry.failure.resetAt > input.now) ||
        Date.parse(input.now) - Date.parse(entry.at) < 5 * 60_000),
  );
  if (recent !== undefined)
    return unavailable(
      `Observed usage limit at ${recent.at}; reset ${recent.failure.resetAt ?? "unknown (temporary retry hold)"}.`,
    );
  return {
    selection,
    available: true,
    note: `Eligible; quota ${instance.usageLimits === undefined || instance.usageLimits.unavailable !== undefined ? "unknown" : `reported at ${instance.usageLimits.checkedAt}; not a guarantee of remaining capacity`}.`,
  };
}

export function modelCandidates(input: SelectionInput): ReadonlyArray<GarrsModelCandidate> {
  return input.catalog.flatMap((instance) =>
    instance.models.map((model) =>
      judge({ instanceId: ProviderInstanceId.make(instance.instanceId), model }, input),
    ),
  );
}

export function selectModel(input: SelectionInput): SelectionResult {
  const constraints = [
    input.requirements.readOnly
      ? "Requires enforced read-only tools or an OS sandbox; protection differs by adapter."
      : "Requires a verified isolated checkout and enforced workspace writes.",
    "Requires per-thread role instructions and verified T3-only MCP access.",
    "Project provider allowlist is mandatory; account quota is not inferred from catalog availability.",
    "Garrs shell commands have no network access; publishing and arbitrary Git operations are not granted.",
  ];
  const decide = (
    source: GarrsModelDecision["source"],
    candidates: ReadonlyArray<GarrsModelCandidate>,
    chosen: GarrsModelCandidate,
    reason: string,
    configuredFallback = false,
  ): SelectionResult => ({
    ok: true,
    decision: {
      source,
      candidates,
      requested: chosen.selection,
      reason: reason.slice(0, 2_000),
      fallbackUsed:
        source !== "bootstrap" &&
        source !== "automatic" &&
        (candidates[0] !== chosen || configuredFallback),
      constraints,
      effectiveModel: null,
      effectiveModelSource: "pending",
      ...(source === "user_instruction" && input.pinned?.userInstruction !== undefined
        ? { userInstruction: input.pinned.userInstruction }
        : {}),
    },
  });
  const policies = [
    ["project_override", input.projectOverrides],
    ["team_policy", input.teamPolicy],
  ] as const;
  const configured = policies.flatMap(([source, entries]) => {
    const policy = entries.find(
      (entry) => entry.agentId === input.agentId && entry.candidates.length > 0,
    );
    return policy === undefined ? [] : [{ source, policy }];
  })[0];
  const configuredCandidates = configured?.policy.candidates.map((selection) =>
    judge(selection, input),
  );
  const permittedPreferences = configured?.policy.allowFallback
    ? configuredCandidates
    : configuredCandidates?.slice(0, 1);
  const firstEligiblePreference = permittedPreferences?.find((candidate) => candidate.available);
  const allowedByPolicy = (selection: ModelSelection) =>
    configured === undefined ||
    (permittedPreferences?.some(
      (candidate) => selectionKey(candidate.selection) === selectionKey(selection),
    ) === true &&
      (firstEligiblePreference === undefined ||
        selectionKey(firstEligiblePreference.selection) === selectionKey(selection)));

  if (input.pinned !== null) {
    const pinned = input.pinned;
    if (
      pinned.by === "coordinator" &&
      input.requirements.coordinatorRequired &&
      !pinned.reason?.trim()
    ) {
      return {
        ok: false,
        reason: "Waiting for Garras to record a task-specific model reason with select_model.",
        candidates: [judge(pinned.selection, input)],
      };
    }
    const selections = [
      pinned.selection,
      ...(pinned.by === "user" ? [] : (pinned.fallbacks ?? [])),
    ];
    const candidates = selections.map((selection) =>
      pinned.by === "coordinator" && !allowedByPolicy(selection)
        ? {
            selection,
            available: false,
            note: "Coordinator choice conflicts with the user's configured model policy.",
          }
        : judge(selection, input),
    );
    const chosen = candidates.find((candidate) => candidate.available);
    if (chosen === undefined)
      return {
        ok: false,
        reason:
          `Requested model unavailable: ${candidates.map((candidate) => candidate.note).join(" ")}`.slice(
            0,
            2_000,
          ),
        candidates,
      };
    const rationale =
      pinned.reason?.trim() ||
      `Chosen by the ${pinned.by}; no task-specific rationale was supplied.`;
    const configuredFallback =
      pinned.by === "coordinator" &&
      configuredCandidates !== undefined &&
      selectionKey(configuredCandidates[0]!.selection) !== selectionKey(chosen.selection);
    return decide(
      pinned.by === "user"
        ? pinned.userInstruction === undefined
          ? "task_pin"
          : "user_instruction"
        : "coordinator",
      candidates,
      chosen,
      `${rationale}${chosen !== candidates[0] ? ` Alternative used: ${candidates[0]!.note}` : ""}${configuredFallback ? ` Configured preference unavailable (${configuredCandidates[0]!.note}); authorized fallback used.` : ""}`,
      configuredFallback,
    );
  }
  if (configured !== undefined) {
    const candidates = configured.policy.candidates.map((selection) => judge(selection, input));
    const chosen = (configured.policy.allowFallback ? candidates : candidates.slice(0, 1)).find(
      (candidate) => candidate.available,
    );
    if (chosen === undefined)
      return {
        ok: false,
        reason: `Preferred model unavailable${configured.policy.allowFallback ? "" : " and fallback is off"}: ${candidates[0]!.note}`,
        candidates,
      };
    return decide(
      configured.source,
      candidates,
      chosen,
      chosen === candidates[0]
        ? "User's first configured preference is eligible."
        : `First preference unavailable (${candidates[0]!.note}); authorized fallback used.`,
    );
  }
  const candidates = modelCandidates(input);
  if (input.requirements.coordinatorRequired && !input.bootstrap)
    return {
      ok: false,
      reason:
        "Waiting for Garras to choose a model and account with a task-specific reason (garrs models, then select_model).",
      candidates,
    };
  const rank = (candidate: GarrsModelCandidate) => {
    const instance = input.catalog.find(
      (entry) => entry.instanceId === candidate.selection.instanceId,
    )!;
    const model = instance.modelDetails?.find((entry) => entry.slug === candidate.selection.model);
    return (
      (model?.isLegacy ? -100 : 0) + (instance.defaultModel === candidate.selection.model ? 10 : 0)
    );
  };
  const eligible = candidates
    .filter((candidate) => candidate.available)
    .toSorted(
      (a, b) =>
        rank(b) - rank(a) ||
        a.selection.model.localeCompare(b.selection.model) ||
        a.selection.instanceId.localeCompare(b.selection.instanceId),
    );
  const chosen = eligible[0];
  if (chosen === undefined)
    return {
      ok: false,
      reason: "No configured provider meets this role's requirements.",
      candidates,
    };
  return decide(
    input.bootstrap ? "bootstrap" : "automatic",
    candidates,
    chosen,
    `${input.bootstrap ? "Garras bootstrap, before coordinator reasoning" : "Automatic server baseline"}: eligible catalog models, prefer non-legacy provider defaults, stable model/account tie-break. No task-quality claim; quota remains unknown unless reported. Team choices are made separately by Garras.`,
  );
}
