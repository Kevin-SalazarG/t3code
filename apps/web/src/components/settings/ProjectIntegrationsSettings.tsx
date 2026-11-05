import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectId,
  type ProjectIntegrationAction,
  type ProjectIntegrations,
  type SupabaseProjectConnection,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { projectIntegrations } from "../../state/project-integrations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { IntegrationTitle, ProjectIntegrationSignInRow } from "./ProjectIntegrationSignIn";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface Target {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}
type Run = (action: ProjectIntegrationAction) => void;

const NONE = "__none__";

export function ProjectIntegrationsSettings({
  environmentId,
  projectId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label?: string | undefined;
}) {
  const target = { environmentId, projectId };
  const allowed = useAtomValue(projectIntegrations.update.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    projectIntegrations.config({ environmentId, input: { projectId } }),
  );
  const update = useAtomCommand(projectIntegrations.update, {
    label: "update project integration",
  });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const run: Run = (action) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    void update({ environmentId, input: { projectId, action } }).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  };
  const config = query.data;
  const disabled = !allowed || busy;

  return (
    <SettingsSection title={label ? `Integrations · ${label}` : "Integrations"}>
      {query.error ? (
        <SettingsRow
          title="Could not load integrations"
          description={query.error}
          control={
            <Button size="xs" variant="outline" onClick={query.refresh}>
              Retry
            </Button>
          }
        />
      ) : null}
      {query.isPending && !config ? (
        <SettingsRow title="Integrations" description="Loading…" />
      ) : null}
      {config ? (
        <>
          {Object.entries(config.supabase).map(([connectionId, connection]) => (
            <SupabaseConnection
              key={connectionId}
              target={target}
              connectionId={connectionId}
              connection={connection}
              disabled={disabled}
              run={run}
            />
          ))}
          <ProjectIntegrationSignInRow
            environmentId={environmentId}
            projectId={projectId}
            provider="supabase"
            title={Object.keys(config.supabase).length === 0 ? "Supabase" : "Add Supabase"}
            description={
              Object.keys(config.supabase).length === 0
                ? "Sign in to link a Supabase project and choose its branch."
                : "Link another Supabase account or project."
            }
            disabled={disabled}
          />
          {config.github ? (
            <>
              <SettingsRow
                title={<IntegrationTitle provider="github">GitHub</IntegrationTitle>}
                description={`Signed in as ${config.github.account}`}
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => run({ type: "disconnect_github" })}
                  >
                    Unlink
                  </Button>
                }
              />
              <GitHubRepositoryRow
                target={target}
                github={config.github}
                disabled={disabled}
                run={run}
              />
            </>
          ) : (
            <ProjectIntegrationSignInRow
              environmentId={environmentId}
              projectId={projectId}
              provider="github"
              title="GitHub"
              description="Sign in to choose the repository for this project."
              disabled={disabled}
            />
          )}
        </>
      ) : null}
    </SettingsSection>
  );
}

function SupabaseConnection({
  target,
  connectionId,
  connection,
  disabled,
  run,
}: {
  readonly target: Target;
  readonly connectionId: string;
  readonly connection: SupabaseProjectConnection;
  readonly disabled: boolean;
  readonly run: Run;
}) {
  const catalog = useEnvironmentQuery(
    projectIntegrations.catalogQuery({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, connectionId },
    }),
  );
  const unavailable = catalog.isPending || catalog.error !== null;
  const branchMissing =
    connection.branch !== null &&
    catalog.data !== null &&
    !catalog.data.branches.some((branch) => branch.id === connection.branch?.id);
  return (
    <>
      <SettingsRow
        title={<IntegrationTitle provider="supabase">{connection.label}</IntegrationTitle>}
        description="Supabase"
        status={catalog.error ? <span className="text-destructive">{catalog.error}</span> : null}
        control={
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Refresh ${connection.label}`}
              disabled={disabled}
              onClick={catalog.refresh}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => run({ type: "disconnect_supabase", connectionId })}
            >
              Unlink
            </Button>
          </>
        }
      />
      <SettingsRow
        title="Project"
        description="The Supabase project agents work against."
        control={
          <Select
            value={connection.project?.ref ?? NONE}
            onValueChange={(ref) => {
              if (ref !== null)
                run({
                  type: "select_supabase_project",
                  connectionId,
                  projectRef: ref === NONE ? null : ref,
                });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={`Supabase project for ${connection.label}`}
              disabled={disabled || unavailable}
            >
              <SelectValue>{connection.project?.name ?? "None"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={NONE}>None</SelectItem>
              {catalog.data?.projects.map((project) => (
                <SelectItem key={project.ref} value={project.ref}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Branch"
        description={
          branchMissing
            ? "The selected branch no longer exists. Choose another."
            : "The Supabase branch agents use, such as dev or main."
        }
        control={
          <Select
            value={connection.branch?.id ?? NONE}
            onValueChange={(id) => {
              if (id !== null)
                run({
                  type: "select_supabase_branch",
                  connectionId,
                  branchId: id === NONE ? null : id,
                });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={`Supabase branch for ${connection.label}`}
              disabled={disabled || !connection.project || unavailable}
            >
              <SelectValue>{connection.branch?.name ?? "None"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={NONE}>None</SelectItem>
              {catalog.data?.branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                  {branch.isDefault ? " · Production" : ""}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
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
    <SettingsRow
      title="Repository"
      description="The GitHub repository for this project."
      status={query.error ? <span className="text-destructive">{query.error}</span> : null}
      control={
        <>
          {page > 1 ? (
            <Button size="xs" variant="ghost" onClick={() => setPage(page - 1)}>
              Previous
            </Button>
          ) : null}
          {nextPage ? (
            <Button size="xs" variant="ghost" onClick={() => setPage(nextPage)}>
              More
            </Button>
          ) : null}
          <Select
            value={github.repository}
            onValueChange={(repository) => {
              if (repository)
                run({
                  type: "connect_github",
                  repository,
                  account: github.account,
                  accessToken: github.accessToken,
                });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="GitHub repository"
              disabled={disabled || query.isPending || query.error !== null}
            >
              <SelectValue>{github.repository ?? "None"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {query.data?.repositories.map((repository) => (
                <SelectItem key={repository} value={repository}>
                  {repository}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </>
      }
    />
  );
}
