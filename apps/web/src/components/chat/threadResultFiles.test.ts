import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { threadResultFiles } from "./threadResultFiles";

function fileChange(
  id: string,
  fields: {
    fileName: string;
    status?: "completed" | "failed";
    additions?: number;
    deletions?: number;
    changes?: ReadonlyArray<{ operation: string; path: string }>;
  },
) {
  return {
    item: { id, type: "file_change", status: "completed", ...fields },
  } as unknown as ThreadStructureVisibleTurnItem;
}

describe("threadResultFiles", () => {
  it("sums repeat edits, keeps a created file created, orders by last touch, and drops deletions", () => {
    const files = threadResultFiles([
      fileChange("1", {
        fileName: "/w/a.ts",
        additions: 2,
        deletions: 0,
        changes: [{ operation: "add", path: "/w/a.ts" }],
      }),
      fileChange("2", { fileName: "/w/b.ts" }),
      fileChange("3", { fileName: "/w/a.ts", additions: 3, deletions: 1 }),
      fileChange("4", { fileName: "/w/c.ts", status: "failed", additions: 9 }),
      fileChange("5", { fileName: "/w/g.ts", additions: 1 }),
      fileChange("6", {
        fileName: "/w/d.ts",
        additions: 7,
        changes: [
          { operation: "add", path: "/w/d.ts" },
          { operation: "delete", path: "/w/g.ts" },
          { operation: "update", path: "/w/f.ts" },
        ],
      }),
    ]);
    expect(files).toEqual([
      { path: "/w/f.ts", kind: "edited", additions: 0, deletions: 0, counted: false },
      { path: "/w/d.ts", kind: "created", additions: 0, deletions: 0, counted: false },
      { path: "/w/a.ts", kind: "created", additions: 5, deletions: 1, counted: true },
      { path: "/w/b.ts", kind: "edited", additions: 0, deletions: 0, counted: false },
    ]);
  });
});
