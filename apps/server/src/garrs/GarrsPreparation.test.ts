import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { inspect } from "./GarrsPreparation.ts";

it.effect.each(["unprepared", "other-stack", "missing", "local", "external"] as const)(
  "reports checkout preparation without claiming a build passed: %s",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      if (scenario !== "other-stack")
        yield* fs.writeFileString(path.join(root, "package.json"), "{}");
      if (scenario === "local") yield* fs.makeDirectory(path.join(root, "node_modules"));
      if (scenario === "external") {
        const dependencies = yield* fs.makeTempDirectoryScoped();
        yield* fs.symlink(dependencies, path.join(root, "node_modules"));
      }
      const checks = yield* inspect(
        ProjectId.make("project"),
        scenario === "unprepared" ? null : root,
      );
      expect(checks.map((check) => check.status)).toEqual(
        scenario === "other-stack"
          ? []
          : [scenario === "unprepared" ? "unknown" : scenario === "local" ? "ready" : "attention"],
      );
      if (scenario === "local") expect(checks[0]?.message).toContain("still need verification");
      if (scenario === "external") expect(checks[0]?.message).toContain("outside this checkout");
    }).pipe(Effect.provide(NodeServices.layer)),
);
