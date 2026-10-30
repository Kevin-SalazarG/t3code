import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";

export interface ThreadResultFile {
  readonly path: string;
  /** Created when the thread's first touch of the path added it; later edits keep that. */
  readonly kind: "created" | "edited";
  readonly additions: number;
  readonly deletions: number;
  /** Whether any edit reported line counts, so the row can omit a misleading +0 -0. */
  readonly counted: boolean;
}

/** Files the thread's agent created or edited, most recently touched first. Deleted files drop out. */
export function threadResultFiles(
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
): ReadonlyArray<ThreadResultFile> {
  const byPath = new Map<string, ThreadResultFile>();
  for (const { item } of items) {
    if (item.type !== "file_change" || item.status !== "completed") continue;
    const changes = item.changes?.length
      ? item.changes
      : [{ operation: "update", path: item.fileName }];
    // Multi-file items report one total, so it only lands on a single-file item's row.
    const single = changes.length === 1;
    const counted = single && (item.additions !== undefined || item.deletions !== undefined);
    for (const change of changes) {
      const previous = byPath.get(change.path);
      byPath.delete(change.path);
      if (change.operation === "delete") continue;
      byPath.set(change.path, {
        path: change.path,
        kind: previous?.kind ?? (change.operation === "add" ? "created" : "edited"),
        additions: (previous?.additions ?? 0) + (single ? (item.additions ?? 0) : 0),
        deletions: (previous?.deletions ?? 0) + (single ? (item.deletions ?? 0) : 0),
        counted: (previous?.counted ?? false) || counted,
      });
    }
  }
  return [...byPath.values()].toReversed();
}
