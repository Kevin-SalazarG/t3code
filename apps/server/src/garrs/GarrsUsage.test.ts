import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { usageFrom } from "./GarrsUsage.ts";
import { estimateUsage } from "./GarrsUsage.ts";

const at = (value: string) => DateTime.makeUnsafe(`2026-10-31T${value}Z`);
const run = (requested: string, started: string | null, completed: string | null) => ({
  requestedAt: at(requested),
  startedAt: started === null ? null : at(started),
  completedAt: completed === null ? null : at(completed),
});

describe("Garrs attempt usage", () => {
  it("attributes distinct provider turns once and totals wait and run time across runs", () => {
    const first = {
      id: "turn-1",
      turnTokenUsage: {
        usageScope: "main_agent" as const,
        usageStatus: "complete" as const,
        hasSubagents: false,
        inputTokens: 100,
        cachedInputTokens: 30,
        cacheCreationTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
        models: ["actual-model"],
        reportedCost: {
          amountUsd: 0.25,
          source: "provider_api_report" as const,
          scope: "query_delta" as const,
          status: "complete" as const,
        },
      },
    };
    const second = {
      id: "turn-2",
      turnTokenUsage: {
        usageScope: "main_agent" as const,
        usageStatus: "complete" as const,
        hasSubagents: false,
        inputTokens: 40,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
        models: ["actual-model"],
        reportedCost: {
          amountUsd: 0.1,
          source: "provider_api_report" as const,
          scope: "query_delta" as const,
          status: "complete" as const,
        },
      },
    };
    expect(
      usageFrom({
        providerTurns: [first, first, second],
        runs: [run("12:00:00", "12:00:01", "12:00:04"), run("12:01:00", "12:01:02", "12:01:06")],
      }),
    ).toEqual({
      quality: "reported",
      inputTokens: 140,
      cachedInputTokens: 30,
      cacheCreationTokens: 10,
      outputTokens: 30,
      reasoningOutputTokens: 5,
      providerTurns: 2,
      queueWaitMs: 3_000,
      runDurationMs: 7_000,
      reportedModels: ["actual-model"],
      modelIdentityComplete: true,
      reportedCost: {
        amountUsd: 0.35,
        source: "provider_api_report",
        scope: "query_delta",
        status: "complete",
      },
    });
  });

  it("reports incomplete turns as partial and missing run durations as unknown", () => {
    expect(
      usageFrom({
        providerTurns: [
          {
            id: "turn-1",
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "partial",
              hasSubagents: false,
              inputTokens: 9,
              models: ["one-response"],
              reportedCost: {
                amountUsd: 0.12,
                source: "provider_api_report",
                scope: "query_delta",
                status: "complete",
              },
            },
          },
          { id: "turn-2" },
        ],
        runs: [run("12:00:00", "12:00:01", null)],
      }),
    ).toMatchObject({
      quality: "partial",
      inputTokens: null,
      outputTokens: null,
      queueWaitMs: 1_000,
      runDurationMs: null,
      reportedModels: ["one-response"],
      modelIdentityComplete: false,
      reportedCost: {
        amountUsd: 0.12,
        source: "provider_api_report",
        scope: "query_delta",
        status: "partial",
      },
    });
    expect(usageFrom({ providerTurns: [], runs: [] })).toMatchObject({
      quality: "unknown",
      queueWaitMs: null,
      runDurationMs: null,
    });
  });

  it("treats all-zero partial usage as unknown while retaining complete zeros and positive partial usage", () => {
    const turn = (
      usageStatus: "complete" | "partial",
      inputTokens: number,
      outputTokens: number,
    ) => ({
      id: "one",
      turnTokenUsage: {
        usageScope: "main_agent" as const,
        usageStatus,
        hasSubagents: false,
        inputTokens,
        outputTokens,
      },
    });
    const zero = usageFrom({ providerTurns: [turn("partial", 0, 0)], runs: [] });
    expect(zero).toMatchObject({ quality: "unknown", inputTokens: null, outputTokens: null });
    const complete = usageFrom({ providerTurns: [turn("complete", 0, 0)], runs: [] });
    expect(complete).toMatchObject({ quality: "reported", inputTokens: 0, outputTokens: 0 });
    const positive = usageFrom({ providerTurns: [turn("partial", 5, 0)], runs: [] });
    expect(positive).toMatchObject({ quality: "partial", inputTokens: 5, outputTokens: 0 });
  });

  it("marks main-agent totals as partial when native subagents also ran", () => {
    expect(
      usageFrom({
        providerTurns: [
          {
            id: "turn-1",
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: true,
              inputTokens: 100,
              cachedInputTokens: 20,
              cacheCreationTokens: 0,
              outputTokens: 30,
            },
          },
        ],
        runs: [],
      }),
    ).toMatchObject({ quality: "partial", inputTokens: 100, outputTokens: 30 });
  });

  it.each([
    [
      "model",
      { instanceId: "codex", model: "model-b", options: [{ id: "serviceTier", value: "default" }] },
    ],
    [
      "options",
      {
        instanceId: "codex",
        model: "model-a",
        options: [{ id: "serviceTier", value: "priority" }],
      },
    ],
  ])("refuses single-model pricing when a continuation changes %s", (_change, nextSelection) => {
    const firstSelection = {
      instanceId: "codex",
      model: "model-a",
      options: [{ id: "serviceTier", value: "default" }],
    };
    const first = { ...run("12:00:00", "12:00:01", "12:00:04"), modelSelection: firstSelection };
    const second = { ...run("12:01:00", "12:01:02", "12:01:06"), modelSelection: nextSelection };
    const turnUsage = {
      usageScope: "main_agent" as const,
      usageStatus: "complete" as const,
      hasSubagents: false,
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationTokens: 0,
      outputTokens: 30,
    };
    expect(
      usageFrom({
        providerTurns: [
          { id: "turn-1", turnTokenUsage: turnUsage },
          { id: "turn-2", turnTokenUsage: turnUsage },
        ],
        runs: [first, second],
      }),
    ).toMatchObject({
      pricingSelectionConsistent: false,
    });
  });

  it("does not price a run whose selection differs from the request or uses fast mode", () => {
    const requested = { instanceId: "codex", model: "model-a" };
    const base = run("12:00:00", "12:00:01", "12:00:04");
    expect(
      usageFrom(
        {
          providerTurns: [],
          runs: [{ ...base, modelSelection: { ...requested, model: "model-b" } }],
        },
        requested,
      ),
    ).toMatchObject({ pricingSelectionConsistent: false });
    const fast = { ...requested, options: [{ id: "fastMode", value: true }] };
    expect(
      usageFrom({ providerTurns: [], runs: [{ ...base, modelSelection: fast }] }, fast),
    ).toMatchObject({ pricingSelectionConsistent: false });
  });
});

