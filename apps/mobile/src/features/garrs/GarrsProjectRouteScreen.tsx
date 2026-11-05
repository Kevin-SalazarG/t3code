import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type GarrsAgentStatus,
  type GarrsConfigSnapshot,
  type GarrsWorkItemId,
  type GarrsWorkItemSummary,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { useProject, useThreadShell } from "../../state/entities";
import { garrsEnvironment } from "../../state/garrs";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { garrsAgentName, humanize, modelLabel } from "./garrsPresentation";
import { garrsErrorMessage } from "./useGarrsControl";

export function GarrsProjectRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}>) {
  return (
    <GarrsProject
      key={`${route.params.environmentId}:${route.params.projectId}`}
      environmentId={route.params.environmentId}
      projectId={route.params.projectId}
    />
  );
}

function GarrsProject(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = props;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const project = useProject({ environmentId, projectId });
  const live = useEnvironmentQuery(
    garrsEnvironment.projectLive({ environmentId, input: { projectId } }),
  );
  const config = useEnvironmentQuery(garrsEnvironment.config({ environmentId, input: {} })).data;
  const binding = useEnvironmentQuery(
    garrsEnvironment.binding({ environmentId, input: { projectId } }),
  );
  const canStart = useAtomValue(garrsEnvironment.startConversation.permissionAtom(environmentId));
  const canConfigure = useAtomValue(garrsEnvironment.updateBinding.permissionAtom(environmentId));
  const startConversation = useAtomCommand(garrsEnvironment.startConversation, {
    reportFailure: false,
  });
  const updateBinding = useAtomCommand(garrsEnvironment.updateBinding, { reportFailure: false });
  const [starting, setStarting] = useState(false);
  const startInFlight = useRef(false);
  const [savingBinding, setSavingBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = live.data;
  const openThread = (threadId: ThreadId) =>
    selectDetail({ name: "Thread", params: { environmentId, threadId } });
  const openWorkItem = (workItemId: GarrsWorkItemId) =>
    navigation.navigate("SettingsGarrsWorkItem", { environmentId, projectId, workItemId });

  const start = async () => {
    if (startInFlight.current) return;
    startInFlight.current = true;
    setStarting(true);
    setError(null);
    const result = await startConversation({
      environmentId,
      input: { commandId: CommandId.make(uuidv4()), projectId },
    }).finally(() => {
      startInFlight.current = false;
      setStarting(false);
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setError(garrsErrorMessage(squashAtomCommandFailure(result)));
      return;
    }
    openThread(result.value.threadId);
  };

  const setEnabled = async (enabled: boolean) => {
    const snapshot = binding.data;
    if (!snapshot || savingBinding) return;
    setSavingBinding(true);
    setError(null);
    const result = await updateBinding({
      environmentId,
      input: { expectedRevision: snapshot.revision, binding: { ...snapshot.binding, enabled } },
    }).finally(() => setSavingBinding(false));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setError(garrsErrorMessage(squashAtomCommandFailure(result)));
  };

  const startDisabledReason = !state
    ? null
    : !state.enabled
      ? "Garrs is off for this project. Turn it on to start Garras."
      : !canStart
        ? "This connection cannot start agent work in this environment."
        : null;

  return (
    <SettingsScreen title="Garrs">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="gap-1 px-2">
          <Text textRole="title" className="font-t3-semibold text-foreground" numberOfLines={2}>
            {project?.title ?? "Project"}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            Garras coordinates the team. Chat with Garras in a thread to ask questions, plan and
            hand out work.
          </Text>
        </View>

        {error ? <Notice message={error} tone="danger" onDismiss={() => setError(null)} /> : null}

        {live.error && !state ? (
          <Notice message={live.error} tone="danger" />
        ) : !state ? (
          <Text className="px-2 text-base text-foreground-muted">Loading Garrs…</Text>
        ) : (
          <>
            <SettingsSection title="Garras">
              {binding.data ? (
                <SettingsSwitchRow
                  icon="person.2"
                  label="Garrs for this project"
                  subtitle={
                    canConfigure
                      ? "Lets Garras and the team work in this project."
                      : "This connection cannot change Garrs settings."
                  }
                  value={binding.data.binding.enabled}
                  disabled={!canConfigure || savingBinding}
                  onValueChange={(enabled) => void setEnabled(enabled)}
                />
              ) : null}
              <ListActionRow
                icon="bubble.left.and.bubble.right"
                label="Start Garras"
                {...(startDisabledReason ? { description: startDisabledReason } : {})}
                disabled={startDisabledReason !== null}
                loading={starting}
                onPress={() => void start()}
              />
              {state.garrasThreadIds.map((threadId) => (
                <GarrasThreadRow
                  key={threadId}
                  environmentId={environmentId}
                  threadId={threadId}
                  onPress={() => openThread(threadId)}
                />
              ))}
            </SettingsSection>

            <SettingsSection title="Team">
              {state.agents.length === 0 ? (
                <ListRowLayout label="No agents reported" />
              ) : (
                state.agents.map((agent) => (
                  <AgentRow
                    key={agent.agentId}
                    agent={agent}
                    config={config}
                    onOpenWork={openWorkItem}
                  />
                ))
              )}
            </SettingsSection>

            <SettingsSection title="Work">
              {state.workItems.length === 0 ? (
                <ListRowLayout
                  label="No work yet"
                  description="Work Garras starts for this project shows up here."
                />
              ) : (
                state.workItems.map((item) => (
                  <ListRow
                    key={item.id}
                    label={item.title}
                    description={workItemDescription(item)}
                    onPress={() => openWorkItem(item.id)}
                  />
                ))
              )}
            </SettingsSection>
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function workItemDescription(item: GarrsWorkItemSummary) {
  const parts = [
    humanize(item.status),
    `${item.completedTaskCount}/${item.taskCount} tasks`,
    item.access === "write" ? "Writes" : "Read only",
  ];
  return [parts.join(" · "), item.statusReason].filter(Boolean).join("\n");
}

function GarrasThreadRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onPress: () => void;
}) {
  const shell = useThreadShell({ environmentId: props.environmentId, threadId: props.threadId });
  return (
    <ListRow
      icon="bubble.left"
      label={shell?.title ?? "Garras thread"}
      description="Open conversation"
      onPress={props.onPress}
    />
  );
}

function AgentRow(props: {
  readonly agent: GarrsAgentStatus;
  readonly config: GarrsConfigSnapshot | null;
  readonly onOpenWork: (workItemId: GarrsWorkItemId) => void;
}) {
  const { agent } = props;
  const label = `${garrsAgentName(props.config, agent.agentId)} · ${humanize(agent.state)}`;
  const description = [
    agent.taskTitle,
    agent.waitingFor ? `Waiting for ${agent.waitingFor}` : null,
    agent.selection ? modelLabel(agent.selection) : null,
  ]
    .filter(Boolean)
    .join("\n");
  const workItemId = agent.workItemId;
  if (workItemId === null)
    return <ListRowLayout label={label} {...(description ? { description } : {})} />;
  return (
    <ListRow
      label={label}
      {...(description ? { description } : {})}
      onPress={() => props.onOpenWork(workItemId)}
    />
  );
}
