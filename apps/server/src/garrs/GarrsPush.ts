import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as VcsProcess from "../vcs/VcsProcess.ts";

interface PushInput {
  readonly checkoutPath: string;
  readonly commitSha: string;
  readonly localBranchRef: string;
  readonly remote: string;
  readonly branchRef: string;
}
interface ApprovedDestination {
  readonly destinationHash: string;
  readonly expectedRemoteSha: string | null;
}
const git = (cwd: string, args: ReadonlyArray<string>) =>
  VcsProcess.VcsProcess.pipe(
    Effect.flatMap((vcs) =>
      vcs.run({
        operation: "GarrsPush.git",
        command: "git",
        cwd,
        args: [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.file.allow=always",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "protocol.ssh.allow=always",
          ...args,
        ],
        env: { GIT_TERMINAL_PROMPT: "0" },
        allowNonZeroExit: true,
        maxOutputBytes: 64_000,
        timeoutMs: 60_000,
      }),
    ),
    Effect.option,
  );
const read = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
  const result = yield* git(cwd, args);
  return Option.isSome(result) &&
    result.value.exitCode === 0 &&
    !result.value.stdoutTruncated &&
    !result.value.stdoutInvalidUtf8
    ? result.value.stdout.trim()
    : null;
});
const destination = Effect.fn("GarrsPush.destination")(function* (input: PushInput) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.remote) ||
    !input.branchRef.startsWith("refs/heads/") ||
    (yield* read(input.checkoutPath, ["check-ref-format", input.branchRef])) === null
  )
    return null;
  const rewrites = yield* git(input.checkoutPath, [
    "config",
    "--get-regexp",
    "^url\\..*\\.(insteadof|pushinsteadof)$",
  ]);
  if (Option.isNone(rewrites) || rewrites.value.exitCode !== 1) return null;
  const urls = yield* read(input.checkoutPath, [
    "remote",
    "get-url",
    "--push",
    "--all",
    input.remote,
  ]);
  if (urls === null || /[\r\n\0]/.test(urls) || urls.length === 0 || urls.startsWith("-"))
    return null;
  const path = yield* Path.Path;
  let url: string;
  let display: string;
  if (urls.includes("://")) {
    if (!URL.canParse(urls)) return null;
    const parsed = new URL(urls);
    if (!["https:", "ssh:", "file:"].includes(parsed.protocol)) return null;
    url = urls;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    display = parsed.toString();
  } else if (/^(?:[^/@:\s]+@)?[^/:\s]+:[^\s]+$/.test(urls)) {
    url = urls;
    display = urls.replace(/^[^@]+@/, "");
  } else {
    if (urls.includes("::")) return null;
    url = path.resolve(input.checkoutPath, urls);
    display = url;
  }
  const digest = yield* Digest.Digest;
  const destinationHash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(url));
  return { url, destination: display, destinationHash };
});
const advertised = Effect.fn("GarrsPush.advertised")(function* (input: PushInput, url: string) {
  const result = yield* git(input.checkoutPath, [
    "ls-remote",
    "--exit-code",
    "--refs",
    "--",
    url,
    input.branchRef,
  ]);
  if (Option.isNone(result) || result.value.stdoutTruncated || result.value.stdoutInvalidUtf8)
    return null;
  if (result.value.exitCode === 2 && result.value.stdout.trim() === "") return { sha: null };
  if (result.value.exitCode !== 0) return null;
  const lines = result.value.stdout.trim().split("\n");
  const [sha, ref] = lines[0]?.split("\t") ?? [];
  return lines.length === 1 &&
    ref === input.branchRef &&
    sha !== undefined &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)
    ? { sha }
    : null;
});
const clean = Effect.fn("GarrsPush.clean")(function* (input: PushInput) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.commitSha)) return false;
  const flags = yield* git(input.checkoutPath, ["ls-files", "-v", "-z"]);
  if (
    Option.isNone(flags) ||
    flags.value.exitCode !== 0 ||
    flags.value.stdoutTruncated ||
    flags.value.stdoutInvalidUtf8 ||
    flags.value.stdout.split("\0").some((entry) => /^[a-zS] /.test(entry))
  )
    return false;
  return (
    (yield* read(input.checkoutPath, ["rev-parse", "HEAD"])) === input.commitSha &&
    (yield* read(input.checkoutPath, ["symbolic-ref", "--quiet", "HEAD"])) ===
      input.localBranchRef &&
    (yield* read(input.checkoutPath, ["status", "--porcelain=v1", "--untracked-files=all"])) === ""
  );
});

export const inspect = Effect.fn("GarrsPush.inspect")(function* (input: PushInput) {
  if (!(yield* clean(input))) return null;
  const target = yield* destination(input);
  if (target === null) return null;
  const remote = yield* advertised(input, target.url);
  if (remote === null) return null;
  if (
    remote.sha !== null &&
    (yield* read(input.checkoutPath, [
      "merge-base",
      "--is-ancestor",
      remote.sha,
      input.commitSha,
    ])) === null
  )
    return null;
  return {
    destination: target.destination,
    destinationHash: target.destinationHash,
    expectedRemoteSha: remote.sha,
  };
});

export const remoteSha = Effect.fn("GarrsPush.remoteSha")(function* (
  input: PushInput & Pick<ApprovedDestination, "destinationHash">,
) {
  const target = yield* destination(input);
  return target?.destinationHash === input.destinationHash
    ? yield* advertised(input, target.url)
    : null;
});

export const execute = Effect.fn("GarrsPush.execute")(function* (
  input: PushInput & ApprovedDestination,
) {
  const current = yield* inspect(input);
  if (
    current === null ||
    current.destinationHash !== input.destinationHash ||
    current.expectedRemoteSha !== input.expectedRemoteSha
  )
    return false;
  const target = yield* destination(input);
  if (target?.destinationHash !== input.destinationHash) return false;
  const result = yield* git(input.checkoutPath, [
    "-c",
    "push.followTags=false",
    "-c",
    "remote.pushDefault=",
    "push",
    "--porcelain",
    "--no-force",
    "--no-verify",
    "--no-follow-tags",
    "--recurse-submodules=no",
    "--",
    target.url,
    `${input.commitSha}:${input.branchRef}`,
  ]);
  return Option.isSome(result) && result.value.exitCode === 0;
});
