import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export const prepare = Effect.fn("GarrsCommit.prepare")(function* (checkoutPath: string) {
  const vcs = yield* VcsProcess.VcsProcess;
  const run = (args: ReadonlyArray<string>) =>
    vcs
      .run({
        operation: "GarrsCommit.prepare",
        command: "git",
        cwd: checkoutPath,
        args: ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
        allowNonZeroExit: true,
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(Effect.option);
  const filters = yield* run(["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"]);
  const flags = yield* run(["ls-files", "-v", "-z"]);
  if (
    Option.isNone(filters) ||
    filters.value.exitCode !== 1 ||
    Option.isNone(flags) ||
    flags.value.exitCode !== 0 ||
    flags.value.stdoutTruncated ||
    flags.value.stdoutInvalidUtf8 ||
    flags.value.stdout.split("\0").some((entry) => /^[a-zS] /.test(entry))
  )
    return "Automatic staging requires an ordinary index without clean filters, sparse or hidden entries.";
  const staged = yield* run(["add", "--all", "--", ":/"]);
  if (Option.isNone(staged) || staged.value.exitCode !== 0)
    return "Git could not stage the isolated changes.";
  const tree = yield* run(["ls-files", "--stage", "-z"]);
  if (
    Option.isNone(tree) ||
    tree.value.exitCode !== 0 ||
    tree.value.stdoutTruncated ||
    tree.value.stdoutInvalidUtf8 ||
    tree.value.stdout.split("\0").some((entry) => entry.startsWith("160000 "))
  )
    return "Automatic staging cannot include submodules or embedded repositories.";
  return null;
});

/** Read the exact staged tree; unstaged and untracked changes must not be omitted. */
export const inspect = Effect.fn("GarrsCommit.inspect")(function* (checkoutPath: string) {
  const vcs = yield* VcsProcess.VcsProcess;
  const git = (args: ReadonlyArray<string>) =>
    vcs
      .run({
        operation: "GarrsCommit.inspect",
        command: "git",
        cwd: checkoutPath,
        args: ["-c", "core.fsmonitor=false", ...args],
        allowNonZeroExit: true,
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(Effect.option);
  const read = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const result = yield* git(args);
    if (
      result._tag === "None" ||
      result.value.exitCode !== 0 ||
      result.value.stdoutTruncated ||
      result.value.stdoutInvalidUtf8
    )
      return null;
    return result.value.stdout.trim();
  });
  const branchRef = yield* read(["symbolic-ref", "--quiet", "HEAD"]);
  const parentSha = yield* read(["rev-parse", "--verify", "HEAD"]);
  const top = yield* read(["rev-parse", "--show-toplevel"]);
  const fs = yield* FileSystem.FileSystem;
  const actualCheckout = yield* fs.realPath(checkoutPath).pipe(Effect.option);
  const actualTop =
    top === null ? Option.none<string>() : yield* fs.realPath(top).pipe(Effect.option);
  const untracked = yield* git(["ls-files", "--others", "--exclude-standard", "-z"]);
  const unstaged = yield* git(["diff", "--quiet", "--no-ext-diff", "--no-textconv"]);
  const staged = yield* git(["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"]);
  const indexFlags = yield* git(["ls-files", "-v", "-z"]);
  const worktrees = yield* git(["worktree", "list", "--porcelain", "-z"]);
  if (
    Option.isNone(actualCheckout) ||
    Option.isNone(actualTop) ||
    actualCheckout.value !== actualTop.value ||
    Option.isNone(worktrees) ||
    worktrees.value.exitCode !== 0 ||
    worktrees.value.stdoutTruncated ||
    worktrees.value.stdoutInvalidUtf8 ||
    Option.isNone(indexFlags) ||
    indexFlags.value.exitCode !== 0 ||
    indexFlags.value.stdoutTruncated ||
    indexFlags.value.stdoutInvalidUtf8 ||
    branchRef === null ||
    !branchRef.startsWith("refs/heads/") ||
    parentSha === null ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parentSha) ||
    untracked._tag === "None" ||
    untracked.value.exitCode !== 0 ||
    untracked.value.stdoutTruncated ||
    untracked.value.stdout.length !== 0 ||
    unstaged._tag === "None" ||
    unstaged.value.exitCode !== 0 ||
    staged._tag === "None" ||
    staged.value.exitCode !== 1
  )
    return null;
  if (indexFlags.value.stdout.split("\0").some((entry) => /^[a-zS] /.test(entry))) return null;
  let matches = 0;
  for (const record of worktrees.value.stdout.split("\0\0")) {
    const lines = record.split("\0");
    if (!lines.includes(`branch ${branchRef}`)) continue;
    matches++;
    const name = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (name === undefined) return null;
    const physical = yield* fs.realPath(name).pipe(Effect.option);
    if (Option.isNone(physical) || physical.value !== actualCheckout.value) return null;
  }
  if (matches !== 1) return null;
  const treeSha = yield* read(["write-tree"]);
  if (treeSha === null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(treeSha)) return null;
  const diffResult = yield* git([
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
  ]);
  if (
    Option.isNone(diffResult) ||
    diffResult.value.exitCode !== 0 ||
    diffResult.value.stdoutTruncated ||
    diffResult.value.stdoutInvalidUtf8 ||
    diffResult.value.stdout.length === 0 ||
    diffResult.value.stdout.length > 64_000
  )
    return null;
  if ((yield* read(["write-tree"])) !== treeSha) return null;
  return { branchRef, parentSha, treeSha, diff: diffResult.value.stdout };
});

export const createObject = Effect.fn("GarrsCommit.createObject")(function* (input: {
  readonly checkoutPath: string;
  readonly treeSha: string;
  readonly parentSha: string;
  readonly message: string;
}) {
  const vcs = yield* VcsProcess.VcsProcess;
  const result = yield* vcs
    .run({
      operation: "GarrsCommit.createObject",
      command: "git",
      cwd: input.checkoutPath,
      args: [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        input.treeSha,
        "-p",
        input.parentSha,
        "-F",
        "-",
      ],
      stdin: input.message,
      allowNonZeroExit: true,
      maxOutputBytes: 1024,
    })
    .pipe(Effect.option);
  if (
    Option.isNone(result) ||
    result.value.exitCode !== 0 ||
    result.value.stdoutTruncated ||
    result.value.stdoutInvalidUtf8
  )
    return null;
  const sha = result.value.stdout.trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null;
});

export const moveRef = Effect.fn("GarrsCommit.moveRef")(function* (input: {
  readonly checkoutPath: string;
  readonly branchRef: string;
  readonly parentSha: string;
  readonly commitSha: string;
}) {
  const vcs = yield* VcsProcess.VcsProcess;
  const result = yield* vcs
    .run({
      operation: "GarrsCommit.moveRef",
      command: "git",
      cwd: input.checkoutPath,
      args: [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "update-ref",
        input.branchRef,
        input.commitSha,
        input.parentSha,
      ],
      allowNonZeroExit: true,
      maxOutputBytes: 1024,
    })
    .pipe(Effect.option);
  return Option.isSome(result) && result.value.exitCode === 0;
});

export const readRef = Effect.fn("GarrsCommit.readRef")(function* (input: {
  readonly checkoutPath: string;
  readonly branchRef: string;
}) {
  const vcs = yield* VcsProcess.VcsProcess;
  const result = yield* vcs
    .run({
      operation: "GarrsCommit.readRef",
      command: "git",
      cwd: input.checkoutPath,
      args: ["-c", "core.fsmonitor=false", "rev-parse", "--verify", input.branchRef],
      allowNonZeroExit: true,
      maxOutputBytes: 1024,
    })
    .pipe(Effect.option);
  if (
    Option.isNone(result) ||
    result.value.exitCode !== 0 ||
    result.value.stdoutTruncated ||
    result.value.stdoutInvalidUtf8
  )
    return null;
  const sha = result.value.stdout.trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null;
});
