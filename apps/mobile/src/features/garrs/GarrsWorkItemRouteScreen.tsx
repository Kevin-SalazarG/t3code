import type { StaticScreenProps } from "@react-navigation/native";
import type {
  EnvironmentId,
  GarrsAttempt,
  GarrsConfigSnapshot,
  GarrsMessage,
  GarrsPlanRevision,
  GarrsReview,
  GarrsTask,
  GarrsWorkItemDetail,
  GarrsWorkItemId,
  ProjectId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { garrsEnvironment } from "../../state/garrs";
import { useEnvironmentQuery } from "../../state/query";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import {
  canRetryTask,
  canStopAttempt,
  effectiveModelLabel,
  formatCount,
  formatDuration,
  garrsAgentName,
  humanize,
  modelLabel,
  workItemControls,
} from "./garrsPresentation";
import { useGarrsControl } from "./useGarrsControl";

type GarrsControl = ReturnType<typeof useGarrsControl>;

export function GarrsWorkItemRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workItemId: GarrsWorkItemId;
}>) {
  return (
    <GarrsWorkItem
      key={`${route.params.environmentId}:${route.params.workItemId}`}
      environmentId={route.params.environmentId}
      workItemId={route.params.workItemId}
    />
  );
}

function GarrsWorkItem(props: {
  readonly environmentId: EnvironmentId;
  readonly workItemId: GarrsWorkItemId;
}) {
  const { environmentId, workItemId } = props;
  const insets = useSafeAreaInsets();
  const live = useEnvironmentQuery(
    garrsEnvironment.workItemLive({ environmentId, input: { workItemId } }),
  );
  const config = useEnvironmentQuery(garrsEnvironment.config({ environmentId, input: {} })).data;
  const control = useGarrsControl(environmentId, workItemId);
  const detail = live.data;

  return (
    <SettingsScreen title={detail?.workItem.title ?? "Work item"}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {live.error && !detail ? (
          <Notice message={live.error} tone="danger" />
        ) : !detail ? (
          <Text className="px-2 text-base text-foreground-muted">Loading work item…</Text>
        ) : (
          <WorkItemContent
            environmentId={environmentId}
            detail={detail}
            config={config}
            control={control}
          />
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function WorkItemContent(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: GarrsWorkItemDetail;
  readonly config: GarrsConfigSnapshot | null;
  readonly control: GarrsControl;
}) {
  const { detail, config, control } = props;
  const { workItem } = detail;
  const selectDetail = useSelectWorkspaceDetail();
  const available = workItemControls(workItem.status);
  const awaitingPlan = detail.plans.find((plan) => plan.status === "awaiting_approval");
  const activePlan = detail.plans.findLast((plan) => plan.status === "active");
  const agentName = (agentId: Parameters<typeof garrsAgentName>[1]) =>
    garrsAgentName(config, agentId);
  const openThread = (threadId: string) =>
    selectDetail({ name: "Thread", params: { environmentId: props.environmentId, threadId } });

  return (
    <>
      <View className="gap-1 px-2">
        <Text textRole="headline" className="font-t3-semibold text-foreground">
          {humanize(workItem.status)}
        </Text>
        {workItem.statusReason ? (
          <Text textRole="footnote" className="text-foreground-muted" selectable>
            {workItem.statusReason}
          </Text>
        ) : null}
        <Text textRole="footnote" className="text-foreground-muted">
          {`${humanize(workItem.intent)} · ${workItem.access === "write" ? "Writes" : "Read only"} · Revision ${workItem.revision}`}
        </Text>
        <Text textRole="body" className="pt-2 text-foreground" selectable numberOfLines={8}>
          {workItem.objective}
        </Text>
      </View>

      {control.outcome ? (
        <Notice
          message={control.outcome.message}
          tone={control.outcome.tone}
          onDismiss={control.dismissOutcome}
        />
      ) : null}

      {workItem.resumeRequested ? (
        <Notice
          tone="default"
          message="Continuation recorded. The existing plan continues automatically after pending stops finish, within its limits."
        />
      ) : null}

      {(detail.preparation?.length ?? 0) > 0 ? (
        <SettingsSection title="Checkout preparation">
          {detail.preparation?.map((check, index) => (
            <Block key={`${check.projectId}:${check.message}`} first={index === 0}>
              <Text
                textRole="footnote"
                className="text-foreground"
                selectable
              >{`${humanize(check.status)} · ${check.message}`}</Text>
            </Block>
          ))}
        </SettingsSection>
      ) : null}

      {detail.remaining.length > 0 ? (
        <SettingsSection title="Still blocking delivery">
          {detail.remaining.map((entry, index) => (
            <Block key={entry} first={index === 0}>
              <Text textRole="footnote" className="text-foreground" selectable>
                {entry}
              </Text>
            </Block>
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Controls"
        {...(control.allowed ? {} : { footer: "This connection cannot control agent work." })}
      >
        <ListActionRow
          icon="bubble.left.and.bubble.right"
          label="Open Garras thread"
          onPress={() => openThread(workItem.garrasThreadId)}
        />
        {control.allowed && available.pause ? (
          <ListActionRow
            icon="pause"
            label="Pause"
            description="No new assignments start. Running attempts continue."
            disabled={control.busy}
            loading={control.pendingKey === "pause"}
            onPress={() => void control.run("pause", { type: "pause" })}
          />
        ) : null}
        {control.allowed && available.resume ? (
          <ListActionRow
            icon="play"
            label="Resume"
            description="Continue the existing plan and completed results."
            disabled={control.busy || workItem.resumeRequested === true}
            loading={control.pendingKey === "resume"}
            onPress={() => void control.run("resume", { type: "resume" })}
          />
        ) : null}
        {control.allowed && available.accept ? (
          <ListActionRow
            icon="checkmark.circle"
            label="Accept delivery"
            disabled={control.busy}
            loading={control.pendingKey === "accept"}
            onPress={() => void control.run("accept", { type: "accept" })}
          />
        ) : null}
        {control.allowed && available.cancel ? (
          <ListActionRow
            icon="xmark.circle.fill"
            label="Cancel work"
            tone="danger"
            disabled={control.busy}
            loading={control.pendingKey === "cancel"}
            onPress={() =>
              Dialog.confirm({
                title: "Cancel this work?",
                message: "Unfinished tasks are cancelled and running attempts are stopped.",
                confirmText: "Cancel work",
                cancelText: "Keep working",
                destructive: true,
                onConfirm: () => void control.run("cancel", { type: "cancel" }),
              })
            }
          />
        ) : null}
      </SettingsSection>

      {awaitingPlan ? (
        <PlanSection
          title={`Plan revision ${awaitingPlan.revision} awaits approval`}
          plan={awaitingPlan}
          agentName={agentName}
        >
          {control.allowed ? (
            <ListActionRow
              icon="checkmark.circle"
              label={`Approve revision ${awaitingPlan.revision}`}
              description="Its tasks start within the team limits."
              disabled={control.busy}
              loading={control.pendingKey === "approve_plan"}
              onPress={() =>
                void control.run("approve_plan", { type: "approve_plan", planId: awaitingPlan.id })
              }
            />
          ) : null}
        </PlanSection>
      ) : null}
      {activePlan ? (
        <PlanSection
          title={`Plan · revision ${activePlan.revision}`}
          plan={activePlan}
          agentName={agentName}
        />
      ) : null}

      <SettingsSection title="Tasks">
        {detail.tasks.length === 0 ? (
          <ListRowLayout label="No tasks yet" />
        ) : (
          detail.tasks.map((task, index) => (
            <TaskBlock
              key={task.id}
              first={index === 0}
              task={task}
              agentName={agentName}
              control={control}
            />
          ))
        )}
      </SettingsSection>

      {detail.attempts.length > 0 ? (
        <SettingsSection title="Attempts">
          {detail.attempts.map((attempt, index) => (
            <AttemptBlock
              key={attempt.id}
              first={index === 0}
              attempt={attempt}
              task={detail.tasks.find((task) => task.id === attempt.taskId)}
              agentName={agentName}
              control={control}
              onOpenThread={openThread}
            />
          ))}
        </SettingsSection>
      ) : null}

      {detail.artifacts.length > 0 ? (
        <SettingsSection title="Results reported by the team">
          {detail.artifacts.map((artifact, index) => (
            <Block key={artifact.id} first={index === 0}>
              <Text textRole="body" className="text-foreground" selectable>
                {artifact.summary}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted" selectable>
                {artifact.body}
              </Text>
              {artifact.verification?.map((check) => (
                <Text
                  key={`${check.name}:${check.status}:${check.evidence}`}
                  textRole="footnote"
                  className="text-foreground-muted"
                  selectable
                >{`${check.name} · ${humanize(check.status)}: ${check.evidence}`}</Text>
              ))}
            </Block>
          ))}
        </SettingsSection>
      ) : null}

      {detail.reviews.length > 0 ? (
        <SettingsSection title="Reviews">
          {detail.reviews.map((review, index) => (
            <ReviewBlock
              key={review.id}
              first={index === 0}
              review={review}
              agentName={agentName}
            />
          ))}
        </SettingsSection>
      ) : null}

      {detail.messages.length > 0 ? (
        <SettingsSection title="Agent messages">
          {detail.messages.map((message, index) => (
            <MessageBlock
              key={message.id}
              first={index === 0}
              message={message}
              agentName={agentName}
            />
          ))}
        </SettingsSection>
      ) : null}

      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {`Opened ${new Date(workItem.createdAt).toLocaleString()}`}
      </Text>
    </>
  );
}

type AgentName = (agentId: Parameters<typeof garrsAgentName>[1]) => string;

function Block(props: { readonly first: boolean; readonly children: ReactNode }) {
  return (
    <View className={cn("gap-1 p-4", !props.first && "border-t border-border-subtle")}>
      {props.children}
    </View>
  );
}

function Line(props: { readonly children: ReactNode; readonly strong?: boolean }) {
  return (
    <Text
      textRole={props.strong ? "body" : "footnote"}
      className={props.strong ? "text-foreground" : "text-foreground-muted"}
      selectable
    >
      {props.children}
    </Text>
  );
}

function PlanSection(props: {
  readonly title: string;
  readonly plan: GarrsPlanRevision;
  readonly agentName: AgentName;
  readonly children?: ReactNode;
}) {
  const { plan } = props;
  return (
    <SettingsSection title={props.title}>
      <Block first>
        <Line strong>{plan.summary}</Line>
        {plan.risks.length > 0 ? <Line>{`Risks: ${plan.risks.join("; ")}`}</Line> : null}
      </Block>
      {plan.tasks.map((task) => (
        <Block key={task.key} first={false}>
          <Line strong>{task.title}</Line>
          <Line>
            {[
              props.agentName(task.agentId),
              humanize(task.capability),
              task.selection ? modelLabel(task.selection) : null,
              task.dependsOn.length > 0 ? `After ${task.dependsOn.join(", ")}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Line>
          <Line>{task.reason}</Line>
        </Block>
      ))}
      {props.children}
    </SettingsSection>
  );
}

function TaskBlock(props: {
  readonly first: boolean;
  readonly task: GarrsTask;
  readonly agentName: AgentName;
  readonly control: GarrsControl;
}) {
  const { task, control } = props;
  const key = `retry:${task.id}`;
  return (
    <>
      <Block first={props.first}>
        <Line strong>{task.title}</Line>
        <Line>
          {[
            props.agentName(task.agentId),
            humanize(task.status),
            task.attemptCount === 1 ? "1 attempt" : `${task.attemptCount} attempts`,
          ].join(" · ")}
        </Line>
        {task.statusReason ? <Line>{task.statusReason}</Line> : null}
        {task.pinnedSelection ? (
          <Line>{`Pinned to ${modelLabel(task.pinnedSelection)} by ${task.pinnedBy ?? "user"}`}</Line>
        ) : null}
      </Block>
      {control.allowed && canRetryTask(task) ? (
        <ListActionRow
          icon="arrow.clockwise"
          label={`Retry "${task.title}"`}
          disabled={control.busy}
          loading={control.pendingKey === key}
          onPress={() => void control.run(key, { type: "retry_task", taskId: task.id })}
        />
      ) : null}
    </>
  );
}

function AttemptBlock(props: {
  readonly first: boolean;
  readonly attempt: GarrsAttempt;
  readonly task: GarrsTask | undefined;
  readonly agentName: AgentName;
  readonly control: GarrsControl;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { attempt, control } = props;
  const { decision, usage } = attempt;
  const key = `stop:${attempt.id}`;
  const threadId = attempt.threadId;
  return (
    <>
      <Block first={props.first}>
        <Line strong>
          {`${props.agentName(attempt.agentId)} · ${humanize(attempt.status)}${props.task ? ` · ${props.task.title}` : ""}`}
        </Line>
        <Line>{`Requested ${modelLabel(decision.requested)} (${humanize(decision.source)}${decision.fallbackUsed ? ", fallback" : ""})`}</Line>
        <Line>{`Effective model: ${effectiveModelLabel(decision)}`}</Line>
        {decision.reason ? <Line>{decision.reason}</Line> : null}
        <Line>
          {`Tokens in ${formatCount(usage.inputTokens)} · cached ${formatCount(usage.cachedInputTokens)} · out ${formatCount(usage.outputTokens)} · run ${formatDuration(usage.runDurationMs)}`}
        </Line>
        {attempt.error ? <Line>{attempt.error}</Line> : null}
      </Block>
      {threadId !== null ? (
        <ListActionRow
          icon="bubble.left"
          label="Open attempt thread"
          onPress={() => props.onOpenThread(threadId)}
        />
      ) : null}
      {control.allowed && canStopAttempt(attempt) ? (
        <ListActionRow
          icon="stop.fill"
          label="Stop attempt"
          tone="danger"
          disabled={control.busy}
          loading={control.pendingKey === key}
          onPress={() => void control.run(key, { type: "stop_attempt", attemptId: attempt.id })}
        />
      ) : null}
    </>
  );
}

function ReviewBlock(props: {
  readonly first: boolean;
  readonly review: GarrsReview;
  readonly agentName: AgentName;
}) {
  const { review } = props;
  const invalidated = review.status === "invalidated";
  return (
    <Block first={props.first}>
      <Line strong>{`${humanize(review.verdict)}${invalidated ? " · Invalidated" : ""}`}</Line>
      {invalidated && review.invalidatedReason ? <Line>{review.invalidatedReason}</Line> : null}
      {review.findings.length === 0 ? <Line>No findings.</Line> : null}
      {review.findings.map((finding) => (
        <View
          key={`${finding.severity}:${finding.location}:${finding.description}`}
          className="gap-0.5 pt-2"
        >
          <Line>{`${humanize(finding.severity)} · ${finding.location || "No location"} · for ${props.agentName(finding.suggestedOwner)}`}</Line>
          <Line strong>{finding.description}</Line>
          {finding.resolutionCondition ? (
            <Line>{`Resolved when: ${finding.resolutionCondition}`}</Line>
          ) : null}
        </View>
      ))}
    </Block>
  );
}

function MessageBlock(props: {
  readonly first: boolean;
  readonly message: GarrsMessage;
  readonly agentName: AgentName;
}) {
  const { message } = props;
  return (
    <Block first={props.first}>
      <Line>
        {`${props.agentName(message.fromAgent)} → ${props.agentName(message.toAgent)} · ${humanize(message.kind)}${message.deliveryStatus === "delivered" ? "" : ` · ${humanize(message.deliveryStatus)}`}`}
      </Line>
      <Text textRole="footnote" className="text-foreground" selectable numberOfLines={12}>
        {message.body}
      </Text>
    </Block>
  );
}
