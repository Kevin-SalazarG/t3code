import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type GarrsControlAction,
  type GarrsWorkItemId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { garrsEnvironment } from "../../state/garrs";
import { useAtomCommand } from "../../state/use-atom-command";

type GarrsControlOutcome = { readonly tone: "default" | "danger"; readonly message: string };

export const garrsErrorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : "The environment request failed.";

/** Runs one control at a time and keeps the server's account of what it did. */
export function useGarrsControl(environmentId: EnvironmentId, workItemId: GarrsWorkItemId) {
  const allowed = useAtomValue(garrsEnvironment.control.permissionAtom(environmentId));
  const control = useAtomCommand(garrsEnvironment.control, { reportFailure: false });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<GarrsControlOutcome | null>(null);
  const inFlight = useRef(false);

  const run = async (key: string, action: GarrsControlAction) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPendingKey(key);
    setOutcome(null);
    const result = await control({
      environmentId,
      input: { commandId: CommandId.make(uuidv4()), workItemId, action },
    }).finally(() => {
      inFlight.current = false;
      setPendingKey(null);
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setOutcome({
          tone: "danger",
          message: garrsErrorMessage(squashAtomCommandFailure(result)),
        });
      return;
    }
    setOutcome({ tone: "default", message: result.value.effect });
  };

  return {
    allowed,
    busy: pendingKey !== null,
    pendingKey,
    outcome,
    dismissOutcome: () => setOutcome(null),
    run,
  };
}
