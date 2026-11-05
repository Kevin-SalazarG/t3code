import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type GarrsControlAction,
  type GarrsWorkItemId,
} from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { garrsEnvironment } from "../../state/garrs";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { humanize } from "./garrs.logic";

export function commandFailureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The request failed.";
}

export function toastCommandFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  const description = commandFailureMessage(result);
  if (description !== null) toastManager.add({ type: "error", title, description });
}

export function newGarrsCommandId() {
  return CommandId.make(randomUUID());
}

/** Runs one work item control and reports the server's own account of what it did. */
export function useGarrsControl(environmentId: EnvironmentId, workItemId: GarrsWorkItemId) {
  const canControl = useAtomValue(garrsEnvironment.control.permissionAtom(environmentId));
  const canApproveGit = useAtomValue(
    garrsEnvironment.control.permissionAtom(environmentId, {
      commandId: CommandId.make("permission"),
      workItemId,
      action: { type: "approve_commit", proposalId: "permission" },
    }),
  );
  const control = useAtomCommand(garrsEnvironment.control, {
    label: "garrs control",
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const run = async (action: GarrsControlAction): Promise<boolean> => {
    if (pending) return false;
    setPending(true);
    const result = await control({
      environmentId,
      input: { commandId: newGarrsCommandId(), workItemId, action },
    });
    setPending(false);
    if (result._tag === "Success") {
      if (
        action.type === "approve_commit" &&
        result.value.workItem.commitProposal?.status === "failed"
      ) {
        toastManager.add({
          type: "warning",
          title: "Commit not approved",
          description: result.value.effect,
        });
        return false;
      }
      toastManager.add({
        type: "success",
        title: humanize(action.type),
        description: result.value.effect,
      });
      return true;
    }
    toastCommandFailure(`Could not ${humanize(action.type).toLowerCase()}`, result);
    return false;
  };
  return { canControl, canApproveGit, pending, run };
}
