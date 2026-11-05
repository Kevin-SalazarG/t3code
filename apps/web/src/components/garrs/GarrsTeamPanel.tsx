import { PreparationEvidence, VerificationEvidence } from "./GarrsEvidence";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  GarrsAgentId,
  GarrsAgentStatus,
  GarrsArtifact,
  GarrsAttempt,
  GarrsBootstrapDecision,
  GarrsMessage,
  GarrsModelDecision,
  GarrsPlanRevision,
  GarrsReview,
  GarrsTask,
  GarrsWorkItemId,
  GarrsWorkItemSummary,
  ModelSelection,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleIcon,
  GitCommitHorizontalIcon,
  ListChecksIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  SettingsIcon,
  UploadIcon,
  UsersRoundIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { InlinePatch } from "../chat/InlineToolDiff";
import { ExpandableText } from "../settings/ExpandableText";
import { useThreadShell } from "../../state/entities";
import { garrsEnvironment } from "../../state/garrs";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  attemptIsStoppable,
  formatCount,
  formatDurationMs,
  humanize,
  reportedModelsLabel,
  shortHash,
  taskIsReassignable,
  taskIsRetryable,
  workItemControls,
} from "./garrs.logic";
import { GarrsModelPicker, useGarrsInstanceEntries } from "./GarrsModelPicker";
import { GarrsDecisionDetails } from "./GarrsDecisionDetails";
import { GarrsBootstrapHistory } from "./GarrsBootstrapHistory";
import { GarrsProviderCost } from "./GarrsProviderCost";
import { newGarrsCommandId, toastCommandFailure, useGarrsControl } from "./useGarrsCommand";

// ── Status ──────────────────────────────────────────────────────────────────

type StatusTone = "success" | "error" | "warning" | "working" | "neutral";

const STATE_TONES: Readonly<Record<string, StatusTone>> = Object.fromEntries([
  ...[
    "accepted",
    "delivered",
    "ready_to_deliver",
    "completed",
    "succeeded",
    "approved",
    "verified",
    "valid",
    "committed",
    "pushed",
  ].map((state) => [state, "success" as const]),
  ...["failed", "blocked", "changes_requested", "invalidated", "dropped", "rejected"].map(
    (state) => [state, "error" as const],
  ),
  ...[
    "awaiting_approval",
    "paused",
    "waiting",
    "waiting_dependency",
    "waiting_response",
    "waiting_authorization",
    "needs_changes",
    "cancel_requested",
    "unverifiable",
    "proposed",
  ].map((state) => [state, "warning" as const]),
  ...[
    "planning",
    "active",
    "running",
    "starting",
    "preparing",
    "launching",
    "working",
    "in_review",
    "report_received",
  ].map((state) => [state, "working" as const]),
]);

const TONE_PRESENTATION = {
  success: { Icon: CircleCheckIcon, className: "text-success-foreground" },
  error: { Icon: CircleAlertIcon, className: "text-destructive-foreground" },
  warning: { Icon: CircleDotDashedIcon, className: "text-warning-foreground" },
  working: { Icon: CircleDashedIcon, className: "text-info-foreground" },
  neutral: { Icon: CircleIcon, className: "text-muted-foreground" },
} as const;

function StatusIcon({ state, className }: { readonly state: string; readonly className?: string }) {
  const { Icon, className: tone } = TONE_PRESENTATION[STATE_TONES[state] ?? "neutral"];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", tone, className)} />;
}

function StatusLabel({ state }: { readonly state: string }) {
  const tone = TONE_PRESENTATION[STATE_TONES[state] ?? "neutral"].className;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", tone)}>
      <StatusIcon state={state} className="size-3" />
      {humanize(state)}
    </span>
  );
}

// ── Shared pieces ───────────────────────────────────────────────────────────

function selectionLabel(selection: ModelSelection): string {
  return `${selection.instanceId} · ${selection.model}`;
}

