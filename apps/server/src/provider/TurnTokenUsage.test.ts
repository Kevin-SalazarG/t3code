import { describe, expect, it } from "vite-plus/test";
import {
  claudeLedgerDelta,
  claudeModelLedger,
  normalizeClaudeTurnTokenUsage,
  beginClaudeTurnCost,
  completeClaudeTurnCost,
  makeClaudeQueryCostState,
  observeClaudeTurnCost,
} from "./ClaudeTurnTokenUsage.ts";
import {
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
  getCodexTurnAccumulator,
  makeCodexTurnTokenUsageState,
} from "./CodexTurnTokenUsage.ts";

const breakdown = (input: number, cached: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
const update = (total: ReturnType<typeof breakdown>, last = total) => ({
  total,
  last,
  modelContextWindow: 200_000,
});

describe("billable native turn usage", () => {
  it("adds each Codex response once and excludes the prior resumed history", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    const first = update(breakdown(1010, 505, 102), breakdown(10, 5, 2));
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(
      state,
      "turn",
      update(breakdown(1030, 515, 108), breakdown(20, 10, 6)),
    );
    expect(completeCodexTurnTokenUsage(state, "turn", true)).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 30,
      cachedInputTokens: 15,
      outputTokens: 8,
      reasoningTokens: 0,
    });
  });

  it("keeps previous responses when compaction resets Codex cumulative counters", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(100, 40, 20)));
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(20, 5, 3)));
    getCodexTurnAccumulator(state, "turn").hasSubagents = true;
    expect(completeCodexTurnTokenUsage(state, "turn", false)).toMatchObject({
      usageStatus: "partial",
      hasSubagents: true,
      inputTokens: 120,
      cachedInputTokens: 45,
      outputTokens: 23,
    });
  });

  it("does not bill late Codex updates against the next active turn", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "next";
    accumulateCodexTurnTokenUsage(state, "previous", update(breakdown(100, 10, 20)));
    accumulateCodexTurnTokenUsage(
      state,
      "next",
      update(breakdown(104, 12, 21), breakdown(4, 2, 1)),
    );
    expect(completeCodexTurnTokenUsage(state, "next", true)).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
    });
    expect(completeCodexTurnTokenUsage(state, "missing", false).usageStatus).toBe("unavailable");
  });

  it("counts Claude cached input inside total input and bounds thinking output", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
            output_tokens: 20,
            output_tokens_details: { thinking_tokens: 25 },
          },
        },
        true,
        "completed",
      ),
    ).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: true,
      inputTokens: 150,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 20,
    });
  });

  it("does not turn a zeroed Claude crash result into a measured zero-cost turn", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "error_during_execution",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
        false,
        "failed",
      ).usageStatus,
    ).toBe("unavailable");
    expect(
      normalizeClaudeTurnTokenUsage(
        { subtype: "success", usage: { input_tokens: 0, output_tokens: 0 } },
        false,
        "failed",
      ).usageStatus,
    ).toBe("unavailable");
    expect(
      normalizeClaudeTurnTokenUsage(
        { subtype: "success", usage: { input_tokens: 0, output_tokens: 0 } },
        false,
        "completed",
      ),
    ).toMatchObject({ usageStatus: "complete", inputTokens: 0, outputTokens: 0 });
    expect(
      normalizeClaudeTurnTokenUsage(
        {
          subtype: "success",
          usage: {
            input_tokens: 4,
            output_tokens: 2,
          },
        },
        false,
        "interrupted",
      ),
    ).toMatchObject({ usageStatus: "partial", inputTokens: 4, outputTokens: 2 });
  });

  it.each(["failed", "interrupted", "completed"] as const)(
    "retains measured Claude steering usage as partial after %s without final usage",
    (status) => {
      expect(
        normalizeClaudeTurnTokenUsage(
          status === "completed" ? { subtype: "success" } : undefined,
          true,
          status,
          [
            { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
            { input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 3 },
          ],
        ),
      ).toEqual({
        usageStatus: "partial",
        usageScope: "main_agent",
        hasSubagents: true,
        inputTokens: 147,
        cachedInputTokens: 42,
        outputTokens: 23,
      });
    },
  );

  it.each([undefined, null, {}])(
    "keeps unavailable Claude usage unavailable without measured segments (%s)",
    (usage) => {
      expect(
        normalizeClaudeTurnTokenUsage({ subtype: "success", usage }, false, "completed")
          .usageStatus,
      ).toBe("unavailable");
    },
  );

  it("retains measured thinking tokens without a final result", () => {
    expect(
      normalizeClaudeTurnTokenUsage(undefined, false, "failed", [
        { input_tokens: 4, output_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
      ]),
    ).toMatchObject({
      usageStatus: "partial",
      inputTokens: 4,
      outputTokens: 3,
      reasoningTokens: 2,
    });
  });

  it.each([undefined, null])(
    "retains earlier cache counts when a steering segment reports %s",
    (cache) => {
      expect(
        normalizeClaudeTurnTokenUsage(undefined, false, "failed", [
          { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
          { input_tokens: 5, cache_read_input_tokens: cache, output_tokens: 3 },
        ]),
      ).toMatchObject({
        usageStatus: "partial",
        inputTokens: 145,
        cachedInputTokens: 40,
        outputTokens: 23,
      });
    },
  );

  it.each(["cache_read_input_tokens", "cache_creation_input_tokens"])(
    "keeps Claude usage partial when the final %s is invalid",
    (field) => {
      expect(
        normalizeClaudeTurnTokenUsage(
          { subtype: "success", usage: { input_tokens: 5, output_tokens: 3, [field]: -1 } },
          false,
          "completed",
          [{ input_tokens: 100, output_tokens: 20, [field]: 40 }],
        ),
      ).toMatchObject({ usageStatus: "partial", inputTokens: 145, outputTokens: 23 });
    },
  );

  it("measures Claude ledger growth only from a known, nondecreasing baseline", () => {
    const ledger = (output: number) =>
      claudeModelLedger({ "claude-sonnet-4-6": { inputTokens: 100, outputTokens: output } });
    expect(claudeLedgerDelta(ledger(10), ledger(25))).toEqual({ inputTokens: 0, outputTokens: 15 });
    expect(claudeLedgerDelta(ledger(25), ledger(10))).toBeUndefined();
    expect(claudeLedgerDelta(undefined, ledger(10))).toBeUndefined();
    expect(claudeModelLedger({})).toBeUndefined();
  });

  it("adds Claude steering segments once and preserves the ledger, response model and cost", () => {
    const reportedCost = {
      amountUsd: 0.25,
      source: "provider_api_report" as const,
      scope: "query_delta" as const,
      status: "complete" as const,
    };
    expect(
      normalizeClaudeTurnTokenUsage(
        { subtype: "success", usage: { input_tokens: 5, output_tokens: 3 } },
        false,
        "completed",
        [{ input_tokens: 4, output_tokens: 2 }],
        {
          rootModels: new Set(["claude-real"]),
          ledger: { inputTokens: 12, outputTokens: 8 },
          reportedCost,
        },
      ),
    ).toMatchObject({
      usageStatus: "complete",
      inputTokens: 9,
      outputTokens: 5,
      otherUsage: { inputTokens: 3, outputTokens: 3 },
      models: ["claude-real"],
      reportedCost,
    });
  });

  it("retains only actual reported Claude models even when token usage is missing", () => {
    expect(
      normalizeClaudeTurnTokenUsage(undefined, false, "failed", [], {
        rootModels: new Set(["<synthetic>", " ", "claude-real", "claude-real"]),
      }),
    ).toMatchObject({ usageStatus: "unavailable", models: ["claude-real"] });
  });
});

describe("Claude reported query cost", () => {
  it("differences cumulative query totals across turns and does not sum steering results", () => {
    const query = makeClaudeQueryCostState();
    const first = beginClaudeTurnCost(query);
    const steered = { uuid: "steered", subtype: "error_during_execution", total_cost_usd: 0.25 };
    observeClaudeTurnCost(first, steered);
    observeClaudeTurnCost(first, steered);
    observeClaudeTurnCost(first, { uuid: "first-final", subtype: "success", total_cost_usd: 0.75 });
    expect(completeClaudeTurnCost(first, true, true, false)).toEqual({
      amountUsd: 0.75,
      source: "provider_api_report",
      scope: "query_delta",
      status: "complete",
    });
    const second = beginClaudeTurnCost(query);
    observeClaudeTurnCost(second, { uuid: "second-final", subtype: "success", total_cost_usd: 1 });
    expect(completeClaudeTurnCost(second, true, true, false)?.amountUsd).toBe(0.25);
    const cleared = beginClaudeTurnCost(query, true);
    observeClaudeTurnCost(cleared, { uuid: "cleared", subtype: "success", total_cost_usd: 1.5 });
    expect(completeClaudeTurnCost(cleared, true, true, false)).toBeUndefined();
    const restarted = beginClaudeTurnCost(makeClaudeQueryCostState());
    observeClaudeTurnCost(restarted, {
      uuid: "resumed-final",
      subtype: "success",
      total_cost_usd: 0.5,
    });
    expect(completeClaudeTurnCost(restarted, true, true, false)?.amountUsd).toBe(0.5);
  });

  it("omits resets, invalid totals, overlapping turns and ambiguous native subagent costs", () => {
    for (const amount of [Number.NaN, -1, undefined]) {
      const turn = beginClaudeTurnCost(makeClaudeQueryCostState());
      observeClaudeTurnCost(turn, { uuid: "invalid", subtype: "success", total_cost_usd: amount });
      expect(completeClaudeTurnCost(turn, true, true, false)).toBeUndefined();
    }
    const query = makeClaudeQueryCostState();
    const first = beginClaudeTurnCost(query);
    observeClaudeTurnCost(first, { uuid: "first", subtype: "success", total_cost_usd: 1 });
    completeClaudeTurnCost(first, true, true, false);
    const reset = beginClaudeTurnCost(query);
    observeClaudeTurnCost(reset, { uuid: "reset", subtype: "success", total_cost_usd: 0.25 });
    expect(completeClaudeTurnCost(reset, true, true, false)).toBeUndefined();
    const child = beginClaudeTurnCost(query);
    observeClaudeTurnCost(child, { uuid: "child", subtype: "success", total_cost_usd: 0.5 });
    expect(completeClaudeTurnCost(child, true, true, true)).toBeUndefined();
    const overlap = beginClaudeTurnCost(query);
    beginClaudeTurnCost(query);
    observeClaudeTurnCost(overlap, { uuid: "overlap", subtype: "success", total_cost_usd: 0.75 });
    expect(completeClaudeTurnCost(overlap, true, true, false)).toBeUndefined();
  });

  it("keeps a measured partial delta but invalidates the next baseline after a missing final result", () => {
    const query = makeClaudeQueryCostState();
    const first = beginClaudeTurnCost(query);
    observeClaudeTurnCost(first, {
      uuid: "segment",
      subtype: "error_during_execution",
      total_cost_usd: 0.25,
    });
    expect(completeClaudeTurnCost(first, false, false, false)).toMatchObject({
      amountUsd: 0.25,
      status: "partial",
    });
    const next = beginClaudeTurnCost(query);
    observeClaudeTurnCost(next, { uuid: "next", subtype: "success", total_cost_usd: 0.5 });
    expect(completeClaudeTurnCost(next, true, true, false)).toBeUndefined();
  });
});
