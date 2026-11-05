import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";

export function useGarrsInstanceEntries(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, projectId).filter(
    (entry) => entry.driverKind === "codex" || entry.driverKind === "claudeAgent",
  );
  const ready = instanceEntries.find(isProviderInstancePickerReady) ?? instanceEntries[0];
  const model = ready?.models.find((entry) => entry.isDefault) ?? ready?.models[0];
  const defaultSelection: ModelSelection | null =
    ready && model ? { instanceId: ready.instanceId, model: model.slug } : null;
  return { settings, providers, instanceEntries, defaultSelection };
}

export function GarrsModelPicker({
  environmentId,
  projectId,
  value,
  disabled,
  ariaLabel,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly value: ModelSelection;
  readonly disabled?: boolean;
  readonly ariaLabel: string;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { settings, providers, instanceEntries } = useGarrsInstanceEntries(
    environmentId,
    projectId,
  );
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      disabled={disabled ?? false}
      activeInstanceId={value.instanceId}
      model={value.model}
      lockedProvider={null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={getCustomModelOptionsByInstance(
        settings,
        providers,
        value.instanceId,
        value.model,
      )}
      isComposerOwned={false}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      triggerAriaLabel={ariaLabel}
      onInstanceModelChange={(instanceId, model) => onChange({ instanceId, model })}
    />
  );
}
