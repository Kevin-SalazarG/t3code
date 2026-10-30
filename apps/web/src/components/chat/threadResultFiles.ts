import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";

export interface ThreadResultFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /** Whether any edit reported line counts, so the row can omit a misleading +0 -0. */
  readonly counted: boolean;
}

/** Files the thread's agent edited, most recently touched first, with summed line counts. */
export function threadResultFiles(
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
): ReadonlyArray<ThreadResultFile> {
  const byPath = new Map<string, ThreadResultFile>();
  for (const { item } of items) {
    if (item.type !== "file_change" || item.status !== "completed") continue;
    const paths = item.changes?.length
      ? item.changes.flatMap((change) => (change.operation === "delete" ? [] : [change.path]))
      : [item.fileName];
    for (const path of paths) {
      const previous = byPath.get(path);
      byPath.delete(path);
      const counted = item.additions !== undefined || item.deletions !== undefined;
      // Multi-file items report one total, so it only lands on a single-file item's row.
      const single = paths.length === 1;
      byPath.set(path, {
        path,
        additions: (previous?.additions ?? 0) + (single ? (item.additions ?? 0) : 0),
        deletions: (previous?.deletions ?? 0) + (single ? (item.deletions ?? 0) : 0),
        counted: (previous?.counted ?? false) || (single && counted),
      });
    }
  }
  return [...byPath.values()].toReversed();
}
