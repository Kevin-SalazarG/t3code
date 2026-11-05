import type { GarrsWorkspaceBinding } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Subject from "./GarrsSubject.ts";

export const bind = Effect.fn("GarrsCheckout.bind")(function* (
  root: string,
  checkout: string,
  binding: GarrsWorkspaceBinding,
) {
  if (
    !binding.isolated ||
    binding.baseSha === null ||
    !(yield* Subject.isIsolatedCheckout(root, checkout))
  )
    return null;
  if (binding.checkoutPath !== null) {
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* fs.realPath(binding.checkoutPath).pipe(Effect.option);
    const incoming = yield* fs.realPath(checkout).pipe(Effect.option);
    if (Option.isNone(existing) || Option.isNone(incoming) || existing.value !== incoming.value)
      return null;
    return binding;
  }
  const head = yield* Subject.headSha(checkout);
  if (head !== binding.baseSha) return null;
  return { ...binding, checkoutPath: checkout };
});
