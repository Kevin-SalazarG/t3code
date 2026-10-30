import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
  isOrchestrationV2WorkActive,
} from "@t3tools/contracts";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import {
  collectProviderUsageLimits,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { AsyncResult } from "effect/reactivity";
import {
  BotIcon,
  CalendarIcon,
  ClockIcon,
  CoinsIcon,
  GaugeIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useStableCallback } from "../../hooks/useStableCallback";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "../usage/usageProviders";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly environmentId: EnvironmentId;
  readonly providerThreadId: OrchestrationV2ProviderTurn["providerThreadId"] | null;
  readonly providerTurns: readonly OrchestrationV2ProviderTurn[];
  readonly subagents: readonly OrchestrationV2Subagent[];
  readonly settledRunId: RunId | null;
}

// The server caches Claude's account probe for five minutes, so polling faster only rereads it.
const LIMITS_REFRESH_MS = 60_000;

/** The selected instance's own limits and spend, plus the thread's context and prompt cache use. */
export function ThreadDetailsUsage({
  providerInstanceId,
  providers,
  sources,
  contextWindow,
  environmentId,
  providerThreadId,
  providerTurns,
  subagents,
  settledRunId,
}: ThreadDetailsUsageInput) {
  const cardRef = useRef<HTMLElement | null>(null);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  // The instance's own probe comes first so each login shows its own numbers; the merged report
  // only fills in accounts known solely through an external limits source.
  const limits =
    provider?.usageLimits ??
    (providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, now)?.accounts.find(
          (entry) => entry.instanceId === providerInstanceId,
        )?.limits
      : undefined);
  const refreshProviders = useStableCallback(
    useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false }),
  );
  const checkedAt = provider?.usageLimits?.checkedAt;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server for the selected account's limits while the card is open
  useEffect(() => {
    if (providerInstanceId === null) return;
    const refreshIfStale = () => {
      const age = checkedAt ? Date.now() - Date.parse(checkedAt) : Number.POSITIVE_INFINITY;
      if (age >= LIMITS_REFRESH_MS) {
        void refreshProviders({ environmentId, input: { instanceId: providerInstanceId } });
      }
    };
    refreshIfStale();
    const timer = window.setInterval(refreshIfStale, LIMITS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [environmentId, providerInstanceId, checkedAt, refreshProviders]);
  const notice = limits ? limitsNotice(limits) : null;
  const cacheHit = cacheHitPercent(contextWindow);
  const turnUsage = latestTurnUsages(providerTurns, providerThreadId);
  const growth =
    turnUsage.latest && turnUsage.previous
      ? turnUsage.latest.usedTokens - turnUsage.previous.usedTokens
      : null;
  const cacheExpiresAt = turnUsage.latest?.promptCacheExpiresAt
    ? Date.parse(turnUsage.latest.promptCacheExpiresAt)
    : Number.NaN;
  const cacheLeftMs = cacheExpiresAt > now ? cacheExpiresAt - now : null;
  const activeAgents = subagents.filter((agent) =>
    isOrchestrationV2WorkActive(agent.status),
  ).length;
  const driver = provider?.driver;
  // The cost scan reads local transcripts, so only sessions allowed to read diagnostics ask for it.
  const showCost =
    driver !== undefined &&
    usageKindOf(driver) !== null &&
    readEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  if (!limits && !contextWindow) return null;
  const kind = driver ? usageKindOf(driver) : null;
  const accountName =
    provider?.displayName ?? (kind ? PROVIDER_PRESENTATION[kind].label : null) ?? "Usage";

  return (
    <ThreadDetailsSection
      ref={cardRef}
      headingId="thread-details-usage-heading"
      title={accountName}
      titleTooltip
      actions={
        provider?.auth.label ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  className="block max-w-32 truncate text-2xs text-muted-foreground"
                />
              }
            >
              {provider.auth.label}
            </TooltipTrigger>
            <TooltipPopup anchor={cardRef} side="left" align="start" sideOffset={8}>
              {provider.auth.label}
            </TooltipPopup>
          </Tooltip>
        ) : undefined
      }
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {notice ? (
          <UsageRow
            icon={ClockIcon}
            label="Limits"
            left={null}
            value="Unavailable"
            tooltip={<span className="text-foreground">{notice}</span>}
          />
        ) : null}
        {limits && !notice
          ? limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)
          : null}
        {contextWindow ? (
          <ContextRow usage={contextWindow} growth={growth} spaced={limits !== undefined} />
        ) : null}
        {cacheHit !== null ? (
          <UsageRow
            icon={ZapIcon}
            label="Cache"
            left={cacheHit}
            muted
            toneless
            tooltip={
              <>
                <span className="text-foreground">
                  {cacheHit}% of input tokens were read from the prompt cache
                </span>
                {cacheLeftMs !== null ? (
                  <span className="text-muted-foreground">
                    Cache expires in {formatDuration(cacheLeftMs)}
                  </span>
                ) : null}
                {turnUsage.latest?.outputTokens !== undefined ? (
                  <span className="text-muted-foreground">
                    Last turn: {formatContextWindowTokens(turnUsage.latest.outputTokens)} output
                    {turnUsage.latest.reasoningOutputTokens
                      ? `, ${formatContextWindowTokens(turnUsage.latest.reasoningOutputTokens)} reasoning`
                      : ""}{" "}
                    tokens
                  </span>
                ) : null}
              </>
            }
          />
        ) : null}
        {showCost && provider ? (
          <TodayCostRow
            environmentId={environmentId}
            provider={provider}
            providers={providers}
            settledRunId={settledRunId}
          />
        ) : null}
        {activeAgents > 0 ? (
          <UsageRow
            icon={BotIcon}
            label="Agents"
            left={null}
            value={`${activeAgents} running`}
            tooltip={
              <span className="text-foreground">
                {activeAgents} {activeAgents === 1 ? "subagent is" : "subagents are"} working in
                this thread
              </span>
            }
          />
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

function usageKindOf(driver: ProviderDriverKind) {
  return PROVIDER_ORDER.find((kind) => PROVIDER_PRESENTATION[kind].driverKind === driver) ?? null;
}

/** The two newest reports on the active provider thread, so growth never spans a provider switch. */
function latestTurnUsages(
  turns: readonly OrchestrationV2ProviderTurn[],
  providerThreadId: OrchestrationV2ProviderTurn["providerThreadId"] | null,
) {
  let latest: NonNullable<OrchestrationV2ProviderTurn["tokenUsage"]> | null = null;
  let previous: NonNullable<OrchestrationV2ProviderTurn["tokenUsage"]> | null = null;
  for (const turn of turns) {
    const usage = turn.tokenUsage;
    if (usage === undefined || turn.providerThreadId !== providerThreadId) continue;
    if (latest === null || Date.parse(usage.updatedAt) >= Date.parse(latest.updatedAt)) {
      previous = latest;
      latest = usage;
    } else if (previous === null || Date.parse(usage.updatedAt) >= Date.parse(previous.updatedAt)) {
      previous = usage;
    }
  }
  return { latest, previous };
}

function isWithinHome(path: string | undefined, home: string | undefined) {
  return path !== undefined && home !== undefined && (path === home || path.startsWith(`${home}/`));
}

/**
 * Today's estimated spend for this instance, from the same transcript scan as Settings → Usage.
 * Buckets carry the transcript directory, so each login's home separates its spend.
 */
function TodayCostRow({
  environmentId,
  provider,
  providers,
  settledRunId,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly providers: readonly ServerProvider[];
  readonly settledRunId: RunId | null;
}) {
  const input = makeWindow(1);
  const result = useAtomValue(serverEnvironment.usageSummary({ environmentId, input }));
  const refreshSummary = useStableCallback(() => {
    appAtomRegistry.refresh(
      serverEnvironment.usageSummary({ environmentId, input: makeWindow(1) }),
    );
  });
  const version = JSON.stringify([provider.instanceId, settledRunId]);
  const previousVersion = useRef(version);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rescans transcripts once a turn settles; mid-turn token reports would rescan every few seconds
  useEffect(() => {
    if (previousVersion.current === version) return;
    previousVersion.current = version;
    const timer = window.setTimeout(refreshSummary, 1_000);
    return () => window.clearTimeout(timer);
  }, [refreshSummary, version]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes transcript usage from other threads while the card is visible
  useEffect(() => {
    const timer = window.setInterval(refreshSummary, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshSummary]);
  const summary = AsyncResult.getOrElse(result, () => null);
  const kind = usageKindOf(provider.driver);
  if (summary === null || kind === null) return null;
  const home = provider.runtimePaths?.homePath;
  const otherHomes = providers
    .filter((other) => other.driver === provider.driver && other.instanceId !== provider.instanceId)
    .flatMap((other) => (other.runtimePaths ? [other.runtimePaths.homePath] : []));
  const buckets = summary.buckets.filter(
    (bucket) =>
      bucket.provider === kind &&
      (home !== undefined
        ? isWithinHome(bucket.sourcePath, home)
        : !otherHomes.some((other) => isWithinHome(bucket.sourcePath, other))),
  );
  if (buckets.length === 0) return null;
  const cost = buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0);
  const unpriced = buckets.some((bucket) => bucket.costSource === "unpriced");
  return (
    <UsageRow
      icon={CoinsIcon}
      label="Today"
      left={null}
      className="mt-2"
      value={`≈ ${formatUsd(cost)}`}
      tooltip={
        <>
          <span className="text-foreground">
            {provider.displayName ?? PROVIDER_PRESENTATION[kind].label} today: ≈ {formatUsd(cost)}
          </span>
          <span className="text-muted-foreground">
            Estimated from local transcripts{unpriced ? "; some models have no price" : ""}
          </span>
        </>
      }
    />
  );
}

function cacheHitPercent(usage: ContextWindowSnapshot | null): number | null {
  const input = usage?.lastInputTokens ?? usage?.inputTokens ?? null;
  const cached = usage?.lastCachedInputTokens ?? usage?.cachedInputTokens ?? null;
  if (input === null || cached === null || input <= 0) return null;
  return Math.round(Math.min(100, (cached / input) * 100));
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      icon={window.kind === "session" ? ClockIcon : CalendarIcon}
      label={window.label}
      left={left}
      warn={pace === "ahead"}
      tooltip={
        <>
          <span className="text-foreground">
            {window.label}: {left}% left
          </span>
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              Resets in {formatDuration(resetsAt - now)} ·{" "}
              {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            </span>
          ) : null}
          {pace ? <span className="text-muted-foreground">{PACE_LABEL[pace]}</span> : null}
        </>
      }
    />
  );
}

function ContextRow({
  usage,
  growth,
  spaced,
}: {
  readonly usage: ContextWindowSnapshot;
  readonly growth: number | null;
  readonly spaced: boolean;
}) {
  const maxTokens = usage.maxTokens ?? null;
  const left =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(100 - Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const used = formatContextWindowTokens(usage.usedTokens);
  return (
    <UsageRow
      icon={GaugeIcon}
      label="Context"
      left={left}
      muted
      className={cn(spaced && "mt-2")}
      tooltip={
        <>
          {left !== null ? <span className="text-foreground">Context: {left}% left</span> : null}
          <span className={left !== null ? "text-muted-foreground" : "text-foreground"}>
            {maxTokens !== null
              ? `${used} of ${formatContextWindowTokens(maxTokens)} tokens used`
              : `${used} tokens used`}
          </span>
          {growth !== null && growth !== 0 ? (
            <span className="text-muted-foreground">
              {growth > 0 ? "Grew" : "Shrank"} {formatContextWindowTokens(Math.abs(growth))} since
              the previous turn
            </span>
          ) : null}
        </>
      }
      value={left === null ? used : undefined}
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. */
function UsageRow({
  icon: Icon,
  label,
  left,
  tooltip,
  value,
  muted = false,
  toneless = false,
  warn = false,
  className,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly left: number | null;
  readonly tooltip: ReactNode;
  /** Replaces the percentage when there is none. */
  readonly value?: string | undefined;
  readonly muted?: boolean;
  /** For rows where a short bar is not a shortage, such as cache hits. */
  readonly toneless?: boolean;
  /** Warns before the threshold, such as a window being spent faster than it resets. */
  readonly warn?: boolean;
  readonly className?: string | undefined;
}) {
  const tone =
    left === null || toneless ? null : left <= 10 ? "error" : left <= 30 || warn ? "warning" : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`${label}: ${value ?? `${left}% left`}`}
            className={cn(
              "col-span-3 grid h-6 cursor-default grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]",
              className,
            )}
          />
        }
      >
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="max-w-28 truncate">{label}</span>
        </span>
        {left !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {left > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${left}%, 6px)` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            left === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : left === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value ?? `${left}%`}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
