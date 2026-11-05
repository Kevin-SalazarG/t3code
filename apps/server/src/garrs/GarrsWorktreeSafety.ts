import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export const worktreeSafety = Effect.fn("GarrsWorktreeSafety.check")(function* (
  root: string,
  base: string,
) {
  const vcs = yield* VcsProcess.VcsProcess;
  const run = (args: ReadonlyArray<string>) =>
    vcs
      .run({
        operation: "GarrsWorktreeSafety.check",
        command: "git",
        cwd: root,
        args: ["-c", "core.fsmonitor=false", ...args],
        allowNonZeroExit: true,
        maxOutputBytes: 32 * 1024 * 1024,
      })
      .pipe(Effect.option);
  const filters = yield* run([
    "config",
    "--null",
    "--get-regexp",
    "^filter\\..*\\.(smudge|process)$",
  ]);
  if (
    Option.isNone(filters) ||
    filters.value.stdoutTruncated ||
    filters.value.stdoutInvalidUtf8 ||
    (filters.value.exitCode !== 0 && filters.value.exitCode !== 1)
  )
    return "Cannot verify the project's checkout filters.";
  if (filters.value.exitCode === 0 && filters.value.stdout.length > 0)
    return "Garrs cannot prepare a worktree while checkout filters are configured.";
  const tree = yield* run(["ls-tree", "-r", "-z", "--full-tree", base]);
  if (
    Option.isNone(tree) ||
    tree.value.exitCode !== 0 ||
    tree.value.stdoutTruncated ||
    tree.value.stdoutInvalidUtf8
  )
    return "Cannot verify the project's checkout tree.";
  if (tree.value.stdout.split("\0").some((entry) => entry.startsWith("160000 ")))
    return "Garrs cannot prepare a worktree containing submodules.";
  return null;
});
