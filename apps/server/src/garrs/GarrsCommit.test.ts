import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Commit from "./GarrsCommit.ts";

it.effect("proposes only a complete staged tree on an attached branch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-commit-" });
    const root = path.join(parent, "repo");
    const other = path.join(parent, "other");
    yield* fs.makeDirectory(root);
    const git = (args: ReadonlyArray<string>) =>
      vcs.run({ operation: "GarrsCommit.test", command: "git", cwd: root, args });
    yield* git(["init", "--quiet", "--initial-branch=feature"]);
    yield* fs.writeFileString(path.join(root, "file"), "base");
    yield* git(["add", "file"]);
    yield* git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "base",
    ]);
    expect(yield* Commit.inspect(root)).toBeNull();
    yield* fs.writeFileString(path.join(root, "file"), "changed");
    expect(yield* Commit.inspect(root)).toBeNull();
    yield* git(["config", "filter.test.clean", "false"]);
    expect(yield* Commit.prepare(root)).not.toBeNull();
    yield* git(["config", "--unset", "filter.test.clean"]);
    yield* fs.writeFileString(path.join(root, "new-file"), "new");
    expect(yield* Commit.prepare(root)).toBeNull();
    expect((yield* git(["diff", "--cached", "--name-only"])).stdout).toContain("new-file");
    yield* git(["reset", "--quiet", "HEAD", "--", "new-file"]);
    yield* fs.remove(path.join(root, "new-file"));
    const proposed = yield* Commit.inspect(root);
    expect(proposed?.branchRef).toBe("refs/heads/feature");
    expect(proposed?.parentSha).toHaveLength(40);
    expect(proposed?.treeSha).toHaveLength(40);
    expect(proposed?.diff).toContain("+changed");
    yield* fs.writeFileString(path.join(root, "file"), "x".repeat(65_000));
    yield* git(["add", "file"]);
    expect(yield* Commit.inspect(root)).toBeNull();
    yield* fs.writeFileString(path.join(root, "file"), "changed");
    yield* git(["add", "file"]);
    yield* git(["update-index", "--assume-unchanged", "file"]);
    yield* fs.writeFileString(path.join(root, "file"), "hidden change");
    expect(yield* Commit.inspect(root)).toBeNull();
    yield* git(["update-index", "--no-assume-unchanged", "file"]);
    yield* fs.writeFileString(path.join(root, "file"), "changed");
    yield* git(["add", "file"]);
    yield* git(["update-index", "--skip-worktree", "file"]);
    yield* fs.writeFileString(path.join(root, "file"), "hidden skip change");
    expect(yield* Commit.inspect(root)).toBeNull();
    yield* git(["update-index", "--no-skip-worktree", "file"]);
    yield* fs.writeFileString(path.join(root, "file"), "changed");
    yield* git(["add", "file"]);
    yield* git(["worktree", "add", "--force", "--quiet", other, "feature"]);
    expect(yield* Commit.inspect(root)).toBeNull();
    yield* git(["worktree", "remove", "--force", other]);
    expect((yield* Commit.inspect(root))?.treeSha).toBe(proposed?.treeSha);
    yield* fs.writeFileString(path.join(root, "untracked"), "new");
    expect(yield* Commit.inspect(root)).toBeNull();
    yield* fs.remove(path.join(root, "untracked"));
    yield* fs.writeFileString(path.join(root, "file"), "changed again");
    expect(yield* Commit.inspect(root)).toBeNull();
    yield* git(["add", "file"]);
    expect((yield* Commit.inspect(root))?.treeSha).not.toBe(proposed?.treeSha);
    const current = (yield* Commit.inspect(root))!;
    yield* git(["config", "user.name", "Test"]);
    yield* git(["config", "user.email", "test@example.com"]);
    const sha = yield* Commit.createObject({
      ...current,
      checkoutPath: root,
      message: "test: approved",
    });
    expect(sha).not.toBeNull();
    const moved = yield* Commit.moveRef({ ...current, checkoutPath: root, commitSha: sha! });
    expect(moved).toBe(true);
    expect((yield* git(["rev-parse", "HEAD"])).stdout.trim()).toBe(sha);
    expect(yield* Commit.moveRef({ ...current, checkoutPath: root, commitSha: sha! })).toBe(false);
    yield* git(["checkout", "--quiet", "--detach"]);
    expect(yield* Commit.inspect(root)).toBeNull();
  }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