describe("Garrs cost estimates", () => {
  it("uses existing model prices without counting cached or reasoning tokens twice", () => {
    const rates = new Map([
      [
        "model-a",
        {
          inputCostPerToken: 2,
          outputCostPerToken: 4,
          cacheReadCostPerToken: 1,
          cacheCreationCostPerToken: 3,
          fast: null,
          ultrafast: null,
        },
      ],
    ]);
    const usage = {
      quality: "reported" as const,
      pricingSelectionConsistent: true,
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationTokens: 10,
      outputTokens: 30,
      reasoningOutputTokens: 5,
      providerTurns: 1,
      queueWaitMs: null,
      runDurationMs: null,
    };
    expect(estimateUsage(usage, "model-a", rates, new Map())).toBe(310);
    expect(estimateUsage(usage, "model-a", rates, new Map(), "model-b")).toBeNull();
    expect(estimateUsage(usage, "model-a", rates, new Map(), "model-a")).toBe(310);
    expect(estimateUsage(usage, "model-a", rates, new Map(), null)).toBe(310);
    expect(
      estimateUsage({ ...usage, cacheCreationTokens: null }, "model-a", rates, new Map()),
    ).toBeNull();
    expect(estimateUsage({ ...usage, quality: "partial" }, "model-a", rates, new Map())).toBeNull();
    expect(estimateUsage(usage, "unknown-model", rates, new Map())).toBeNull();
    const multipleSelections = { ...usage, pricingSelectionConsistent: false };
    expect(estimateUsage(multipleSelections, "model-a", rates, new Map())).toBeNull();
    expect(estimateUsage({ ...usage, inputTokens: 1 }, "model-a", rates, new Map())).toBeNull();
    expect(estimateUsage(usage, "model-a", rates, rates)).toBe(310);
  });
});
