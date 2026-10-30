export interface InlineDiffLine {
  readonly id: string;
  readonly kind: "add" | "delete" | "context" | "hunk";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Unified-patch lines with line numbers, capped at `limit`; file headers are dropped. */
export function parseInlineDiff(
  patch: string,
  limit: number,
): { readonly lines: ReadonlyArray<InlineDiffLine>; readonly hiddenCount: number } {
  const lines: InlineDiffLine[] = [];
  let hiddenCount = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let file = 0;
  const push = (line: InlineDiffLine) => {
    if (lines.length < limit) lines.push(line);
    else hiddenCount += 1;
  };
  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      inHunk = true;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      // The first hunk's header adds nothing a reader needs; later ones mark the skipped gap.
      if (lines.length > 0)
        push({
          id: `${file}:hunk:${oldLine}:${newLine}`,
          kind: "hunk",
          oldLine: null,
          newLine: null,
          text: "⋯",
        });
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      file += 1;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      push({
        id: `${file}:add:${newLine}`,
        kind: "add",
        oldLine: null,
        newLine,
        text: raw.slice(1),
      });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      push({
        id: `${file}:delete:${oldLine}`,
        kind: "delete",
        oldLine,
        newLine: null,
        text: raw.slice(1),
      });
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      push({
        id: `${file}:context:${oldLine}:${newLine}`,
        kind: "context",
        oldLine,
        newLine,
        text: raw.slice(1),
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { lines, hiddenCount };
}
