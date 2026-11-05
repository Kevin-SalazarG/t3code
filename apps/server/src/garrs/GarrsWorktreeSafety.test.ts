import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { worktreeSafety } from "./GarrsWorktreeSafety.ts";

it.effect("rejects configured checkout filters and committed submodules", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const vcs = yield* VcsProcess.VcsProcess;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-worktree-safety-" });
    const git = (args: ReadonlyArray<string>) =>
      vcs.run({ operation: "GarrsWorktreeSafety.test", command: "git", cwd: root, args });
    yield* git(["init", "--quiet"]);
    const commit = [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
    ];
    yield* git([...commit, "--allow-empty", "-m", "base"]);
    expect(yield* worktreeSafety(root, "HEAD")).toBeNull();
    yield* git(["config", "filter.test.smudge", "touch should-not-run"]);
    expect(yield* worktreeSafety(root, "HEAD")).toContain("filter");
    yield* git(["config", "--unset", "filter.test.smudge"]);
    const head = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
    yield* git(["update-index", "--add", "--cacheinfo", `160000,${head},nested`]);
    yield* git([...commit, "-m", "submodule"]);
    expect(yield* worktreeSafety(root, "HEAD")).toContain("submodule");
  }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
