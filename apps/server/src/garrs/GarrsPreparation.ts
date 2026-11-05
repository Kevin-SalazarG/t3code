import type { GarrsPreparationCheck, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const inspect = Effect.fn("GarrsPreparation.inspect")(
  function* (projectId: ProjectId, checkout: string | null) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (checkout === null)
      return [
        {
          projectId,
          status: "unknown",
          message: "The checkout is not available for preparation checks.",
        },
      ] satisfies ReadonlyArray<GarrsPreparationCheck>;
    if (!(yield* fs.exists(path.join(checkout, "package.json")))) return [];
    const modules = path.join(checkout, "node_modules");
    if (!(yield* fs.exists(modules)))
      return [
        {
          projectId,
          status: "attention",
          message:
            "Node dependencies are missing from this checkout. Garrs skips project setup scripts; prepare dependencies before running checks.",
        },
      ] satisfies ReadonlyArray<GarrsPreparationCheck>;
    const target = yield* fs.realPath(modules);
    const root = yield* fs.realPath(checkout);
    const relative = path.relative(root, target);
    return [
      {
        projectId,
        status:
          relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
            ? "attention"
            : "ready",
        message:
          relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
            ? "Node dependencies resolve outside this checkout. Verify that the build supports this layout."
            : "Node dependencies are present. Required services and build compatibility still need verification.",
      },
    ] satisfies ReadonlyArray<GarrsPreparationCheck>;
  },
  (effect, projectId) =>
    effect.pipe(
      Effect.orElseSucceed(() => [
        {
          projectId,
          status: "unknown" as const,
          message: "Checkout preparation could not be inspected.",
        },
      ]),
    ),
);
