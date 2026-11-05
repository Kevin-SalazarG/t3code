import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectIntegrationAction,
  type ProjectIntegrations,
  type SupabaseProjectConnection,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { projectIntegrations } from "../../state/project-integrations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { IntegrationMark, ProjectIntegrationSignInRow } from "./ProjectIntegrationSignIn";

type Run = (action: ProjectIntegrationAction) => void;
interface Target {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const NONE = "__none__";
const MORE = "__more__";

export function ProjectIntegrationsSection(
  props: Target & { readonly label?: string | undefined },
) {
  const allowed = useAtomValue(projectIntegrations.update.permissionAtom(props.environmentId));
  const query = useEnvironmentQuery(
    projectIntegrations.config({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const update = useAtomCommand(projectIntegrations.update, {
    label: "update project integration",
  });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const run: Run = (action) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    void update({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, action },
    }).finally(() => {
      pending.current = false;
      setBusy(false);
    });
  };
  const config = query.data;
  const disabled = !allowed || busy;
  return (
    <SettingsSection
      title={props.label ? `Integrations · ${props.label}` : "Integrations"}
      {...(query.error ? { footer: query.error } : {})}
    >
      {!config ? (
        <SettingsRow
          icon="arrow.clockwise"
          label={query.error ? "Retry" : "Loading…"}
          disabled={!query.error}
          onPress={query.refresh}
        />
      ) : (
        <>
          {Object.entries(config.supabase).map(([id, connection]) => (
            <SupabaseConnection
              key={id}
              target={props}
              id={id}
              connection={connection}
              disabled={disabled}
              run={run}
            />
          ))}
          <ProjectIntegrationSignInRow
            environmentId={props.environmentId}
            projectId={props.projectId}
            provider="supabase"
            label={Object.keys(config.supabase).length === 0 ? "Supabase" : "Add Supabase"}
            disabled={disabled}
          />
          {config.github ? (
            <>
              <SettingsRow
                icon="person.crop.circle"
                leading={<IntegrationMark provider="github" />}
                label="GitHub"
                value={config.github.account}
                disabled={disabled}
                onPress={() =>
                  Alert.alert("GitHub", `Signed in as ${config.github!.account}.`, [
                    {
                      text: "Unlink",
                      style: "destructive",
                      onPress: () => run({ type: "disconnect_github" }),
                    },
                    { text: "Cancel", style: "cancel" },
                  ])
                }
              />
              <GitHubRepositoryRow
                target={props}
                github={config.github}
                disabled={disabled}
                run={run}
              />
            </>
          ) : (
            <ProjectIntegrationSignInRow
              environmentId={props.environmentId}
              projectId={props.projectId}
              provider="github"
              label="GitHub"
              disabled={disabled}
            />
          )}
        </>
      )}
    </SettingsSection>
  );
}

function SelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly disabled: boolean;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => {
        if (!props.disabled) props.onSelect(nativeEvent.event);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        accessibilityState={{ disabled: props.disabled }}
        disabled={props.disabled}
        className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
      >
        <Text textRole="body" className="text-foreground">
          {props.label}
        </Text>
        <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
          <Text
            textRole="footnote"
            className="shrink text-right text-foreground-muted"
            numberOfLines={1}
          >
            {props.value}
          </Text>
        </View>
        <SymbolView
          name="chevron.down"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}

function SupabaseConnection({
  target,
  id,
  connection,
  disabled,
  run,
}: {
  readonly target: Target;
  readonly id: string;
  readonly connection: SupabaseProjectConnection;
  readonly disabled: boolean;
  readonly run: Run;
}) {
  const query = useEnvironmentQuery(
    projectIntegrations.catalogQuery({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, connectionId: id },
    }),
  );
  const unavailable = query.isPending || query.error !== null;
  const missing =
    connection.branch !== null &&
    query.data !== null &&
    !query.data.branches.some((branch) => branch.id === connection.branch?.id);
  return (
    <>
      <SettingsRow
        icon="server.rack"
        leading={<IntegrationMark provider="supabase" />}
        label={connection.label}
        value={query.error ?? "Supabase"}
        disabled={disabled}
        onPress={() =>
          Alert.alert(connection.label, undefined, [
            { text: "Refresh", onPress: query.refresh },
            {
              text: "Unlink",
              style: "destructive",
              onPress: () => run({ type: "disconnect_supabase", connectionId: id }),
            },
            { text: "Cancel", style: "cancel" },
          ])
        }
      />
      <SelectRow
        label="Project"
        value={connection.project?.name ?? "None"}
        disabled={disabled || unavailable}
        actions={[
          { id: NONE, title: "None" },
          ...(query.data?.projects.map((project) => ({ id: project.ref, title: project.name })) ??
            []),
        ]}
        onSelect={(ref) =>
          run({
            type: "select_supabase_project",
            connectionId: id,
            projectRef: ref === NONE ? null : ref,
          })
        }
      />
      <SelectRow
        label="Branch"
        value={missing ? "Unavailable" : (connection.branch?.name ?? "None")}
        disabled={disabled || !connection.project || unavailable}
        actions={[
          { id: NONE, title: "None" },
          ...(query.data?.branches.map((branch) => ({
            id: branch.id,
            title: `${branch.name}${branch.isDefault ? " · Production" : ""}`,
          })) ?? []),
        ]}
        onSelect={(branch) =>
          run({
            type: "select_supabase_branch",
            connectionId: id,
            branchId: branch === NONE ? null : branch,
          })
        }
      />
    </>
  );
}

function GitHubRepositoryRow({
  target,
  github,
  disabled,
  run,
}: {
  readonly target: Target;
  readonly github: NonNullable<ProjectIntegrations["github"]>;
  readonly disabled: boolean;
  readonly run: Run;
}) {
  const [page, setPage] = useState(1);
  const query = useEnvironmentQuery(
    projectIntegrations.githubCatalog({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, page },
    }),
  );
  const nextPage = query.data?.nextPage ?? null;
  return (
    <SelectRow
      label="Repository"
      value={query.error ?? github.repository ?? "None"}
      disabled={disabled || query.isPending || query.error !== null}
      actions={[
        ...(query.data?.repositories.map((repository) => ({ id: repository, title: repository })) ??
          []),
        ...(nextPage ? [{ id: MORE, title: "More repositories…" }] : []),
      ]}
      onSelect={(repository) => {
        if (repository === MORE) {
          if (nextPage) setPage(nextPage);
          return;
        }
        run({
          type: "connect_github",
          repository,
          account: github.account,
          accessToken: github.accessToken,
        });
      }}
    />
  );
}
