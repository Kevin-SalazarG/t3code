import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";

import { cn } from "../../lib/utils";
import { toolCallDiff } from "../../lib/toolCallDiff";
import { useTurnItemDetail } from "../../state/queries";
import { parseInlineDiff } from "./inlineToolDiff.logic";
import type { TurnItemSource } from "./timelineRowContext";

const INLINE_DIFF_LINE_LIMIT = 300;

const LINE_CLASS = {
  add: "bg-diff-addition/12",
  delete: "bg-diff-deletion/12",
  context: "",
  hunk: "text-muted-foreground",
} as const;

const GUTTER_CLASS = {
  add: "border-diff-addition",
  delete: "border-diff-deletion",
  context: "border-transparent",
  hunk: "border-transparent",
} as const;

/**
 * An edit's patch, shown inside the chat. The wire item omits the patch, so it is fetched
 * only once this mounts, which happens when the row is expanded.
 */
export function InlineToolDiff(props: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly source?: TurnItemSource | undefined;
  readonly onOpenFullDiff?: (() => void) | undefined;
}) {
  const detail = useTurnItemDetail(
    {
      environmentId: props.environmentId,
      threadId: props.projectedItem.sourceThreadId,
      itemId: props.projectedItem.sourceItemId,
      revision: turnItemDetailRevision(props.projectedItem.item),
    },
    props.source?.detail,
  );
  const item = detail.data?.item;
  if (item?.type !== "file_change") {
    if (detail.error) {
      return (
        <div className="text-destructive">Couldn&apos;t load diff: {String(detail.error)}</div>
      );
    }
    return detail.isPending ? (
      <div className="text-muted-foreground italic">Loading diff…</div>
    ) : null;
  }
  const patch = toolCallDiff(item).patch;
  if (!patch?.trim()) return null;
  const { lines, hiddenCount } = parseInlineDiff(patch, INLINE_DIFF_LINE_LIMIT);
  if (lines.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-md border border-border/45">
      <div className="max-h-96 overflow-auto font-mono text-2xs leading-5">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className={LINE_CLASS[line.kind]}>
                <td
                  className={cn(
                    "w-px border-l-2 px-2 text-right align-top text-muted-foreground/70 tabular-nums select-none",
                    GUTTER_CLASS[line.kind],
                  )}
                >
                  {line.newLine ?? line.oldLine ?? ""}
                </td>
                <td className="whitespace-pre pr-3 text-foreground/85">
                  {line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}
                  {line.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hiddenCount > 0 ? (
        <div className="border-t border-border/45 px-2 py-1 text-muted-foreground">
          {hiddenCount} more lines
          {props.onOpenFullDiff ? (
            <>
              {" · "}
              <button type="button" className="hover:underline" onClick={props.onOpenFullDiff}>
                Open full diff
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
