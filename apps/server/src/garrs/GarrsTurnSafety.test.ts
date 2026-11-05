import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { WorkAggregate } from "./GarrsDomain.ts";
import { unfinishedWriteTurns } from "./GarrsTurnSafety.ts";

it.effect("waits for a writer's provider turn even after it reports completion", () =>
  Effect.gen(function* () {
    const aggregate = {
      attempts: [{ id: "attempt", taskId: "task", threadId: "thread", status: "completed" }],
      tasks: [{ id: "task", capability: "write" }],
    } as unknown as WorkAggregate;
    const projection = (status: string) => ({ runs: [{ ordinal: 1, status }] }) as never;
    expect(
      yield* unfinishedWriteTurns(aggregate, () => Effect.succeed(projection("running"))),
    ).toBe(true);
    expect(yield* unfinishedWriteTurns(aggregate, () => Effect.succeed(null))).toBe(true);
    expect(
      yield* unfinishedWriteTurns(aggregate, () => Effect.succeed(projection("completed"))),
    ).toBe(false);
  }),
);
