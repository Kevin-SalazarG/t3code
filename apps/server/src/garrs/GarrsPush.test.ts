import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Push from "./GarrsPush.ts";

it.effect("pushes only the approved commit and destination and refuses moved or dirty state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-push-" });
    const root = path.join(dir, "repo");
    const remote = path.join(dir, "remote.git");
    yield* fs.makeDirectory(root);
    const git = (args: ReadonlyArray<string>) =>
      vcs.run({ operation: "GarrsPush.test", command: "git", cwd: root, args });
    yield* git(["init", "--quiet", "--initial-branch=feature"]);
    yield* git(["config", "user.name", "Test"]);
    yield* git(["config", "user.email", "test@example.com"]);
    yield* fs.writeFileString(path.join(root, "file"), "base");
    yield* git(["add", "file"]);
    yield* git(["commit", "--quiet", "-m", "base"]);
    const sha = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
    yield* git(["init", "--quiet", "--bare", remote]);
    yield* git(["remote", "add", "origin", remote]);
    const input = {
      checkoutPath: root,
      commitSha: sha,
      localBranchRef: "refs/heads/feature",
      remote: "origin",
      branchRef: "refs/heads/reviewed",
    };
    const inspected = yield* Push.inspect(input);
    expect(inspected?.expectedRemoteSha).toBeNull();
    expect(
      yield* Push.remoteSha({ ...input, destinationHash: inspected!.destinationHash }),
    ).toEqual({ sha: null });
    yield* git(["remote", "set-url", "origin", path.join(dir, "other.git")]);
    expect(yield* Push.execute({ ...input, ...inspected! })).toBe(false);
    yield* git(["remote", "set-url", "origin", remote]);
    yield* fs.writeFileString(path.join(root, "file"), "unstaged");
    expect(yield* Push.execute({ ...input, ...inspected! })).toBe(false);
    yield* fs.writeFileString(path.join(root, "file"), "base");
    yield* git(["update-index", "--assume-unchanged", "file"]);
    yield* fs.writeFileString(path.join(root, "file"), "hidden");
    expect(yield* Push.inspect(input)).toBeNull();
    yield* git(["update-index", "--no-assume-unchanged", "file"]);
    yield* fs.writeFileString(path.join(root, "file"), "base");
    expect(yield* Push.execute({ ...input, ...inspected! })).toBe(true);
    expect(
      yield* Push.remoteSha({ ...input, destinationHash: inspected!.destinationHash }),
    ).toEqual({ sha });
    const refs = (yield* git([
      "--git-dir",
      remote,
      "for-each-ref",
      "--format=%(refname)",
    ])).stdout.trim();
    expect(refs).toBe("refs/heads/reviewed");
    expect(yield* Push.execute({ ...input, ...inspected! })).toBe(false);
    const tree = (yield* git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const unrelated = (yield* git([
      "--git-dir",
      remote,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit-tree",
      tree,
      "-m",
      "Unrelated remote history",
    ])).stdout.trim();
    yield* git(["--git-dir", remote, "update-ref", input.branchRef, unrelated, sha]);
    expect(yield* Push.inspect(input)).toBeNull();
    expect(yield* Push.execute({ ...input, ...inspected! })).toBe(false);
    expect((yield* git(["--git-dir", remote, "rev-parse", input.branchRef])).stdout.trim()).toBe(
      unrelated,
    );
    yield* git(["config", "--add", "remote.origin.pushurl", remote]);
    yield* git(["config", "--add", "remote.origin.pushurl", path.join(dir, "other.git")]);
    expect(yield* Push.inspect(input)).toBeNull();
  }).pipe(
    Effect.provide(
      VcsProcess.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
