import type { GarrsRuleSnapshot, GarrsWorkspaceState } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { WorkAggregate } from "./GarrsDomain.ts";

const RULE_MAX_BYTES = 256 * 1024;
const DIFF_MAX_BYTES = 32 * 1024 * 1024;

const sameRules = (
  previous: ReadonlyArray<GarrsRuleSnapshot>,
  current: ReadonlyArray<GarrsRuleSnapshot>,
) =>
  previous.length === current.length &&
  previous.every(
    (rule, index) =>
      rule.path === current[index]?.path &&
      rule.status === current[index]?.status &&
      rule.sha256 === current[index]?.sha256,
  );
const UNTRACKED_MAX_FILE_BYTES = 4 * 1024 * 1024;
const UNTRACKED_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const readBounded = Effect.fn("GarrsSubject.readBounded")(function* (
  absolute: string,
  maxBytes: number,
  noFollow: boolean,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const file = yield* fileSystem.open(absolute, {
        flag: "r",
        ...(noFollow ? { noFollow: true } : {}),
      });
      const before = yield* file.stat;
      if (before.type !== "File") return { kind: "unreadable" as const };
      if (before.size > BigInt(maxBytes)) return { kind: "too_large" as const, size: before.size };
      const expected = Number(before.size);
      const buffer = new Uint8Array(expected + 1);
      let read = 0;
      while (read < buffer.byteLength) {
        const count = yield* file.read(buffer.subarray(read));
        if (count === 0) break;
        read += count;
      }
      const after = yield* file.stat;
      if (
        read !== expected ||
        before.size !== after.size ||
        Option.getOrNull(before.mtime)?.getTime() !== Option.getOrNull(after.mtime)?.getTime()
      ) {
        return { kind: "changed" as const };
      }
      return { kind: "read" as const, bytes: buffer.subarray(0, read), mode: before.mode };
    }),
  );
});

const digest = (bytes: Uint8Array) =>
  Digest.Digest.pipe(Effect.flatMap((digest) => digest.digestHex(Digest.sha256, bytes)));

const sha256 = (text: string) => digest(new TextEncoder().encode(text));

const git = (cwd: string, args: ReadonlyArray<string>, maxOutputBytes = 1024 * 1024) =>
  VcsProcess.VcsProcess.pipe(
    Effect.flatMap((vcs) =>
      vcs.run({
        operation: "Garrs.workspace",
        command: "git",
        args: ["-c", "core.fsmonitor=false", ...args],
        cwd,
        allowNonZeroExit: true,
        maxOutputBytes,
        timeoutMs: 60_000,
      }),
    ),
    Effect.option,
  );

export const headSha = (cwd: string) =>
  git(cwd, ["rev-parse", "HEAD"]).pipe(
    Effect.map((result) =>
      Option.isSome(result) &&
      result.value.exitCode === 0 &&
      !result.value.stdoutTruncated &&
      !result.value.stdoutInvalidUtf8
        ? result.value.stdout.trim() || null
        : null,
    ),
  );

export const repositoryIdentity = Effect.fn("GarrsSubject.repositoryIdentity")(function* (
  directory: string,
) {
  const paths = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const result = yield* git(directory, ["rev-parse", "--git-common-dir"]);
  if (
    Option.isNone(result) ||
    result.value.exitCode !== 0 ||
    result.value.stdoutTruncated ||
    result.value.stdoutInvalidUtf8 ||
    result.value.stdout.trim() === ""
  )
    return Option.none<string>();
  return yield* fs
    .realPath(paths.resolve(directory, result.value.stdout.trim()))
    .pipe(Effect.option);
});

export const sameRepository = Effect.fn("GarrsSubject.sameRepository")(function* (
  root: string,
  checkout: string,
) {
  const first = yield* repositoryIdentity(root);
  const second = yield* repositoryIdentity(checkout);
  return Option.isSome(first) && Option.isSome(second) && first.value === second.value;
});

