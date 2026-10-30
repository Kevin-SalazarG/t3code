import { describe, expect, it } from "vite-plus/test";

import { parseInlineDiff } from "./inlineToolDiff.logic";

const PATCH = [
  'diff --git "a/src/a.ts" "b/src/a.ts"',
  '--- "a/src/a.ts"',
  '+++ "b/src/a.ts"',
  "@@ -10,3 +10,3 @@ function a() {",
  " keep",
  "-old",
  "+new",
  "@@ -40,1 +40,2 @@",
  " tail",
  "+added",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseInlineDiff", () => {
  it("numbers lines per side, drops file headers, and marks later hunks", () => {
    expect(parseInlineDiff(PATCH, 100)).toMatchObject({
      lines: [
        { kind: "context", oldLine: 10, newLine: 10, text: "keep" },
        { kind: "delete", oldLine: 11, newLine: null, text: "old" },
        { kind: "add", oldLine: null, newLine: 11, text: "new" },
        { kind: "hunk", oldLine: null, newLine: null, text: "⋯" },
        { kind: "context", oldLine: 40, newLine: 40, text: "tail" },
        { kind: "add", oldLine: null, newLine: 41, text: "added" },
      ],
      hiddenCount: 0,
    });
  });

  it("counts lines past the limit instead of rendering them", () => {
    const result = parseInlineDiff(PATCH, 2);
    expect(result.lines).toHaveLength(2);
    expect(result.hiddenCount).toBe(4);
  });
});
