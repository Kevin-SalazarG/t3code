import {
  CommandId,
  type GarrsBootstrapDecision,
  GarrsStartConversationResult,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderFailure,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import { type CatalogInstance, selectModel } from "./GarrsModels.ts";
import * as GarrsStore from "./GarrsStore.ts";

const retryMessageId = (runId: RunId) => MessageId.make(`garrs-bootstrap:${runId}`);
const decodeStartup = Schema.decodeUnknownOption(
  Schema.fromJsonString(GarrsStartConversationResult),
);

function matchesAutomaticSelection(
  automatic: ModelSelection,
  requested: ModelSelection,
  catalog: ReadonlyArray<CatalogInstance>,
): boolean {
  if (automatic.instanceId !== requested.instanceId || automatic.model !== requested.model)
    return false;
  const instance = catalog.find((entry) => entry.instanceId === automatic.instanceId);
  const descriptors =
    instance?.modelDetails?.find((entry) => entry.slug === automatic.model)?.capabilities
      ?.optionDescriptors ?? [];
  const nativeDefaults =
    instance?.driver === "claudeAgent"
      ? compileClaudeModelSelection({ ...automatic, options: [] }).settings
      : undefined;
  const defaults = descriptors.flatMap((descriptor) => {
    const choices =
      descriptor.type === "select" ? descriptor.options.filter((choice) => choice.isDefault) : [];
    // Claude's compiler confirms Fast Mode off when omitted; an unknown boolean has no inferred default.
    const value =
      descriptor.type === "select"
        ? choices.length === 1 &&
          (descriptor.currentValue === undefined || descriptor.currentValue === choices[0]!.id)
          ? choices[0]!.id
          : undefined
        : descriptor.id === "fastMode"
          ? nativeDefaults?.fastMode
          : undefined;
    return value === undefined ? [] : [{ id: descriptor.id, value }];
  });
  const withDefaults = (selection: ModelSelection) => ({
    ...selection,
    options: [
      ...(selection.options ?? []),
      ...defaults.filter((option) => !selection.options?.some((entry) => entry.id === option.id)),
    ],
  });
  return modelSelectionsEqual(withDefaults(automatic), withDefaults(requested));
}

export const recoverRun = Effect.fn("GarrsBootstrap.recoverRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly catalog: ReadonlyArray<CatalogInstance>;
  readonly failures: ReadonlyArray<{
    readonly selection: ModelSelection;
    readonly at: string;
    readonly failure: OrchestrationV2ProviderFailure;
  }>;
}) {
  const store = yield* GarrsStore.GarrsStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const member = yield* store.getThread(input.threadId);
  if (member?.agentId !== "garras") return false;
  const projection = yield* threads.getThreadProjection(input.threadId);
  const history = yield* store.listBootstrapDecisions(input.threadId);
  const now = DateTime.formatIso(yield* DateTime.now);
  let changed = false;
  for (const entry of history) {
    if (
      entry.status !== "selected" ||
      !projection.messages.some((message) => message.id === retryMessageId(entry.runId))
    )
      continue;
    yield* store.saveBootstrapDecision(input.threadId, {
      ...entry,
      status: "queued",
      queuedAt: now,
    });
    changed = true;
  }
  const run = ThreadManagement.latestRun(projection);
  if (run?.status !== "failed" || (input.runId !== undefined && input.runId !== run.id))
    return changed;
  const error = projection.visibleTurnItems
    .map((entry) => entry.item)
    .findLast((item) => item.type === "error" && item.runId === run.id);
  if (error?.type !== "error" || error.failure.class !== "usage_limit") return changed;
  const previous = history.find((entry) => entry.runId === run.id);
  if (
    previous !== undefined &&
    (previous.status !== "selected" ||
      projection.messages.some((message) => message.id === retryMessageId(run.id)))
  )
    return changed;
  const startupReceipt = yield* store.getReceipt(
    `start-conversation:${input.threadId.slice("garras:".length)}:prepared`,
  );
  const startup = startupReceipt === null ? null : Option.getOrNull(decodeStartup(startupReceipt));
  const latestAutomatic = history.findLast(
    (entry) =>
      entry.decision?.source === "bootstrap" &&
      (entry.status === "queued" ||
        projection.messages.some((message) => message.id === retryMessageId(entry.runId))),
  )?.decision;
  const automaticSelection =
    latestAutomatic?.requested ??
    (startup?.threadId === input.threadId &&
    ["bootstrap", "automatic", "catalog_default", "project_override", "team_policy"].includes(
      startup.decision.source,
    )
      ? startup.decision.requested
      : null);
  const binding = (yield* store.getBinding(member.projectId)).binding;
  const config = (yield* store.getConfig()).config;
  const userMessageId =
    history.find((entry) => retryMessageId(entry.runId) === run.userMessageId)?.userMessageId ??
    run.userMessageId;
  const attemptsMade =
    1 +
    history.filter(
      (entry) =>
        entry.userMessageId === userMessageId && entry.decision !== null && entry.runId !== run.id,
    ).length;
  const maximum = Math.min(2, config.limits.maxAttemptsPerTask);
  const failures = [
    ...input.failures,
    ...history.map((entry) => ({
      selection: entry.failedSelection,
      at: entry.observedAt,
      failure: entry.failure,
    })),
    { selection: run.modelSelection, at: now, failure: error.failure },
  ];
  const selected = selectModel({
    agentId: "garras",
    pinned:
      previous?.decision == null
        ? null
        : {
            selection: previous.decision.requested,
            by: "coordinator",
            reason: previous.decision.reason,
          },
    projectOverrides: binding.modelOverrides,
    teamPolicy: config.modelPolicy,
    catalog: input.catalog,
    requirements: { readOnly: true },
    bootstrap: true,
    failures,
    now,
  });
  const reason =
    attemptsMade >= maximum
      ? `Garras bootstrap attempt limit (${maximum}) reached for this message.`
      : !binding.enabled
        ? "Garrs is disabled for this project."
        : automaticSelection === null
          ? "The active Garras selection cannot be verified as an automatic bootstrap; no automatic replacement was sent."
          : !matchesAutomaticSelection(automaticSelection, run.modelSelection, input.catalog)
            ? "The active Garras model, account or options differ from the last verified bootstrap. Automatic fallback could replace a manual selection, so no replacement was sent."
            : !selected.ok
              ? `Garras bootstrap is blocked: ${selected.reason}`
              : null;
  const decision: GarrsBootstrapDecision = {
    runId: run.id,
    userMessageId,
    failedSelection: run.modelSelection,
    failure: error.failure,
    observedAt: previous?.observedAt ?? now,
    attemptNumber: attemptsMade + 1,
    decision:
      reason !== null || !selected.ok
        ? null
        : {
            ...selected.decision,
            source: "bootstrap",
            fallbackUsed: true,
            candidates: selected.decision.candidates
              .filter(
                (candidate) =>
                  (candidate.selection.instanceId === run.modelSelection.instanceId &&
                    candidate.selection.model === run.modelSelection.model) ||
                  (candidate.selection.instanceId === selected.decision.requested.instanceId &&
                    candidate.selection.model === selected.decision.requested.model),
              )
              .slice(0, 8),
            reason:
              `Bootstrap recovery after provider-reported usage_limit from ${run.modelSelection.instanceId}/${run.modelSelection.model}. ${selected.decision.reason}`.slice(
                0,
                2_000,
              ),
          },
    status: reason === null ? "selected" : "blocked",
    reason: reason ?? "Alternative bootstrap model selected; T3 acceptance is pending.",
    queuedAt: null,
  };
  yield* store.saveBootstrapDecision(input.threadId, decision);
  if (decision.decision === null) return true;
  const request = projection.messages.find((message) => message.id === userMessageId);
  if (request === undefined) {
    yield* store.saveBootstrapDecision(input.threadId, {
      ...decision,
      status: "blocked",
      reason: "The original request is unavailable; automatic retry was not sent.",
    });
    return true;
  }
  yield* threads.sendToThread({
    projectId: member.projectId,
    threadId: input.threadId,
    commandId: CommandId.make(`garrs:bootstrap-retry:${run.id}`),
    messageId: retryMessageId(run.id),
    modelSelection: decision.decision.requested,
    mode: "auto",
    attachments: request.attachments,
    text: `The previous Garras run stopped with a provider-reported usage limit. This is the bounded automatic bootstrap retry on ${decision.decision.requested.instanceId}/${decision.decision.requested.model}. Check persisted Garrs status before continuing; preserve completed work.\nPending request:\n${request.text}`,
    createdBy: "system",
    creationSource: "server",
  });
  yield* store.saveBootstrapDecision(input.threadId, {
    ...decision,
    status: "queued",
    queuedAt: now,
    reason:
      "T3 accepted the bootstrap retry in this conversation; provider receipt and effective model are not confirmed.",
  });
  return true;
});
