import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Checkout from "./GarrsCheckout.ts";

it.effect("binds the prepared worktree to its own project and refuses substituted checkouts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "garrs-checkout-" });
    const root = path.join(dir, "project");
    const checkout = path.join(dir, "checkout");
    yield* fs.makeDirectory(root);
    const git = (args: ReadonlyArray<string>) =>
      vcs.run({ operation: "GarrsCheckout.test", command: "git", cwd: root, args });
    yield* git(["init", "--quiet"]);
    yield* git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "base",
    ]);
    const head = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
    yield* git(["worktree", "add", "--quiet", "--detach", checkout]);
    const binding = {
      projectId: ProjectId.make("project"),
      checkoutPath: null,
      isolated: true,
      baseSha: head,
    };
    const bound = yield* Checkout.bind(root, checkout, binding);
    expect(bound?.checkoutPath).toBe(checkout);
    expect(yield* Checkout.bind(root, root, binding)).toBeNull();
    expect(yield* Checkout.bind(root, checkout, { ...binding, baseSha: "wrong" })).toBeNull();
    expect(yield* Checkout.bind(root, root, bound!)).toBeNull();
  }).pipe(Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);
