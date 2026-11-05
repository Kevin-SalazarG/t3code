import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { UsersRoundIcon } from "lucide-react";
import { useEffect } from "react";

import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { garrsEnvironment } from "../../state/garrs";
import { useEnvironmentQuery } from "../../state/query";
import { registerCommands, registerMenuAction } from "../../shortcuts/dispatcher";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { Button } from "../ui/button";

/** Shown only for projects with Garrs enabled; toggles the Garrs tab of the right panel. */
export function GarrsHeaderButton({
  environmentId,
  projectId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const binding = useEnvironmentQuery(
    garrsEnvironment.binding({ environmentId, input: { projectId } }),
  );
  const enabled = binding.data?.binding.enabled === true;
  const threadRef = scopeThreadRef(environmentId, threadId);
  const active = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, threadRef) === "garrs",
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register the keyboard and palette actions while this project's header is active.
  useEffect(() => {
    if (!enabled) return;
    const toggle = () =>
      useRightPanelStore.getState().toggle(scopeThreadRef(environmentId, threadId), "garrs");
    const unregisterCommand = registerCommands(
      {
        "garrs.toggle": (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) toggle();
        },
      },
      { when: () => !isCommandPaletteOpen() },
    );
    const unregisterMenu = registerMenuAction("garrs.toggle", toggle);
    return () => {
      unregisterCommand();
      unregisterMenu();
    };
  }, [enabled, environmentId, threadId]);
  if (!enabled) return null;
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      aria-label={active ? "Hide the Garrs team" : "Show the Garrs team"}
      aria-pressed={active}
      data-pressed={active || undefined}
      onClick={() => useRightPanelStore.getState().toggle(threadRef, "garrs")}
    >
      <UsersRoundIcon />
      <span className="max-sm:sr-only">Garrs</span>
    </Button>
  );
}
