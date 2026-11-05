import { useAtomValue } from "@effect/atom-react";
import {
  GARRS_AGENT_IDS,
  type EnvironmentId,
  type GarrsAgentId,
  type GarrsAgentModelPolicy,
  type GarrsAutonomy,
  type GarrsImportConfigResult,
  type GarrsLimits,
  type GarrsProjectBinding,
  type GarrsTeamConfig,
  type ProjectId,
} from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useProjects } from "../../state/entities";
import { garrsEnvironment } from "../../state/garrs";
import { useEnvironmentQuery, useEnvironmentQueryRefresh } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { humanize, parseLines } from "../garrs/garrs.logic";
import { GarrsModelPicker, useGarrsInstanceEntries } from "../garrs/GarrsModelPicker";
import { commandFailureMessage } from "../garrs/useGarrsCommand";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { GarrsMemorySection } from "./GarrsMemorySection";
import { GarrsUsageSection } from "./GarrsUsageSection";
import { matchesScheduledTaskScope } from "./scheduledTasksSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const AUTONOMY_LABELS: Record<GarrsAutonomy, string> = {
  approve_plan: "Approve every plan",
  auto_read: "Read freely, approve writes",
  auto: "Run plans without approval",
};

export function GarrsSettings() {
  const { scope, connectedEnvironments, environment } = useSettingsScope();
  const target = environment ?? connectedEnvironments[0];
  const allProjects = useProjects();
  if (!target) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Garrs">
          <SettingsRow
            title="No environment connected"
            description="Connect an environment to configure its agent team."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  const environmentProjects = allProjects.filter(
    (project) =>
      project.environmentId === target.environmentId &&
      !project.isScratch &&
      project.archivedAt == null,
  );
  const projects = environmentProjects.filter((project) =>
    matchesScheduledTaskScope(scope, target.environmentId, project.id),
  );
  return (
    <GarrsEnvironmentSettings
      key={target.environmentId}
      environmentId={target.environmentId}
      environmentLabel={target.label}
      projects={projects.map((project) => ({ id: project.id, title: project.title }))}
      availableProjects={environmentProjects.map((project) => ({
        id: project.id,
        title: project.title,
      }))}
    />
  );
}

interface ProjectOption {
  readonly id: ProjectId;
  readonly title: string;
}

function GarrsEnvironmentSettings({
  environmentId,
  environmentLabel,
  projects,
  availableProjects,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projects: ReadonlyArray<ProjectOption>;
  readonly availableProjects: ReadonlyArray<ProjectOption>;
}) {
  const [pickedProjectId, setPickedProjectId] = useState<ProjectId | null>(null);
  const project = projects.find((entry) => entry.id === pickedProjectId) ?? projects[0] ?? null;
  const configQuery = useEnvironmentQuery(garrsEnvironment.config({ environmentId, input: {} }));
  return (
    <SettingsPageContainer>
      <GarrsTeamConfigSection environmentId={environmentId} environmentLabel={environmentLabel} />
      <SettingsSection
        title="Project"
        headerAction={
          projects.length > 0 && project ? (
            <ProjectSelect projects={projects} value={project} onChange={setPickedProjectId} />
          ) : null
        }
      >
        {project ? (
          <GarrsBindingSection
            key={project.id}
            environmentId={environmentId}
            projectId={project.id}
            availableProjects={availableProjects}
          />
        ) : (
          <SettingsRow
            title="No projects"
            description={`Add a project on ${environmentLabel} to bind the team to it.`}
          />
        )}
      </SettingsSection>
      {configQuery.data ? (
        <GarrsPortableSection
          environmentId={environmentId}
          project={project}
          configRevision={configQuery.data.revision}
        />
      ) : null}
      {project ? (
        <GarrsMemorySection key={project.id} environmentId={environmentId} project={project} />
      ) : null}
      <GarrsUsageSection environmentId={environmentId} projects={projects} />
    </SettingsPageContainer>
  );
}

