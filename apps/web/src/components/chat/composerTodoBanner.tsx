import type { OrchestrationV2PlanStep, RunId } from "@t3tools/contracts";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import { CircleCheckIcon, CircleDashedIcon, ListTodoIcon, LoaderCircleIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** The running turn's latest todo list; earlier turns' lists stay in the timeline. */
export function activeRunTodoSteps(
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
  activeRunId: RunId | null,
): ReadonlyArray<OrchestrationV2PlanStep> | null {
  if (activeRunId === null) return null;
  const latest = items.findLast(
    (candidate) => candidate.item.type === "todo_list" && candidate.item.runId === activeRunId,
  )?.item;
  return latest?.type === "todo_list" && latest.steps.length > 0 ? latest.steps : null;
}

function StepIcon({ status }: { status: OrchestrationV2PlanStep["status"] }) {
  if (status === "completed") return <CircleCheckIcon className="size-3.5 text-muted-foreground" />;
  if (status === "running") return <LoaderCircleIcon className="size-3.5 text-foreground" />;
  return <CircleDashedIcon className="size-3.5 text-muted-foreground/70" />;
}

export function todoListBannerItem(
  steps: ReadonlyArray<OrchestrationV2PlanStep>,
): ComposerBannerStackItem {
  const done = steps.filter((step) => step.status === "completed").length;
  return {
    id: "todo-list",
    variant: "default",
    group: "attention",
    icon: <ListTodoIcon />,
    title: `Tasks ${done}/${steps.length}`,
    children: (
      <ol className="m-0 max-h-48 list-none overflow-y-auto p-0 text-sm">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-2 py-0.5">
            <span className="flex h-5 shrink-0 items-center">
              <StepIcon status={step.status} />
            </span>
            <span
              className={cn(
                "min-w-0",
                step.status === "completed" && "text-muted-foreground line-through",
                step.status === "running" && "font-medium text-foreground",
                step.status === "pending" && "text-muted-foreground",
              )}
            >
              {step.text}
            </span>
          </li>
        ))}
      </ol>
    ),
  };
}