export const isIsolatedCheckout = Effect.fn("GarrsSubject.isIsolatedCheckout")(function* (
  root: string,
  checkout: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const sourceTop = yield* git(root, ["rev-parse", "--show-toplevel"]);
  const checkoutTop = yield* git(checkout, ["rev-parse", "--show-toplevel"]);
  const list = yield* git(root, ["worktree", "list", "--porcelain", "-z"]);
  if (Option.isNone(sourceTop) || Option.isNone(checkoutTop) || Option.isNone(list)) return false;
  if (
    [sourceTop.value, checkoutTop.value, list.value].some(
      (value) => value.exitCode !== 0 || value.stdoutTruncated || value.stdoutInvalidUtf8,
    )
  )
    return false;
  const original = yield* fs.realPath(sourceTop.value.stdout.trim()).pipe(Effect.option);
  const actual = yield* fs.realPath(checkout).pipe(Effect.option);
  const top = yield* fs.realPath(checkoutTop.value.stdout.trim()).pipe(Effect.option);
  if (
    Option.isNone(original) ||
    Option.isNone(actual) ||
    Option.isNone(top) ||
    actual.value !== top.value
  )
    return false;
  const nested = paths.relative(original.value, actual.value);
  const containsOriginal = paths.relative(actual.value, original.value);
  const inside = (relative: string) =>
    relative === "" ||
    (!paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`));
  if (inside(nested) || inside(containsOriginal)) return false;
  if (!(yield* sameRepository(root, checkout))) return false;
  const registered = list.value.stdout
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
  for (const entry of registered) {
    const resolved = yield* fs.realPath(entry).pipe(Effect.option);
    if (Option.isSome(resolved) && resolved.value === actual.value) return true;
  }
  return false;
});

export const workspaceState = Effect.fn("GarrsSubject.workspaceState")(function* (
  checkoutPath: string,
  baseSha: string | null,
) {
  const head = yield* headSha(checkoutPath);
  const base = baseSha ?? head;
  const unreadable = (reason: string): GarrsWorkspaceState => ({
    checkoutPath,
    headSha: head,
    diffHash: null,
    changedFiles: [],
    unavailableReason: reason,
  });
  if (base === null) return unreadable("The checkout HEAD could not be read.");
  const diff = yield* git(
    checkoutPath,
    [
      "-c",
      "core.quotepath=off",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--ignore-submodules=none",
      base,
    ],
    DIFF_MAX_BYTES,
  );
  const names = yield* git(checkoutPath, [
    "-c",
    "core.quotepath=off",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    "--ignore-submodules=none",
    base,
  ]);
  const raw = yield* git(checkoutPath, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--raw",
    "--no-abbrev",
    "--ignore-submodules=none",
    base,
  ]);
  const untracked = yield* git(checkoutPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const indexFlags = yield* git(checkoutPath, ["ls-files", "-v", "-z"], DIFF_MAX_BYTES);
  if (
    Option.isNone(diff) ||
    Option.isNone(names) ||
    Option.isNone(raw) ||
    Option.isNone(untracked) ||
    Option.isNone(indexFlags) ||
    diff.value.exitCode !== 0 ||
    diff.value.stdoutTruncated ||
    diff.value.stdoutInvalidUtf8 ||
    names.value.exitCode !== 0 ||
    names.value.stdoutTruncated ||
    names.value.stdoutInvalidUtf8 ||
    raw.value.exitCode !== 0 ||
    raw.value.stdoutTruncated ||
    raw.value.stdoutInvalidUtf8 ||
    untracked.value.exitCode !== 0 ||
    untracked.value.stdoutTruncated ||
    untracked.value.stdoutInvalidUtf8 ||
    indexFlags.value.exitCode !== 0 ||
    indexFlags.value.stdoutTruncated ||
    indexFlags.value.stdoutInvalidUtf8
  ) {
    return unreadable("Git could not provide a complete, readable checkout diff and file list.");
  }
  if (indexFlags.value.stdout.split("\0").some((entry) => /^[a-zS] /.test(entry))) {
    return unreadable(
      "Git index flags hide tracked files; clear assume-unchanged and skip-worktree before review.",
    );
  }
  if (
    raw.value.stdout.split("\n").some((line) => /^:(160000 [0-7]{6}|[0-7]{6} 160000) /.test(line))
  ) {
    return unreadable("The checkout has a changed submodule whose full state cannot be verified.");
  }
  const untrackedFiles = untracked.value.stdout.split("\0").filter(Boolean);
  if (untrackedFiles.length > 2_000)
    return unreadable(
      "The checkout has more than 2,000 untracked files; the review state is incomplete.",
    );
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const untrackedHashes: Array<string> = [];
  let totalBytes = 0;
  for (const file of untrackedFiles) {
    const absolute = path.join(checkoutPath, file);
    const target = yield* fileSystem.readLink(absolute).pipe(Effect.option);
    if (Option.isSome(target)) {
      untrackedHashes.push(`${file}:link:${target.value}`);
      continue;
    }
    const remaining = UNTRACKED_MAX_TOTAL_BYTES - totalBytes;
    const data = yield* readBounded(
      absolute,
      Math.min(UNTRACKED_MAX_FILE_BYTES, remaining),
      true,
    ).pipe(Effect.option);
    if (Option.isNone(data) || data.value.kind === "unreadable" || data.value.kind === "changed")
      return unreadable(
        "An untracked file could not be read completely or changed while being read.",
      );
    if (data.value.kind === "too_large")
      return unreadable(
        data.value.size > BigInt(UNTRACKED_MAX_FILE_BYTES)
          ? "An untracked file exceeds the 4 MiB per-file limit."
          : "Untracked files exceed the 32 MiB total limit.",
      );
    totalBytes += data.value.bytes.byteLength;
    const hash = yield* digest(data.value.bytes);
    untrackedHashes.push(`${file}:file:${data.value.mode & 0o111}:${hash}`);
  }
  const changedFiles = [
    ...new Set([...names.value.stdout.split("\0").filter(Boolean), ...untrackedFiles]),
  ];
  return {
    checkoutPath,
    headSha: head,
    diffHash: yield* sha256(`${diff.value.stdout}\0${untrackedHashes.join("\0")}`),
    changedFiles: changedFiles.slice(0, 500),
  } satisfies GarrsWorkspaceState;
});

export const readRules = Effect.fn("GarrsSubject.readRules")(function* (
  root: string,
  rulePaths: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  const readAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  return yield* Effect.forEach(
    rulePaths,
    (rulePath): Effect.Effect<GarrsRuleSnapshot, never, Digest.Digest | FileSystem.FileSystem> => {
      const absolute = path.resolve(root, rulePath);
      const relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return Effect.succeed({
          path: rulePath,
          status: "outside_project",
          sha256: null,
          bytes: 0,
          readAt,
        });
      }
      return readBounded(absolute, RULE_MAX_BYTES, false).pipe(
        Effect.flatMap((result): Effect.Effect<GarrsRuleSnapshot, never, Digest.Digest> => {
          if (result.kind === "too_large")
            return Effect.succeed({
              path: rulePath,
              status: "truncated",
              sha256: null,
              bytes: Number(
                result.size > BigInt(Number.MAX_SAFE_INTEGER)
                  ? BigInt(Number.MAX_SAFE_INTEGER)
                  : result.size,
              ),
              readAt,
            });
          if (result.kind !== "read")
            return Effect.succeed({
              path: rulePath,
              status: "unreadable",
              sha256: null,
              bytes: 0,
              readAt,
            });
          return digest(result.bytes).pipe(
            Effect.map((hash): GarrsRuleSnapshot => ({
              path: rulePath,
              status: "read",
              sha256: hash,
              bytes: result.bytes.byteLength,
              readAt,
            })),
          );
        }),
        Effect.catch((error) =>
          Effect.succeed({
            path: rulePath,
            status: error.reason._tag === "NotFound" ? "missing" : "unreadable",
            sha256: null,
            bytes: 0,
            readAt,
          } satisfies GarrsRuleSnapshot),
        ),
      );
    },
  );
});

export const subjectOf = Effect.fn("GarrsSubject.subjectOf")(function* (
  aggregate: WorkAggregate,
  root: string | null,
) {
  const { workItem } = aggregate;
  if (root === null)
    return { hash: null, state: null, reason: "The project is unavailable in this environment." };
  const rules = yield* readRules(
    root,
    workItem.rules.map((rule) => rule.path),
  );
  const unavailableRule = rules.find((rule) => rule.status !== "read" && rule.status !== "missing");
  if (unavailableRule !== undefined)
    return {
      hash: null,
      state: null,
      reason: `Rule ${unavailableRule.path} is ${unavailableRule.status}.`,
    };
  const checkout = workItem.workspace?.checkoutPath ?? null;
  if (workItem.access === "write" && workItem.workspace?.baseSha == null) {
    return { hash: null, state: null, reason: "The primary checkout base commit is unavailable." };
  }
  const checkoutRules =
    workItem.access === "write" && checkout !== null && checkout !== root
      ? yield* readRules(
          checkout,
          workItem.rules.map((rule) => rule.path),
        )
      : [];
  const unavailableCheckoutRule = checkoutRules.find(
    (rule, index) =>
      rule.status !== "read" && (rule.status !== "missing" || rules[index]?.status === "read"),
  );
  if (unavailableCheckoutRule !== undefined)
    return {
      hash: null,
      state: null,
      reason: `Rule ${unavailableCheckoutRule.path} is ${unavailableCheckoutRule.status} in the checkout.`,
    };
  const state =
    workItem.access === "write" && checkout !== null
      ? yield* workspaceState(checkout, workItem.workspace?.baseSha ?? null)
      : null;
  if (workItem.access === "write" && state?.diffHash == null)
    return {
      hash: null,
      state,
      reason: state?.unavailableReason ?? "The checkout is not available.",
    };
  if (
    workItem.access === "write" &&
    checkout !== null &&
    !(yield* isIsolatedCheckout(root, checkout))
  ) {
    return {
      hash: null,
      state,
      reason: "The isolated checkout does not belong to the project repository.",
    };
  }
  const projectFields: Array<string> = [];
  const additional = workItem.projectContexts ?? [];
  if (workItem.access === "read_only") {
    const primaryState = yield* workspaceState(root, null);
    if (primaryState.diffHash === null) {
      return {
        hash: null,
        state,
        reason: primaryState.unavailableReason ?? "The primary checkout cannot be verified.",
      };
    }
    if (
      additional.length > 0 &&
      (workItem.readOnlyBaseline?.headSha !== primaryState.headSha ||
        workItem.readOnlyBaseline.diffHash !== primaryState.diffHash ||
        !sameRules(workItem.rules, rules))
    ) {
      return {
        hash: null,
        state,
        reason: "The primary project changed; replan the work against its current state.",
      };
    }
    projectFields.push(workItem.projectId, primaryState.headSha ?? "", primaryState.diffHash);
  }
  if (additional.length > 0) {
    const seen = new Set([workItem.projectId]);
    for (const project of additional) {
      if (
        seen.has(project.projectId) ||
        project.workspace.projectId !== project.projectId ||
        project.workspace.checkoutPath === null
      ) {
        return {
          hash: null,
          state,
          reason: "A project checkout is missing or has inconsistent identity.",
        };
      }
      seen.add(project.projectId);
      const projectRoot =
        workItem.access === "write" ? project.projectRoot : project.workspace.checkoutPath;
      if (
        projectRoot === undefined ||
        projectRoot === null ||
        (workItem.access === "write" && project.workspace.baseSha === null) ||
        (workItem.access === "write" &&
          (!project.workspace.isolated ||
            !(yield* isIsolatedCheckout(projectRoot, project.workspace.checkoutPath))))
      ) {
        return {
          hash: null,
          state,
          reason: `The checkout for project ${project.projectId} does not belong to its repository.`,
        };
      }
      const projectRules = yield* readRules(
        projectRoot,
        project.rules.map((rule) => rule.path),
      );
      const unavailable = projectRules.find(
        (rule) => rule.status !== "read" && rule.status !== "missing",
      );
      if (unavailable !== undefined) {
        return {
          hash: null,
          state,
          reason: `Rule ${unavailable.path} is ${unavailable.status} in project ${project.projectId}.`,
        };
      }
      const projectCheckoutRules =
        workItem.access === "write"
          ? yield* readRules(
              project.workspace.checkoutPath,
              project.rules.map((rule) => rule.path),
            )
          : [];
      const missingCheckoutRule = projectCheckoutRules.find(
        (rule, index) =>
          rule.status !== "read" &&
          (rule.status !== "missing" || projectRules[index]?.status === "read"),
      );
      if (missingCheckoutRule !== undefined) {
        return {
          hash: null,
          state,
          reason: `Rule ${missingCheckoutRule.path} is ${missingCheckoutRule.status} in project ${project.projectId}'s checkout.`,
        };
      }
      const projectState = yield* workspaceState(
        project.workspace.checkoutPath,
        workItem.access === "write" ? project.workspace.baseSha : null,
      );
      if (projectState.diffHash === null) {
        return {
          hash: null,
          state,
          reason:
            projectState.unavailableReason ?? `Project ${project.projectId} cannot be verified.`,
        };
      }
      if (
        workItem.access === "read_only" &&
        (project.workspace.baseSha !== projectState.headSha ||
          project.baselineDiffHash !== projectState.diffHash ||
          !sameRules(project.rules, projectRules))
      ) {
        return {
          hash: null,
          state,
          reason: `Project ${project.projectId} changed; replan the work against its current state.`,
        };
      }
      projectFields.push(
        project.projectId,
        projectState.headSha ?? "",
        projectState.diffHash,
        ...projectRules.flatMap((rule) => [rule.path, rule.status, rule.sha256 ?? ""]),
        ...projectCheckoutRules.flatMap((rule) => [rule.path, rule.status, rule.sha256 ?? ""]),
      );
    }
  }
  const reviewTask = (task: WorkAggregate["tasks"][number]) =>
    task.helper === undefined &&
    task.agentId !== "copito" &&
    task.status !== "cancelled" &&
    !(workItem.access === "write" && task.agentId === "kex" && task.capability === "read");
  const commit = workItem.commitProposal;
  // The server's exact approved commit preserves the reviewed tree and its original parent.
  const reviewedHead =
    commit !== undefined &&
    ["prepared", "committed"].includes(commit.status) &&
    commit.projectId === workItem.projectId &&
    commit.checkoutPath === checkout &&
    commit.commitSha === state?.headSha
      ? commit.parentSha
      : state?.headSha;
  const fields = [
    workItem.title,
    workItem.objective,
    workItem.intent,
    ...aggregate.tasks.flatMap((task) =>
      reviewTask(task)
        ? [
            task.key,
            task.projectId,
            task.agentId,
            task.capability,
            task.objective,
            ...task.acceptanceCriteria,
          ]
        : [],
    ),
    ...aggregate.artifacts.flatMap((artifact) =>
      aggregate.tasks.some((task) => task.id === artifact.taskId && reviewTask(task))
        ? [artifact.id, artifact.kind, artifact.summary, artifact.body, ...artifact.evidence]
        : [],
    ),
    ...rules.flatMap((rule) => [rule.path, rule.status, rule.sha256 ?? ""]),
    ...checkoutRules.flatMap((rule) => [rule.path, rule.status, rule.sha256 ?? ""]),
    state?.diffHash ?? "",
    reviewedHead ?? "",
    ...projectFields,
  ];
  return {
    hash: yield* sha256(fields.map((field) => `${field.length}:${field}`).join("")),
    state,
    reason: null,
  };
});