function ProjectSelect({
  projects,
  value,
  onChange,
}: {
  readonly projects: ReadonlyArray<ProjectOption>;
  readonly value: ProjectOption;
  readonly onChange: (projectId: ProjectId) => void;
}) {
  return (
    <Select
      value={value.id}
      onValueChange={(id) => {
        const next = projects.find((entry) => entry.id === id);
        if (next) onChange(next.id);
      }}
    >
      <SelectTrigger size="sm" aria-label="Project">
        <SelectValue>{value.title}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {projects.map((entry) => (
          <SelectItem key={entry.id} value={entry.id}>
            {entry.title}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Edits a copy of the server value; saving sends the revision the edit started from. */
function useRevisionedDraft<T>(snapshot: { readonly revision: number; readonly value: T } | null) {
  const [draft, setDraft] = useState<{ readonly baseRevision: number; readonly value: T } | null>(
    null,
  );
  const [resetKey, setResetKey] = useState(0);
  const edit = (update: (current: T) => T) => {
    if (snapshot === null) return;
    setDraft((current) => ({
      baseRevision: current?.baseRevision ?? snapshot.revision,
      value: update(current?.value ?? snapshot.value),
    }));
  };
  const discard = () => {
    setDraft(null);
    setResetKey((key) => key + 1);
  };
  return {
    value: draft?.value ?? snapshot?.value ?? null,
    draft,
    stale: draft !== null && snapshot !== null && draft.baseRevision !== snapshot.revision,
    // Remounting on a new server revision reloads fields that keep their own typed text.
    resetKey: `${resetKey}:${snapshot?.revision ?? -1}`,
    edit,
    discard,
  };
}

function SaveBar({
  dirty,
  stale,
  saving,
  canWrite,
  error,
  onSave,
  onDiscard,
}: {
  readonly dirty: boolean;
  readonly stale: boolean;
  readonly saving: boolean;
  readonly canWrite: boolean;
  readonly error: string | null;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
}) {
  if (!dirty && error === null) return null;
  return (
    <SettingsRow
      title={error ? "Not saved" : "Unsaved changes"}
      description={
        error ??
        (stale
          ? "This changed elsewhere since you started editing. Saving will be rejected; discard to load the latest."
          : canWrite
            ? undefined
            : "This connection lacks permission to change these settings.")
      }
      control={
        <>
          <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button size="sm" onClick={onSave} disabled={!dirty || saving || !canWrite}>
            Save
          </Button>
        </>
      }
    />
  );
}

function GarrsTeamConfigSection({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const query = useEnvironmentQuery(garrsEnvironment.config({ environmentId, input: {} }));
  const canWrite = useAtomValue(garrsEnvironment.updateConfig.permissionAtom(environmentId));
  const update = useAtomCommand(garrsEnvironment.updateConfig, {
    label: "garrs config update",
    reportFailure: false,
  });
  const snapshot = query.data ? { revision: query.data.revision, value: query.data.config } : null;
  const editor = useRevisionedDraft(snapshot);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = editor.value;
  const edit = (change: (current: GarrsTeamConfig) => GarrsTeamConfig) => {
    setError(null);
    editor.edit(change);
  };
  const save = async () => {
    if (editor.draft === null || saving || query.error !== null) return;
    setSaving(true);
    const result = await update({
      environmentId,
      input: { expectedRevision: editor.draft.baseRevision, config: editor.draft.value },
    });
    setSaving(false);
    const message = commandFailureMessage(result);
    if (result._tag === "Success") {
      editor.discard();
      toastManager.add({ type: "success", title: "Team settings saved" });
    } else if (message !== null) {
      setError(message);
    }
  };
  const disabled = !canWrite || saving || query.error !== null;
  return (
    <SettingsSection title={`Team · ${environmentLabel}`} id="garrs-team">
      {config === null ? (
        <SettingsRow
          title={query.error ? "Could not load the team" : "Loading the team…"}
          description={query.error ?? undefined}
        />
      ) : (
        <div key={editor.resetKey}>
          {query.error ? (
            <SettingsRow title="Team settings may be out of date" description={query.error} />
          ) : null}
          <SaveBar
            dirty={editor.draft !== null}
            stale={editor.stale}
            saving={saving}
            canWrite={canWrite && query.error === null}
            error={error}
            onSave={() => void save()}
            onDiscard={() => {
              setError(null);
              editor.discard();
            }}
          />
          <SettingsRow
            title="How Garras chooses models"
            description="Garras chooses an available account and model for each task. Model lists below are optional. Use this guidance for preferences such as choosing Claude for visual work; project restrictions still apply."
          >
            <div className="pb-3">
              <Textarea
                value={config.modelGuidance ?? ""}
                disabled={disabled}
                maxLength={2_000}
                aria-label="Model selection guidance"
                placeholder="For example: prefer Claude for visual work; prioritize quality for complex tasks."
                onChange={(event) =>
                  edit((current) => ({ ...current, modelGuidance: event.target.value }))
                }
              />
            </div>
          </SettingsRow>
          {GARRS_AGENT_IDS.map((agentId) => (
            <AgentConfigRow
              key={agentId}
              environmentId={environmentId}
              agentId={agentId}
              config={config}
              disabled={disabled}
              onChange={edit}
            />
          ))}
          <LimitsRows limits={config.limits} disabled={disabled} onChange={edit} />
          <SettingsRow
            title="Review writes"
            description="Changes need an independent review by Copito before delivery unless you waive it."
            control={
              <Switch
                checked={config.review.requireReviewForWrites}
                disabled={disabled}
                aria-label="Review writes"
                onCheckedChange={(checked) =>
                  edit((current) => ({
                    ...current,
                    review: { ...current.review, requireReviewForWrites: checked },
                  }))
                }
              />
            }
          />
          <SettingsRow
            title="Review diagnoses"
            description="Diagnoses are also reviewed before delivery."
            control={
              <Switch
                checked={config.review.reviewDiagnoses}
                disabled={disabled}
                aria-label="Review diagnoses"
                onCheckedChange={(checked) =>
                  edit((current) => ({
                    ...current,
                    review: { ...current.review, reviewDiagnoses: checked },
                  }))
                }
              />
            }
          />
          <SettingsRow
            title="Keep attempt threads"
            description="Days to keep the threads of finished attempts. Empty keeps them forever."
            control={
              <IntegerField
                label="Keep attempt threads (days)"
                value={config.retention.keepAttemptThreadsDays}
                nullable
                disabled={disabled}
                onChange={(value) =>
                  edit((current) => ({
                    ...current,
                    retention: { ...current.retention, keepAttemptThreadsDays: value },
                  }))
                }
              />
            }
          />
          <SettingsRow
            title="Store result bodies"
            control={
              <Switch
                checked={config.retention.storeArtifactBodies}
                disabled={disabled}
                aria-label="Store result bodies"
                onCheckedChange={(checked) =>
                  edit((current) => ({
                    ...current,
                    retention: { ...current.retention, storeArtifactBodies: checked },
                  }))
                }
              />
            }
          />
          <SettingsRow title="Knowledge sources" description="One per line.">
            <LinesField
              label="Knowledge sources"
              value={config.knowledgeSources}
              disabled={disabled}
              onChange={(lines) => edit((current) => ({ ...current, knowledgeSources: lines }))}
            />
          </SettingsRow>
        </div>
      )}
    </SettingsSection>
  );
}

function upsertPolicy(
  policies: ReadonlyArray<GarrsAgentModelPolicy>,
  next: GarrsAgentModelPolicy,
): GarrsAgentModelPolicy[] {
  return policies.some((policy) => policy.agentId === next.agentId)
    ? policies.map((policy) => (policy.agentId === next.agentId ? next : policy))
    : [...policies, next];
}

function AgentConfigRow({
  environmentId,
  agentId,
  config,
  disabled,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly agentId: GarrsAgentId;
  readonly config: GarrsTeamConfig;
  readonly disabled: boolean;
  readonly onChange: (change: (current: GarrsTeamConfig) => GarrsTeamConfig) => void;
}) {
  const profile = config.profiles.find((entry) => entry.agentId === agentId);
  const policy = config.modelPolicy.find((entry) => entry.agentId === agentId) ?? {
    agentId,
    candidates: [],
    allowFallback: true,
  };
  const editProfile = (field: "displayName" | "description" | "personality", value: string) =>
    onChange((current) => ({
      ...current,
      profiles: current.profiles.map((entry) =>
        entry.agentId === agentId ? { ...entry, [field]: value } : entry,
      ),
    }));
  const [editing, setEditing] = useState(false);
  const name = profile?.displayName ?? humanize(agentId);
  const firstModel = policy.candidates[0];
  const models =
    firstModel === undefined
      ? agentId === "garras"
        ? "Automatic startup"
        : "Garras decides"
      : `${firstModel.model}${policy.candidates.length > 1 ? ` +${policy.candidates.length - 1}` : ""}`;
  return (
    <SettingsRow
      title={name}
      description={profile?.description}
      status={
        <span className={cn("text-xs text-muted-foreground", firstModel && "font-mono text-2xs")}>
          {models}
        </span>
      }
      control={
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          Edit
        </Button>
      }
    >
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogPopup className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription>
              Changes go into the team draft. Save the team settings to apply them.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              {profile ? (
                <>
                  <FieldBlock label="Name">
                    <Input
                      value={profile.displayName}
                      disabled={disabled}
                      maxLength={200}
                      aria-label={`${agentId} name`}
                      onChange={(event) => editProfile("displayName", event.target.value)}
                    />
                  </FieldBlock>
                  <FieldBlock label="Description">
                    <Textarea
                      value={profile.description}
                      disabled={disabled}
                      maxLength={2_000}
                      aria-label={`${agentId} description`}
                      onChange={(event) => editProfile("description", event.target.value)}
                    />
                  </FieldBlock>
                  <FieldBlock label="Personality">
                    <Textarea
                      value={profile.personality}
                      disabled={disabled}
                      maxLength={2_000}
                      aria-label={`${agentId} personality`}
                      onChange={(event) => editProfile("personality", event.target.value)}
                    />
                  </FieldBlock>
                </>
              ) : null}
              <ModelPolicyEditor
                environmentId={environmentId}
                projectId={null}
                policy={policy}
                disabled={disabled}
                emptyLabel={
                  agentId === "garras"
                    ? "Automatic startup; Garras chooses the team after it starts."
                    : "Automatic: Garras decides for the task."
                }
                onChange={(next) =>
                  onChange((current) => ({
                    ...current,
                    modelPolicy: upsertPolicy(current.modelPolicy, next),
                  }))
                }
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button />}>Done</DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsRow>
  );
}

function FieldBlock({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label render={<div />}>{label}</Label>
      {children}
    </div>
  );
}

function ModelPolicyEditor({
  environmentId,
  projectId,
  policy,
  disabled,
  emptyLabel,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly policy: GarrsAgentModelPolicy;
  readonly disabled: boolean;
  readonly emptyLabel: string;
  readonly onChange: (policy: GarrsAgentModelPolicy) => void;
}) {
  const { defaultSelection } = useGarrsInstanceEntries(environmentId, projectId);
  const candidates = policy.candidates;
  const setCandidates = (next: GarrsAgentModelPolicy["candidates"]) =>
    onChange({ ...policy, candidates: next });
  const move = (from: number, to: number) => {
    const next = [...candidates];
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    setCandidates(next);
  };
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        Models, in order of preference
      </div>
      {candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ol className="space-y-1.5">
          {candidates.map((candidate, index) => (
            <li
              // oxlint-disable-next-line react/no-array-index-key -- candidates may repeat while edited
              key={index}
              className="flex flex-wrap items-center gap-1.5"
            >
              <span className="w-4 text-xs text-muted-foreground">{index + 1}</span>
              <GarrsModelPicker
                environmentId={environmentId}
                projectId={projectId}
                value={candidate}
                disabled={disabled}
                ariaLabel={`${policy.agentId} model ${index + 1}`}
                onChange={(selection) =>
                  setCandidates(candidates.map((entry, at) => (at === index ? selection : entry)))
                }
              />
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Move up"
                disabled={disabled || index === 0}
                onClick={() => move(index, index - 1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Move down"
                disabled={disabled || index === candidates.length - 1}
                onClick={() => move(index, index + 1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                aria-label="Remove model"
                disabled={disabled}
                onClick={() => setCandidates(candidates.filter((_entry, at) => at !== index))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || defaultSelection === null || candidates.length >= 8}
          onClick={() => defaultSelection && setCandidates([...candidates, defaultSelection])}
        >
          <PlusIcon />
          Add model
        </Button>
        <Label>
          <Switch
            size="sm"
            checked={policy.allowFallback}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ ...policy, allowFallback: checked })}
          />
          Fall back when the first model is unavailable
        </Label>
      </div>
    </div>
  );
}

const LIMIT_FIELDS: ReadonlyArray<{
  readonly key: keyof GarrsLimits;
  readonly title: string;
  readonly nullable?: true;
}> = [
  { key: "maxConcurrentAttempts", title: "Concurrent attempts" },
  { key: "maxConcurrentAttemptsPerWorkItem", title: "Concurrent attempts per work item" },
  { key: "maxConcurrentAttemptsPerProvider", title: "Concurrent attempts per provider" },
  { key: "maxAttemptsPerTask", title: "Attempts per task" },
  { key: "maxCorrectionCycles", title: "Correction cycles" },
  { key: "attemptTimeoutMinutes", title: "Attempt timeout (minutes)" },
  { key: "maxMessagesPerTask", title: "Messages per task" },
  { key: "tokenWarningPerWorkItem", title: "Token warning per work item", nullable: true },
  { key: "tokenLimitPerWorkItem", title: "Token limit per work item", nullable: true },
];

function LimitsRows({
  limits,
  disabled,
  onChange,
}: {
  readonly limits: GarrsLimits;
  readonly disabled: boolean;
  readonly onChange: (change: (current: GarrsTeamConfig) => GarrsTeamConfig) => void;
}) {
  return (
    <SettingsRow title="Limits" description="Empty token limits are off.">
      <div className="grid gap-3 pb-3 sm:grid-cols-3">
        {LIMIT_FIELDS.map((field) => (
          <FieldBlock key={field.key} label={field.title}>
            <IntegerField
              label={field.title}
              value={limits[field.key]}
              nullable={field.nullable === true}
              disabled={disabled}
              onChange={(value) =>
                onChange((current) => ({
                  ...current,
                  limits: { ...current.limits, [field.key]: value },
                }))
              }
            />
          </FieldBlock>
        ))}
      </div>
    </SettingsRow>
  );
}

function IntegerField({
  label,
  value,
  nullable,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly nullable: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: number | null) => void;
}) {
  return (
    <NumberField
      min={1}
      step={1}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === null) {
          if (nullable) onChange(null);
          return;
        }
        if (Number.isInteger(next) && next >= 1) onChange(next);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput aria-label={label} />
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}

/** Keeps the typed text so blank lines survive editing; the parent gets the parsed list. */
function LinesField({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (lines: string[]) => void;
}) {
  const [text, setText] = useState(() => value.join("\n"));
  return (
    <div className="pb-3">
      <Textarea
        value={text}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseLines(event.target.value));
        }}
      />
    </div>
  );
}

function GarrsBindingSection({
  environmentId,
  projectId,
  availableProjects,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly availableProjects: ReadonlyArray<ProjectOption>;
}) {
  const query = useEnvironmentQuery(
    garrsEnvironment.binding({ environmentId, input: { projectId } }),
  );
  const canWrite = useAtomValue(garrsEnvironment.updateBinding.permissionAtom(environmentId));
  const update = useAtomCommand(garrsEnvironment.updateBinding, {
    label: "garrs binding update",
    reportFailure: false,
  });
  const { instanceEntries } = useGarrsInstanceEntries(environmentId, projectId);
  const snapshot = query.data ? { revision: query.data.revision, value: query.data.binding } : null;
  const editor = useRevisionedDraft(snapshot);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const binding = editor.value;
  const edit = (change: (current: GarrsProjectBinding) => GarrsProjectBinding) => {
    setError(null);
    editor.edit(change);
  };
  const save = async () => {
    if (editor.draft === null || saving || query.error !== null) return;
    setSaving(true);
    const result = await update({
      environmentId,
      input: { expectedRevision: editor.draft.baseRevision, binding: editor.draft.value },
    });
    setSaving(false);
    const message = commandFailureMessage(result);
    if (result._tag === "Success") {
      editor.discard();
      toastManager.add({ type: "success", title: "Project settings saved" });
    } else if (message !== null) {
      setError(message);
    }
  };
  if (binding === null) {
    return (
      <SettingsRow
        title={query.error ? "Could not load project settings" : "Loading project settings…"}
        description={query.error ?? undefined}
      />
    );
  }
  const disabled = !canWrite || saving || query.error !== null;
  const allowed = binding.allowedProviderInstanceIds;
  return (
    <div key={editor.resetKey}>
      {query.error ? (
        <SettingsRow title="Project settings may be out of date" description={query.error} />
      ) : null}
      <SaveBar
        dirty={editor.draft !== null}
        stale={editor.stale}
        saving={saving}
        canWrite={canWrite && query.error === null}
        error={error}
        onSave={() => void save()}
        onDiscard={() => {
          setError(null);
          editor.discard();
        }}
      />
      <SettingsRow
        title="Enable Garrs"
        description="Lets you start Garras conversations in this project."
        control={
          <Switch
            checked={binding.enabled}
            disabled={disabled}
            aria-label="Enable Garrs"
            onCheckedChange={(checked) => edit((current) => ({ ...current, enabled: checked }))}
          />
        }
      />
      <SettingsRow
        title="Autonomy"
        description="How much the team may do before you approve its plan."
        control={
          <Select
            value={binding.autonomy}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "approve_plan" || value === "auto_read" || value === "auto")
                edit((current) => ({ ...current, autonomy: value }));
            }}
          >
            <SelectTrigger size="sm" aria-label="Autonomy">
              <SelectValue>{AUTONOMY_LABELS[binding.autonomy]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(AUTONOMY_LABELS) as GarrsAutonomy[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {AUTONOMY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Rule files"
        description="Project paths the team reads before working, one per line."
      >
        <LinesField
          label="Rule files"
          value={binding.rulePaths}
          disabled={disabled}
          onChange={(lines) => edit((current) => ({ ...current, rulePaths: lines }))}
        />
      </SettingsRow>
      <SettingsRow
        title="Associated projects"
        description="Associate projects in this environment. Each task uses its project's verified checkout and rules; changes use separate worktrees."
      >
        {availableProjects.every((project) => project.id === projectId) &&
        binding.linkedProjectIds.length === 0 ? (
          <p className="pb-3 text-sm text-muted-foreground">
            No other active projects in this environment.
          </p>
        ) : null}
        <ul className="grid gap-2 pb-3 sm:grid-cols-2">
          {availableProjects
            .filter((project) => project.id !== projectId)
            .map((project) => (
              <li key={project.id}>
                <Label>
                  <Checkbox
                    checked={binding.linkedProjectIds.includes(project.id)}
                    disabled={
                      disabled ||
                      (binding.linkedProjectIds.length >= 20 &&
                        !binding.linkedProjectIds.includes(project.id))
                    }
                    onCheckedChange={(checked) =>
                      edit((current) => ({
                        ...current,
                        linkedProjectIds: checked
                          ? [
                              ...current.linkedProjectIds.filter((id) => id !== project.id),
                              project.id,
                            ]
                          : current.linkedProjectIds.filter((id) => id !== project.id),
                      }))
                    }
                  />
                  {project.title}
                </Label>
              </li>
            ))}
          {binding.linkedProjectIds
            .filter(
              (id) => id === projectId || !availableProjects.some((project) => project.id === id),
            )
            .map((id) => (
              <li key={id}>
                <Label>
                  <Checkbox
                    checked
                    disabled={disabled}
                    onCheckedChange={() =>
                      edit((current) => ({
                        ...current,
                        linkedProjectIds: current.linkedProjectIds.filter((entry) => entry !== id),
                      }))
                    }
                  />
                  Unavailable project ({id})
                </Label>
              </li>
            ))}
        </ul>
      </SettingsRow>
      <SettingsRow
        title="Provider instances"
        description="Which provider instances the team may use in this project."
        control={
          <Label>
            <Switch
              size="sm"
              checked={allowed === null}
              disabled={disabled}
              onCheckedChange={(checked) =>
                edit((current) => ({
                  ...current,
                  allowedProviderInstanceIds: checked
                    ? null
                    : instanceEntries
                        .filter((entry) => entry.enabled)
                        .map((entry) => entry.instanceId),
                }))
              }
            />
            All instances
          </Label>
        }
      >
        {allowed === null ? null : (
          <ul className="grid gap-2 pb-3 sm:grid-cols-2">
            {instanceEntries.map((entry) => (
              <li key={entry.instanceId}>
                <Label>
                  <Checkbox
                    checked={allowed.includes(entry.instanceId)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      edit((current) => {
                        const list = current.allowedProviderInstanceIds ?? [];
                        return {
                          ...current,
                          allowedProviderInstanceIds: checked
                            ? [...list.filter((id) => id !== entry.instanceId), entry.instanceId]
                            : list.filter((id) => id !== entry.instanceId),
                        };
                      })
                    }
                  />
                  {entry.displayName}
                  {entry.enabled ? null : (
                    <span className="text-xs text-muted-foreground">(disabled)</span>
                  )}
                </Label>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
      {GARRS_AGENT_IDS.map((agentId) => {
        const override = binding.modelOverrides.find((entry) => entry.agentId === agentId);
        return (
          <SettingsRow
            key={agentId}
            title={`Model override · ${humanize(agentId)}`}
            description={override ? undefined : "Uses the team's model preference."}
            control={
              <Switch
                checked={override !== undefined}
                disabled={disabled}
                aria-label={`Override models for ${agentId}`}
                onCheckedChange={(checked) =>
                  edit((current) => ({
                    ...current,
                    modelOverrides: checked
                      ? upsertPolicy(current.modelOverrides, {
                          agentId,
                          candidates: [],
                          allowFallback: true,
                        })
                      : current.modelOverrides.filter((entry) => entry.agentId !== agentId),
                  }))
                }
              />
            }
          >
            {override ? (
              <div className="pb-3">
                <ModelPolicyEditor
                  environmentId={environmentId}
                  projectId={projectId}
                  policy={override}
                  disabled={disabled}
                  emptyLabel="No models yet: the team preference applies."
                  onChange={(next) =>
                    edit((current) => ({
                      ...current,
                      modelOverrides: upsertPolicy(current.modelOverrides, next),
                    }))
                  }
                />
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
    </div>
  );
}

function downloadJson(filename: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Delay revocation so browsers can open the download stream.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function GarrsPortableSection({
  environmentId,
  project,
  configRevision,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: ProjectOption | null;
  readonly configRevision: number;
}) {
  const canImport = useAtomValue(garrsEnvironment.importConfig.permissionAtom(environmentId));
  const runExport = useAtomQueryRunner(garrsEnvironment.exportConfig, {
    refresh: true,
    reportFailure: false,
  });
  const importConfig = useAtomCommand(garrsEnvironment.importConfig, {
    label: "garrs config import",
    reportFailure: false,
  });
  const refreshBinding = useEnvironmentQueryRefresh(
    project ? garrsEnvironment.binding({ environmentId, input: { projectId: project.id } }) : null,
  ).refresh;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [includeProject, setIncludeProject] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    readonly fileName: string;
    readonly document: string;
    readonly projectId: ProjectId | undefined;
    readonly result: GarrsImportConfigResult;
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const exportConfig = async (withProject: boolean) => {
    const result = await runExport({
      environmentId,
      input: withProject && project ? { projectId: project.id } : {},
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not export",
        description: commandFailureMessage(result) ?? undefined,
      });
      return;
    }
    downloadJson("garrs-config.json", `${JSON.stringify(result.value, null, 2)}\n`);
  };

  const previewImport = async (file: File) => {
    setBusy(true);
    setImportError(null);
    const document = await file.text();
    const projectId = includeProject && project ? project.id : undefined;
    const result = await importConfig({
      environmentId,
      input: {
        document,
        apply: false,
        expectedRevision: configRevision,
        ...(projectId ? { projectId } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setPreview({ fileName: file.name, document, projectId, result: result.value });
    } else {
      setPreview(null);
      setImportError(commandFailureMessage(result));
    }
  };

  const applyImport = async () => {
    if (preview === null) return;
    setBusy(true);
    const result = await importConfig({
      environmentId,
      input: {
        document: preview.document,
        apply: true,
        expectedRevision: configRevision,
        ...(preview.projectId ? { projectId: preview.projectId } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setImportError(commandFailureMessage(result));
      return;
    }
    if (result.value.applied) {
      if (preview.projectId) refreshBinding();
      setPreview(null);
      toastManager.add({ type: "success", title: "Settings imported" });
    } else {
      setPreview({ ...preview, result: result.value });
    }
  };

  const hasErrors = preview?.result.issues.some((issue) => issue.severity === "error") ?? false;
  return (
    <SettingsSection title="Import and export">
      <SettingsRow
        title="Export"
        description="Download the team settings as JSON. Credentials are never included."
        control={
          <>
            <Button size="sm" variant="outline" onClick={() => void exportConfig(false)}>
              Export team
            </Button>
            {project ? (
              <Button size="sm" variant="outline" onClick={() => void exportConfig(true)}>
                With {project.title}
              </Button>
            ) : null}
          </>
        }
      />
      <SettingsRow
        title="Import"
        description={
          canImport
            ? "Choose a Garrs JSON file. You see what changes before anything is applied."
            : "This connection lacks permission to change settings."
        }
        control={
          <>
            {project ? (
              <Label>
                <Switch size="sm" checked={includeProject} onCheckedChange={setIncludeProject} />
                Include {project.title}
              </Label>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!canImport || busy}
              onClick={() => fileInputRef.current?.click()}
            >
              Choose file…
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void previewImport(file);
              }}
            />
          </>
        }
      />
      {importError ? <SettingsRow title="Import failed" description={importError} /> : null}
      {preview ? (
        <SettingsRow
          title={`Preview · ${preview.fileName}`}
          description={
            preview.result.changes.length === 0 && preview.result.issues.length === 0
              ? "Nothing would change."
              : undefined
          }
          control={
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
                Discard
              </Button>
              <Button
                size="sm"
                disabled={busy || hasErrors || !canImport}
                onClick={() => void applyImport()}
              >
                Apply
              </Button>
            </>
          }
        >
          <div className="space-y-2 pb-3 text-xs">
            {preview.result.changes.length > 0 ? (
              <ul className="list-disc space-y-0.5 ps-5">
                {preview.result.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            ) : null}
            {preview.result.issues.length > 0 ? (
              <ul className="space-y-1">
                {preview.result.issues.map((issue) => (
                  <li key={`${issue.path}:${issue.message}`} className="flex items-start gap-2">
                    <Badge variant={issue.severity === "error" ? "error" : "warning"} size="sm">
                      {humanize(issue.severity)}
                    </Badge>
                    <span>
                      {issue.path ? <span className="font-mono">{issue.path}: </span> : null}
                      {issue.message}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