function Muted({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <p className={cn("text-xs text-muted-foreground", className)}>{children}</p>;
}

/** A sidebar-style section that folds, with an optional trailing count. */
function Section({
  title,
  count,
  defaultExpanded = true,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly defaultExpanded?: boolean;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <section>
      <CollapsibleSectionHeader
        variant="panel"
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        accessory={
          count === undefined ? undefined : (
            <span className="text-2xs tabular-nums text-muted-foreground">{count}</span>
          )
        }
      >
        {title}
      </CollapsibleSectionHeader>
      {expanded ? <div className="pb-2">{children}</div> : null}
    </section>
  );
}

const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** A disclosure for secondary detail: a quiet trigger line, content below it. */
function Disclosure({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-xs text-muted-foreground hover:text-foreground">
        {label}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-2">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function useAgentNames(environmentId: EnvironmentId) {
  const config = useEnvironmentQuery(garrsEnvironment.config({ environmentId, input: {} }));
  const profiles = new Map(
    (config.data?.config.profiles ?? []).map((profile) => [profile.agentId, profile]),
  );
  const name = (agentId: GarrsAgentId | "user" | "system") =>
    agentId === "user" || agentId === "system"
      ? humanize(agentId)
      : (profiles.get(agentId)?.displayName ?? humanize(agentId));
  const description = (agentId: GarrsAgentId) => profiles.get(agentId)?.description ?? null;
  return { name, description };
}

function useOpenThread(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  return (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };
}

// ── Panel ───────────────────────────────────────────────────────────────────

/** The Garrs tab of a thread's right panel. */
export function GarrsPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useThreadShell(threadRef);
  if (shell === null) return null;
  return (
    <GarrsTeamPanel
      environmentId={threadRef.environmentId}
      projectId={shell.projectId}
      currentThreadId={threadRef.threadId}
    />
  );
}

function GarrsTeamPanel({
  environmentId,
  projectId,
  currentThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly currentThreadId: ThreadId;
}) {
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<GarrsWorkItemId | null>(null);
  const stateQuery = useEnvironmentQuery(
    garrsEnvironment.projectLive({ environmentId, input: { projectId } }),
  );
  const agents = useAgentNames(environmentId);
  const openThread = useOpenThread(environmentId);
  const navigate = useNavigate();
  const state = stateQuery.data;

  if (selectedWorkItemId !== null) {
    return (
      <GarrsWorkItemDetailView
        environmentId={environmentId}
        workItemId={selectedWorkItemId}
        agentName={agents.name}
        onOpenThread={openThread}
        onBack={() => setSelectedWorkItemId(null)}
      />
    );
  }
  if (state === null) {
    return (
      <Empty size="compact">
        <EmptyDescription>
          {stateQuery.error ? `Could not load the team: ${stateQuery.error}` : "Loading the team…"}
        </EmptyDescription>
      </Empty>
    );
  }
  if (!state.enabled) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersRoundIcon />
          </EmptyMedia>
          <EmptyTitle>Garrs is off for this project</EmptyTitle>
          <EmptyDescription>
            Turn it on to let Garras plan work and coordinate the team.
          </EmptyDescription>
        </EmptyHeader>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void navigate({ to: "/settings/garrs" })}
        >
          <SettingsIcon />
          Open Garrs settings
        </Button>
      </Empty>
    );
  }

  const start = (
    <GarrsStartButton
      environmentId={environmentId}
      projectId={projectId}
      unavailableReason={
        stateQuery.error ? "Team status is out of date. Reconnect before starting Garras." : null
      }
      onOpenThread={openThread}
    />
  );
  // Work started from the open Garras conversation leads the list.
  const workItems = state.workItems.toSorted(
    (left, right) =>
      Number(right.garrasThreadId === currentThreadId) -
      Number(left.garrasThreadId === currentThreadId),
  );
  const members = state.agents.filter((agent) => agent.agentId !== "garras");
  const busy = members.filter((agent) => STATE_TONES[agent.state] === "working").length;
  const open = workItems.filter(
    (item) => !["accepted", "delivered", "cancelled", "failed"].includes(item.status),
  ).length;

  if (state.garrasThreadIds.length === 0 && workItems.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersRoundIcon />
          </EmptyMedia>
          <EmptyTitle>No team work yet</EmptyTitle>
          <EmptyDescription>
            Start a conversation with Garras and describe what you need. Garras plans the work and
            hands it to the team.
          </EmptyDescription>
        </EmptyHeader>
        {start}
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {stateQuery.error ? (
        <p
          role="alert"
          className="border-b border-border/60 px-3 py-1.5 text-xs text-destructive-foreground"
        >
          Team status may be out of date: {stateQuery.error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {workItems.length > 0 ? (
          <Section title="Work" count={workItems.length}>
            <ul>
              {workItems.map((item) => (
                <WorkItemRow
                  key={item.id}
                  item={item}
                  current={item.garrasThreadId === currentThreadId}
                  onSelect={() => setSelectedWorkItemId(item.id)}
                />
              ))}
            </ul>
          </Section>
        ) : null}
        <Section title="Team" count={members.length}>
          <ul>
            {members.map((agent) => (
              <AgentRow
                key={agent.agentId}
                agent={agent}
                name={agents.name(agent.agentId)}
                description={agents.description(agent.agentId)}
                onOpenThread={openThread}
              />
            ))}
          </ul>
        </Section>
        {state.garrasThreadIds.length > 0 ? (
          <Section title="Garras conversations" count={state.garrasThreadIds.length}>
            <ul>
              {state.garrasThreadIds.map((threadId) => {
                const conversation = state.garrasConversations?.find(
                  (entry) => entry.threadId === threadId,
                );
                return (
                  <GarrasThreadRow
                    key={threadId}
                    environmentId={environmentId}
                    threadId={threadId}
                    current={threadId === currentThreadId}
                    decision={conversation?.decision}
                    bootstrapDecisions={conversation?.bootstrapDecisions}
                    onOpen={() => openThread(threadId)}
                  />
                );
              })}
            </ul>
          </Section>
        ) : null}
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>
          {open} open · {workItems.length} work items · {busy} working
        </span>
        {start}
      </footer>
    </div>
  );
}

function GarrsStartButton({
  environmentId,
  projectId,
  unavailableReason,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly unavailableReason: string | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const canStart = useAtomValue(garrsEnvironment.startConversation.permissionAtom(environmentId));
  const start = useAtomCommand(garrsEnvironment.startConversation, {
    label: "garrs start conversation",
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const disabledReason =
    unavailableReason ??
    (!canStart ? "This connection lacks permission to run agents in this environment." : null);
  const onStart = async () => {
    if (disabledReason !== null || pending) return;
    setPending(true);
    const result = await start({
      environmentId,
      input: { commandId: newGarrsCommandId(), projectId },
    });
    setPending(false);
    if (result._tag === "Failure") {
      toastCommandFailure("Could not start Garras", result);
      return;
    }
    const { decision, threadId } = result.value;
    toastManager.add({
      type: "success",
      title: `Garras started on ${selectionLabel(decision.requested)}`,
      description: `${humanize(decision.source)}${decision.fallbackUsed ? " (fallback)" : ""}: ${decision.reason}`,
    });
    onOpenThread(threadId);
  };
  const button = (
    <Button
      size="xs"
      variant="ghost"
      disabled={disabledReason !== null || pending}
      onClick={() => void onStart()}
    >
      <MessageSquarePlusIcon />
      Start Garras
    </Button>
  );
  if (disabledReason === null) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} />}>{button}</TooltipTrigger>
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  );
}

function WorkItemRow({
  item,
  current,
  onSelect,
}: {
  readonly item: GarrsWorkItemSummary;
  readonly current: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <li>
      <button type="button" onClick={onSelect} className={cn(ROW_CLASS, "items-start")}>
        <StatusIcon state={item.status} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-sm">{item.title}</span>
            {current ? (
              <span className="shrink-0 text-2xs text-muted-foreground">· this chat</span>
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="truncate">
              {humanize(item.status)} · {item.access === "write" ? "Writes" : "Read only"} ·{" "}
              {item.completedTaskCount}/{item.taskCount} tasks
            </span>
            <span className="ml-auto shrink-0 tabular-nums">
              <RelativeTime timestamp={item.updatedAt} />
            </span>
          </span>
          {item.statusReason ? (
            <span className="block truncate text-xs text-muted-foreground">
              {item.statusReason}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function AgentRow({
  agent,
  name,
  description,
  onOpenThread,
}: {
  readonly agent: GarrsAgentStatus;
  readonly name: string;
  readonly description: string | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const threadId = agent.threadId;
  const detail =
    agent.taskTitle ??
    (agent.waitingFor ? `Waiting for ${agent.waitingFor}` : null) ??
    description ??
    null;
  const content = (
    <>
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium text-foreground/80"
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{name}</span>
        {detail ? (
          <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        ) : null}
        {agent.selection ? (
          <span className="block truncate font-mono text-2xs text-muted-foreground/80">
            {selectionLabel(agent.selection)}
          </span>
        ) : null}
      </span>
      <StatusLabel state={agent.state} />
    </>
  );
  return (
    <li>
      {threadId ? (
        <button
          type="button"
          className={ROW_CLASS}
          aria-label={`Open ${name}'s thread`}
          onClick={() => onOpenThread(threadId)}
        >
          {content}
        </button>
      ) : (
        <div className={cn(ROW_CLASS, "hover:bg-transparent")}>{content}</div>
      )}
    </li>
  );
}

function GarrasThreadRow({
  environmentId,
  threadId,
  current,
  decision,
  bootstrapDecisions,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly current: boolean;
  readonly decision?: GarrsModelDecision | undefined;
  readonly bootstrapDecisions?: ReadonlyArray<GarrsBootstrapDecision> | undefined;
  readonly onOpen: () => void;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const latestDecision =
    bootstrapDecisions?.findLast((entry) => entry.decision !== null)?.decision ?? decision;
  const state =
    shell?.source.activityRunStatus ??
    (shell?.source.pendingRuntimeRequest
      ? "waiting"
      : shell?.source.lastError
        ? "blocked"
        : "idle");
  return (
    <li className="space-y-1">
      <button
        type="button"
        className={ROW_CLASS}
        disabled={current}
        onClick={onOpen}
        aria-current={current ? "page" : undefined}
      >
        <StatusIcon state={state} className="mt-0.5 self-start" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{shell?.title ?? "Garras conversation"}</span>
          {latestDecision ? (
            <span className="block truncate font-mono text-2xs text-muted-foreground/80">
              {selectionLabel(latestDecision.requested)}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {current ? "This chat" : shell ? <RelativeTime timestamp={shell.updatedAt} /> : null}
        </span>
      </button>
      {latestDecision || (bootstrapDecisions?.length ?? 0) > 0 ? (
        <div className="-mt-1 space-y-1 ps-7.5 pe-2 pb-1">
          {latestDecision ? (
            <Disclosure label="Why this model">
              <GarrsDecisionDetails decision={latestDecision} showEffectiveModel={false} />
              <Muted className="pt-2">
                This starts Garras; the team receives separate model decisions for each task.
              </Muted>
            </Disclosure>
          ) : null}
          <GarrsBootstrapHistory decisions={bootstrapDecisions ?? []} />
        </div>
      ) : null}
    </li>
  );
}

const COMMIT_TITLES: Readonly<Record<string, string>> = {
  proposed: "Kex proposes a commit",
  committed: "Commit created",
  failed: "Commit failed",
};

// ── Work item detail ────────────────────────────────────────────────────────

type TextDialogState =
  | { readonly type: "cancel" }
  | { readonly type: "waive_review" }
  | { readonly type: "authorize" };

/** Splits a multi-file unified diff so each file gets its own heading. */
function patchFiles(
  diff: string,
): ReadonlyArray<{ readonly path: string; readonly patch: string }> {
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.trim().length > 0);
  return chunks.map((chunk) => ({
    path: /^diff --git a\/(.+?) b\//.exec(chunk)?.[1] ?? "Changes",
    patch: chunk,
  }));
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </>
  );
}

function Facts({ children }: { readonly children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">{children}</dl>
  );
}

function GarrsWorkItemDetailView({
  environmentId,
  workItemId,
  agentName,
  onOpenThread,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  readonly workItemId: GarrsWorkItemId;
  readonly agentName: (agentId: GarrsAgentId | "user" | "system") => string;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onBack: () => void;
}) {
  const detailQuery = useEnvironmentQuery(
    garrsEnvironment.workItemLive({ environmentId, input: { workItemId } }),
  );
  const { canControl, canApproveGit, pending, run } = useGarrsControl(environmentId, workItemId);
  const [textDialog, setTextDialog] = useState<TextDialogState | null>(null);
  const [reassigning, setReassigning] = useState<GarrsTask | null>(null);
  const detail = detailQuery.data;
  const backButton = (
    <Button size="icon-xs" variant="ghost" aria-label="Back to the team" onClick={onBack}>
      <ChevronLeftIcon />
    </Button>
  );
  if (detail === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-1 border-b border-border/60 px-1.5 py-1">
          {backButton}
          <span className="text-sm text-muted-foreground">Work item</span>
        </header>
        <Empty size="compact">
          <EmptyDescription>
            {detailQuery.error ? `Could not load: ${detailQuery.error}` : "Loading work item…"}
          </EmptyDescription>
        </Empty>
      </div>
    );
  }
  const { workItem } = detail;
  const projectContexts = [
    ...(workItem.workspace === null
      ? []
      : [
          {
            projectId: workItem.projectId,
            bindingRevision: workItem.bindingRevision,
            rules: workItem.rules,
            workspace: workItem.workspace,
          },
        ]),
    ...(workItem.projectContexts ?? []).filter(
      (context) => context.projectId !== workItem.projectId,
    ),
  ];
  const controls = workItemControls(workItem.status);
  const disabled = !canControl || pending || detailQuery.error !== null;
  const awaitingPlan = detail.plans.find((plan) => plan.status === "awaiting_approval");
  const activePlan = detail.plans.find((plan) => plan.status === "active");
  const attemptsByTask = new Map<GarrsTask["id"], GarrsAttempt[]>();
  for (const attempt of detail.attempts) {
    const list = attemptsByTask.get(attempt.taskId);
    if (list) list.push(attempt);
    else attemptsByTask.set(attempt.taskId, [attempt]);
  }
  const commit = workItem.commitProposal;
  const push = workItem.pushProposal;
  const hasMenuControls =
    controls.pause ||
    controls.resume ||
    controls.authorize ||
    controls.waiveReview ||
    controls.cancel;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border/60 px-1.5 py-1">
        {backButton}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{workItem.title}</h2>
        <StatusLabel state={workItem.status} />
        {controls.accept ? (
          <Button size="xs" disabled={disabled} onClick={() => void run({ type: "accept" })}>
            Accept
          </Button>
        ) : null}
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost" aria-label="Work item actions" />}
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => onOpenThread(workItem.garrasThreadId)}>
              Open Garras conversation
            </MenuItem>
            {hasMenuControls ? <MenuSeparator /> : null}
            {controls.pause ? (
              <MenuItem disabled={disabled} onClick={() => void run({ type: "pause" })}>
                Pause
              </MenuItem>
            ) : null}
            {controls.resume ? (
              <MenuItem
                disabled={disabled || workItem.resumeRequested === true}
                onClick={() => void run({ type: "resume" })}
              >
                Resume
              </MenuItem>
            ) : null}
            {controls.authorize ? (
              <MenuItem disabled={disabled} onClick={() => setTextDialog({ type: "authorize" })}>
                Authorize…
              </MenuItem>
            ) : null}
            {controls.waiveReview ? (
              <MenuItem disabled={disabled} onClick={() => setTextDialog({ type: "waive_review" })}>
                Waive review…
              </MenuItem>
            ) : null}
            {controls.cancel ? (
              <MenuItem
                variant="destructive"
                disabled={disabled}
                onClick={() => setTextDialog({ type: "cancel" })}
              >
                Cancel work item…
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        {detailQuery.error ? (
          <Alert variant="error">
            <CircleAlertIcon />
            <AlertDescription>
              Work status may be out of date. Controls are disabled: {detailQuery.error}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-1.5">
          <Muted>
            {humanize(workItem.intent)} · {workItem.access === "write" ? "Writes" : "Read only"} ·
            revision {workItem.revision} · {workItem.correctionCycles}{" "}
            {workItem.correctionCycles === 1 ? "correction cycle" : "correction cycles"}
          </Muted>
          {workItem.statusReason ? <Muted>{workItem.statusReason}</Muted> : null}
          <ExpandableText
            text={workItem.objective}
            className="text-sm"
            expandLabel="Show the full objective"
          />
        </div>

        {workItem.resumeRequested ? (
          <Alert>
            <AlertTitle>Continuation recorded</AlertTitle>
            <AlertDescription>
              Waiting for pending stops to finish. The existing plan continues automatically within
              its limits.
            </AlertDescription>
          </Alert>
        ) : null}

        {awaitingPlan ? (
          <Alert variant="warning">
            <ListChecksIcon />
            <AlertTitle>Plan revision {awaitingPlan.revision} needs your approval</AlertTitle>
            <AlertDescription>
              Approving runs exactly this revision. Garras cannot change it under you.
            </AlertDescription>
            <AlertAction>
              <Button
                size="xs"
                disabled={disabled}
                onClick={() => void run({ type: "approve_plan", planId: awaitingPlan.id })}
              >
                Approve plan
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {commit ? (
          <Alert variant={commit.status === "proposed" ? "warning" : "default"}>
            <GitCommitHorizontalIcon />
            <AlertTitle>
              {COMMIT_TITLES[commit.status] ?? `Commit ${humanize(commit.status).toLowerCase()}`}
            </AlertTitle>
            <AlertDescription>
              <span className="block font-mono text-xs">{commit.message}</span>
              {commit.failureReason ? (
                <span className="block text-destructive-foreground">{commit.failureReason}</span>
              ) : null}
              {commit.status === "proposed" ? (
                <span className="block">
                  Approval creates this commit in the isolated checkout. Pushing needs separate
                  approval.
                </span>
              ) : null}
            </AlertDescription>
            {commit.status === "proposed" ? (
              <AlertAction>
                <Button
                  size="xs"
                  disabled={disabled || !canApproveGit || !commit.diff}
                  onClick={() => void run({ type: "approve_commit", proposalId: commit.id })}
                >
                  Approve commit
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        ) : null}

        {push ? (
          <Alert variant={push.status === "proposed" ? "warning" : "default"}>
            <UploadIcon />
            <AlertTitle>
              {push.status === "proposed"
                ? `Push to ${push.remote}`
                : push.status === "pushed"
                  ? `Pushed to ${push.remote}`
                  : `Push ${humanize(push.status).toLowerCase()}`}
            </AlertTitle>
            <AlertDescription>
              <span className="block break-all font-mono text-xs">
                {shortHash(push.commitSha)} → {push.branchRef}
              </span>
              <span className="block">You asked: “{push.userRequest.quote}”</span>
              {push.failureReason ? (
                <span className="block text-destructive-foreground">{push.failureReason}</span>
              ) : null}
            </AlertDescription>
            {push.status === "proposed" ? (
              <AlertAction>
                <Button
                  size="xs"
                  disabled={disabled || !canApproveGit}
                  onClick={() => void run({ type: "approve_push", proposalId: push.id })}
                >
                  Approve push
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        ) : null}

        {detail.remaining.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Before delivery</p>
            <ul className="space-y-1">
              {detail.remaining.map((entry) => (
                <li key={entry} className="flex items-start gap-2 text-xs">
                  <CircleDotDashedIcon
                    aria-hidden
                    className="mt-0.5 size-3 shrink-0 text-warning-foreground"
                  />
                  <span className="min-w-0">{entry}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="-mx-1.5">
          {awaitingPlan ? (
            <Section title={`Plan · revision ${awaitingPlan.revision}`}>
              <PlanView plan={awaitingPlan} agentName={agentName} projectId={workItem.projectId} />
            </Section>
          ) : activePlan ? (
            <Section title={`Plan · revision ${activePlan.revision}`} defaultExpanded={false}>
              <PlanView plan={activePlan} agentName={agentName} projectId={workItem.projectId} />
            </Section>
          ) : null}

          <Section title="Tasks" count={detail.tasks.length}>
            {detail.tasks.length === 0 ? (
              <Muted className="px-2">No tasks yet.</Muted>
            ) : (
              <ul>
                {detail.tasks.map((task) => (
                  <TaskItem
                    key={task.id}
                    task={task}
                    attempts={attemptsByTask.get(task.id) ?? []}
                    agentName={agentName}
                    disabled={disabled}
                    onRetry={() => void run({ type: "retry_task", taskId: task.id })}
                    onReassign={() => setReassigning(task)}
                    onStopAttempt={(attemptId) => void run({ type: "stop_attempt", attemptId })}
                    onOpenThread={onOpenThread}
                  />
                ))}
              </ul>
            )}
          </Section>

          {commit ? (
            <Section title="Staged changes" defaultExpanded={commit.status === "proposed"}>
              <div className="space-y-2 px-2">
                {commit.diff ? (
                  patchFiles(commit.diff).map((file) => (
                    <div key={file.path} className="space-y-1">
                      <p className="truncate font-mono text-2xs text-muted-foreground">
                        {file.path}
                      </p>
                      <InlinePatch patch={file.patch} />
                    </div>
                  ))
                ) : (
                  <Muted>
                    The complete staged diff is unavailable; this commit cannot be approved.
                  </Muted>
                )}
                <Disclosure label="Commit details">
                  <Facts>
                    <Fact label="Project">{commit.projectId}</Fact>
                    <Fact label="Checkout">{commit.checkoutPath}</Fact>
                    <Fact label="Branch">{commit.branchRef}</Fact>
                    <Fact label="Parent">{commit.parentSha}</Fact>
                    <Fact label="Staged tree">{commit.treeSha}</Fact>
                    <Fact label="Reviewed state">{commit.reviewSubjectHash}</Fact>
                  </Facts>
                </Disclosure>
                {push ? (
                  <Disclosure label="Push details">
                    <Facts>
                      <Fact label="Commit">{push.commitSha}</Fact>
                      <Fact label="Remote">
                        {push.remote} · {push.destination}
                      </Fact>
                      <Fact label="Branch">{push.branchRef}</Fact>
                      <Fact label="Remote commit">{push.expectedRemoteSha ?? "New branch"}</Fact>
                    </Facts>
                  </Disclosure>
                ) : null}
              </div>
            </Section>
          ) : null}

          {detail.reviews.length > 0 ? (
            <Section title="Reviews" count={detail.reviews.length}>
              <ul className="space-y-2 px-2">
                {detail.reviews.map((review) => (
                  <ReviewItem key={review.id} review={review} agentName={agentName} />
                ))}
              </ul>
            </Section>
          ) : null}

          {(detail.preparation?.length ?? 0) > 0 ? (
            <Section title="Checkout preparation" defaultExpanded={false}>
              <div className="px-2">
                <PreparationEvidence checks={detail.preparation ?? []} />
              </div>
            </Section>
          ) : null}

          {detail.artifacts.length > 0 ? (
            <Section title="Results" count={detail.artifacts.length}>
              <ul className="space-y-2 px-2">
                {detail.artifacts.map((artifact) => (
                  <ArtifactItem
                    key={artifact.id}
                    artifact={artifact}
                    agentName={agentName}
                    historical={
                      detail.tasks.find((task) => task.id === artifact.taskId)?.status ===
                      "cancelled"
                    }
                  />
                ))}
              </ul>
            </Section>
          ) : null}

          {detail.messages.length > 0 ? (
            <Section title="Messages" count={detail.messages.length} defaultExpanded={false}>
              <ul className="space-y-3 px-2">
                {detail.messages.map((message) => (
                  <MessageItem key={message.id} message={message} agentName={agentName} />
                ))}
              </ul>
            </Section>
          ) : null}

          {projectContexts.length > 0 ? (
            <Section title="Checkouts and rules" defaultExpanded={false}>
              <ul className="space-y-3 px-2">
                {projectContexts.map((context) => (
                  <li key={context.projectId} className="space-y-1">
                    <Facts>
                      <Fact label="Project">{context.projectId}</Fact>
                      <Fact label={context.workspace.isolated ? "Isolated checkout" : "Checkout"}>
                        {context.workspace.checkoutPath ?? "Preparing"}
                      </Fact>
                      <Fact label="Base">{context.workspace.baseSha ?? "Unknown"}</Fact>
                      <Fact label="Settings revision">{context.bindingRevision}</Fact>
                    </Facts>
                    <ul className="space-y-0.5">
                      {context.rules.map((rule) => (
                        <li key={rule.path} className="flex items-center gap-1.5 text-xs">
                          <StatusIcon state={rule.status} className="size-3" />
                          <span className="font-mono">{rule.path}</span>
                          <span className="text-muted-foreground">{humanize(rule.status)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {detail.activity.length > 0 ? (
            <Section title="Activity" count={detail.activity.length} defaultExpanded={false}>
              <ul className="space-y-1 px-2 text-xs">
                {detail.activity.toReversed().map((entry) => (
                  <li key={entry.sequence} className="flex gap-2">
                    <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
                      <RelativeTime timestamp={entry.createdAt} />
                    </span>
                    <span className="min-w-0">
                      {entry.agentId ? (
                        <span className="font-medium">{agentName(entry.agentId)} </span>
                      ) : null}
                      {entry.summary}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </div>

      {textDialog ? (
        <ControlTextDialog
          state={textDialog}
          pending={disabled}
          onClose={() => setTextDialog(null)}
          onSubmit={async (text, kind) => {
            const ok =
              textDialog.type === "cancel"
                ? await run(text ? { type: "cancel", reason: text } : { type: "cancel" })
                : textDialog.type === "waive_review"
                  ? await run({ type: "waive_review", reason: text })
                  : await run({ type: "authorize", kind, note: text });
            if (ok) setTextDialog(null);
          }}
        />
      ) : null}
      {reassigning ? (
        <ReassignDialog
          environmentId={environmentId}
          projectId={reassigning.projectId}
          task={reassigning}
          pending={disabled}
          onClose={() => setReassigning(null)}
          onSubmit={async (selection) => {
            const ok = await run({ type: "reassign_task", taskId: reassigning.id, selection });
            if (ok) setReassigning(null);
          }}
        />
      ) : null}
    </div>
  );
}

function TextList({ items }: { readonly items: ReadonlyArray<string> }) {
  return (
    <ul className="list-disc space-y-0.5 ps-4 text-xs text-muted-foreground">
      {items.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- server text entries may repeat; order is their identity
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function PlanView({
  plan,
  agentName,
  projectId,
}: {
  readonly plan: GarrsPlanRevision;
  readonly agentName: (agentId: GarrsAgentId) => string;
  readonly projectId: ProjectId;
}) {
  return (
    <div className="space-y-3 px-2">
      <p className="whitespace-pre-wrap text-sm">{plan.summary}</p>
      {plan.risks.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">Risks</p>
          <TextList items={plan.risks} />
        </div>
      ) : null}
      <ol className="space-y-2">
        {plan.tasks.map((task, index) => (
          <li key={task.key} className="rounded-md border border-border/60 p-2.5">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 text-sm font-medium">{task.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {agentName(task.agentId)} · {humanize(task.capability)}
              </span>
            </div>
            <div className="mt-1 space-y-1.5 ps-5">
              <p className="whitespace-pre-wrap text-xs">{task.objective}</p>
              <Muted>{task.reason}</Muted>
              <Muted>
                {task.selection
                  ? `Model: ${selectionLabel(task.selection)}${
                      task.selection.options?.length
                        ? ` · ${task.selection.options.map((option) => `${option.id}: ${String(option.value)}`).join(", ")}`
                        : ""
                    }`
                  : "Model: team policy"}
                {task.dependsOn.length > 0 ? ` · after ${task.dependsOn.join(", ")}` : ""}
                {task.projectId && task.projectId !== projectId ? ` · ${task.projectId}` : ""}
              </Muted>
              <Disclosure label="Inputs, deliverables and acceptance criteria">
                <div className="space-y-1.5">
                  {task.inputs.length ? (
                    <div>
                      <p className="text-xs font-medium">Inputs</p>
                      <TextList items={task.inputs} />
                    </div>
                  ) : null}
                  <div>
                    <p className="text-xs font-medium">Deliverables</p>
                    <TextList items={task.deliverables} />
                  </div>
                  <div>
                    <p className="text-xs font-medium">Acceptance criteria</p>
                    <TextList items={task.acceptanceCriteria} />
                  </div>
                </div>
              </Disclosure>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TaskItem({
  task,
  attempts,
  agentName,
  disabled,
  onRetry,
  onReassign,
  onStopAttempt,
  onOpenThread,
}: {
  readonly task: GarrsTask;
  readonly attempts: ReadonlyArray<GarrsAttempt>;
  readonly agentName: (agentId: GarrsAgentId) => string;
  readonly disabled: boolean;
  readonly onRetry: () => void;
  readonly onReassign: () => void;
  readonly onStopAttempt: (attemptId: GarrsAttempt["id"]) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const retryable = task.helper === undefined && taskIsRetryable(task.status);
  const reassignable = taskIsReassignable(task.status);
  return (
    <li>
      <Collapsible>
        <div className="group/task flex items-center gap-1 rounded-md pe-1 hover:bg-accent/60">
          <CollapsibleTrigger className={cn(ROW_CLASS, "flex-1 hover:bg-transparent")}>
            <StatusIcon state={task.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{task.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {agentName(task.agentId)} · {humanize(task.status)} · {task.attemptCount}{" "}
                {task.attemptCount === 1 ? "attempt" : "attempts"}
              </span>
            </span>
          </CollapsibleTrigger>
          {retryable || reassignable ? (
            <span className="opacity-0 group-hover/task:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100">
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Actions for ${task.title}`}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  {retryable ? (
                    <MenuItem disabled={disabled} onClick={onRetry}>
                      Retry task
                    </MenuItem>
                  ) : null}
                  {reassignable ? (
                    <MenuItem disabled={disabled} onClick={onReassign}>
                      Reassign model…
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            </span>
          ) : null}
        </div>
        <CollapsiblePanel>
          <div className="space-y-2 ps-7.5 pe-2 pt-1 pb-2">
            {task.pinnedSelection ? (
              <Muted>
                Pinned to {selectionLabel(task.pinnedSelection)} by {task.pinnedBy ?? "user"}
              </Muted>
            ) : null}
            {task.modelInstruction ? (
              <blockquote className="border-l-2 border-border ps-2 text-xs">
                <span className="whitespace-pre-wrap">{task.modelInstruction.quote}</span>
                <span className="block text-muted-foreground">
                  Your model instruction · message {task.modelInstruction.messageId}
                </span>
              </blockquote>
            ) : null}
            {task.helper ? (
              <Muted>
                Temporary helper for task {task.helper.parentTaskId} · deadline{" "}
                {task.helper.deadline}
              </Muted>
            ) : null}
            {task.statusReason ? <Muted>{task.statusReason}</Muted> : null}
            {attempts.length === 0 ? <Muted>No attempts yet.</Muted> : null}
            {attempts.length > 0 ? (
              <ul className="space-y-2">
                {attempts.map((attempt, index) => (
                  <AttemptItem
                    key={attempt.id}
                    attempt={attempt}
                    number={index + 1}
                    disabled={disabled}
                    onStop={() => onStopAttempt(attempt.id)}
                    onOpenThread={onOpenThread}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

function AttemptItem({
  attempt,
  number,
  disabled,
  onStop,
  onOpenThread,
}: {
  readonly attempt: GarrsAttempt;
  readonly number: number;
  readonly disabled: boolean;
  readonly onStop: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { decision, usage } = attempt;
  const threadId = attempt.threadId;
  const state = attempt.status === "succeeded" ? "report_received" : attempt.status;
  return (
    <li className="space-y-1.5 rounded-md border border-border/60 p-2 text-xs">
      <div className="flex items-center gap-2">
        <StatusIcon state={state} className="size-3" />
        <span className="font-medium">Attempt {number}</span>
        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
          {selectionLabel(decision.requested)}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          <RelativeTime timestamp={attempt.createdAt} />
        </span>
      </div>
      <Muted>
        {humanize(state)} · {formatCount(usage.inputTokens)} in · {formatCount(usage.outputTokens)}{" "}
        out · {formatDurationMs(usage.runDurationMs)}
      </Muted>
      {attempt.error ? <p className="text-destructive-foreground">{attempt.error}</p> : null}
      <div className="flex items-center gap-1">
        {threadId ? (
          <Button size="xs" variant="ghost" onClick={() => onOpenThread(threadId)}>
            Open thread
          </Button>
        ) : null}
        {attemptIsStoppable(attempt.status) ? (
          <Button size="xs" variant="ghost" disabled={disabled} onClick={onStop}>
            Stop
          </Button>
        ) : null}
      </div>
      <Disclosure label="Model decision and usage">
        <div className="space-y-2">
          <GarrsDecisionDetails decision={decision} />
          <Facts>
            <Fact label="Tokens">
              {formatCount(usage.inputTokens)} in · {formatCount(usage.outputTokens)} out ·{" "}
              {humanize(usage.quality)}
            </Fact>
            <Fact label="Input cache">
              {formatCount(usage.cachedInputTokens)} read ·{" "}
              {formatCount(usage.cacheCreationTokens ?? null)} created · included in input
            </Fact>
            <Fact label="Queue wait">{formatDurationMs(usage.queueWaitMs)}</Fact>
            <Fact label="Run time">{formatDurationMs(usage.runDurationMs)}</Fact>
            <Fact label="Provider turns">
              {formatCount(
                usage.quality === "unknown" && usage.providerTurns === 0
                  ? null
                  : usage.providerTurns,
              )}
            </Fact>
            <Fact label="Reported models">{reportedModelsLabel(usage)}</Fact>
            <Fact label="Native estimate">
              <GarrsProviderCost cost={usage.reportedCost} />
            </Fact>
            <Fact label="Subscription charge">Unknown</Fact>
          </Facts>
        </div>
      </Disclosure>
    </li>
  );
}

function ReviewItem({
  review,
  agentName,
}: {
  readonly review: GarrsReview;
  readonly agentName: (agentId: GarrsAgentId) => string;
}) {
  return (
    <li className="space-y-2 rounded-md border border-border/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusLabel state={review.verdict} />
        {review.status !== "valid" ? <StatusLabel state={review.status} /> : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                aria-label={`Reviewed state ${review.subjectHash}`}
                className="font-mono text-2xs text-muted-foreground"
              />
            }
          >
            {shortHash(review.subjectHash)}
          </TooltipTrigger>
          <TooltipPopup side="top">{review.subjectHash}</TooltipPopup>
        </Tooltip>
        <span className="ml-auto text-xs text-muted-foreground">
          <RelativeTime timestamp={review.createdAt} />
        </span>
      </div>
      {review.status === "invalidated" && review.invalidatedReason ? (
        <Muted>Invalidated: {review.invalidatedReason}</Muted>
      ) : null}
      {review.criteria.length > 0 ? (
        <ul className="space-y-1">
          {review.criteria.map((criterion, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- server text entries may repeat; order is their identity
            <li key={index} className="flex items-start gap-2 text-xs">
              <StatusIcon state={criterion.status} className="mt-0.5 size-3" />
              <span className="min-w-0">
                {criterion.criterion}
                {criterion.evidence ? (
                  <span className="block text-muted-foreground">{criterion.evidence}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {review.findings.length > 0 ? (
        <ul className="space-y-2 border-t border-border/60 pt-2">
          {review.findings.map((finding, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- server text entries may repeat; order is their identity
            <li key={index} className="space-y-0.5 text-xs">
              <p>
                <span
                  className={cn(
                    "font-medium",
                    finding.severity === "blocker"
                      ? "text-destructive-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {humanize(finding.severity)}
                </span>{" "}
                {finding.description}
              </p>
              <Muted>
                {finding.location} · {finding.impact} · for {agentName(finding.suggestedOwner)}
              </Muted>
              <Muted>Resolved when: {finding.resolutionCondition}</Muted>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ArtifactItem({
  artifact,
  agentName,
  historical,
}: {
  readonly artifact: GarrsArtifact;
  readonly agentName: (agentId: GarrsAgentId) => string;
  readonly historical: boolean;
}) {
  return (
    <li
      className={cn(
        "space-y-1 rounded-md border border-border/60 p-2.5",
        historical && "opacity-70",
      )}
    >
      <p className="text-xs text-muted-foreground">
        {agentName(artifact.agentId)} · {humanize(artifact.kind)}
        {historical ? " · historical" : ""} · <RelativeTime timestamp={artifact.createdAt} />
      </p>
      <p className="text-sm">{artifact.summary}</p>
      {artifact.body ? (
        <ExpandableText
          text={artifact.body}
          className="text-xs text-muted-foreground"
          expandLabel="Show the full report"
        />
      ) : null}
      {artifact.workspace && artifact.workspace.changedFiles.length > 0 ? (
        <Muted>{artifact.workspace.changedFiles.length} changed files</Muted>
      ) : null}
      {artifact.evidence.length > 0 ? <TextList items={artifact.evidence} /> : null}
      {(artifact.verification?.length ?? 0) > 0 ? (
        <VerificationEvidence checks={artifact.verification ?? []} />
      ) : null}
    </li>
  );
}

function MessageItem({
  message,
  agentName,
}: {
  readonly message: GarrsMessage;
  readonly agentName: (agentId: GarrsAgentId | "user" | "system") => string;
}) {
  const delivery =
    message.deliveryStatus === "delivered"
      ? "delivered"
      : message.deliveryStatus === "queued"
        ? "accepted by T3; agent receipt unconfirmed"
        : message.deliveryStatus;
  return (
    <li className="space-y-0.5">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{agentName(message.fromAgent)}</span> →{" "}
        {agentName(message.toAgent)} · {humanize(message.kind)} · {delivery} ·{" "}
        <RelativeTime timestamp={message.createdAt} />
      </p>
      <ExpandableText text={message.body} className="text-sm" expandLabel="Show the full message" />
      {message.refs.length ? <TextList items={message.refs} /> : null}
    </li>
  );
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

const AUTHORIZATION_KINDS = [
  { value: "write", label: "Write to the workspace" },
  { value: "git_commit", label: "Allow a commit proposal" },
] as const;
type AuthorizationKind = (typeof AUTHORIZATION_KINDS)[number]["value"];

const TEXT_DIALOG_COPY = {
  cancel: {
    title: "Cancel work item",
    description: "Running attempts are stopped. The reason is optional.",
    label: "Reason",
    submit: "Cancel work item",
  },
  waive_review: {
    title: "Waive the review",
    description: "Delivery proceeds without an independent review. Say why.",
    label: "Reason",
    submit: "Waive review",
  },
  authorize: {
    title: "Authorize",
    description:
      "Grant the team a permission for this work item. Each commit and push still needs its own approval.",
    label: "Note",
    submit: "Authorize",
  },
} as const;

function ControlTextDialog({
  state,
  pending,
  onClose,
  onSubmit,
}: {
  readonly state: TextDialogState;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (text: string, kind: AuthorizationKind) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<AuthorizationKind>("write");
  const copy = TEXT_DIALOG_COPY[state.type];
  const required = state.type !== "cancel";
  const trimmed = text.trim();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (required && trimmed.length === 0) return;
            void onSubmit(trimmed, kind);
          }}
        >
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              {state.type === "authorize" ? (
                <div className="space-y-1.5">
                  <Label>Permission</Label>
                  <Select
                    value={kind}
                    onValueChange={(value) => {
                      const known = AUTHORIZATION_KINDS.find((entry) => entry.value === value);
                      if (known) setKind(known.value);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Permission">
                      <SelectValue>
                        {AUTHORIZATION_KINDS.find((entry) => entry.value === kind)?.label}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {AUTHORIZATION_KINDS.map((entry) => (
                        <SelectItem key={entry.value} value={entry.value}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="garrs-control-text">{copy.label}</Label>
                <Textarea
                  id="garrs-control-text"
                  value={text}
                  maxLength={2_000}
                  onChange={(event) => setText(event.target.value)}
                />
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" type="button" />}>Close</DialogClose>
            <Button
              type="submit"
              variant={state.type === "cancel" ? "destructive" : "default"}
              disabled={pending || (required && trimmed.length === 0)}
            >
              {copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function ReassignDialog({
  environmentId,
  projectId,
  task,
  pending,
  onClose,
  onSubmit,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly task: GarrsTask;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (selection: ModelSelection) => Promise<void>;
}) {
  const { defaultSelection } = useGarrsInstanceEntries(environmentId, projectId);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const selection = picked ?? task.pinnedSelection ?? defaultSelection;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reassign model</DialogTitle>
          <DialogDescription>
            Every later attempt of “{task.title}” runs on this model.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {selection ? (
            <GarrsModelPicker
              environmentId={environmentId}
              projectId={projectId}
              value={selection}
              ariaLabel="Model"
              onChange={setPicked}
            />
          ) : (
            <Muted>No provider models are available in this environment.</Muted>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
          <Button
            disabled={pending || selection === null}
            onClick={() => selection && void onSubmit(selection)}
          >
            Reassign
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
