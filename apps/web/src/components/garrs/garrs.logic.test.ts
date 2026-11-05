import type {
  GarrsConversationUsageRow,
  GarrsModelDecision,
  GarrsUsageRow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveModelLabel,
  dateInputToIso,
  formatCount,
  formatDurationMs,
  usageRowsToCsv,
  usageRowsForExport,
  conversationUsageRowsToCsv,
  conversationUsageRowsForExport,
  conversationUsageExport,
  workItemControls,
} from "./garrs.logic";

function usageRow(overrides: Partial<GarrsUsageRow["usage"]>, title = "Fix login"): GarrsUsageRow {
  return {
    attemptId: "attempt-1",
    workItemId: "work-1",
    workItemTitle: title,
    projectId: "project-1",
    taskId: "task-1",
    agentId: "botas",
    providerInstanceId: "codex",
    model: "gpt-5",
    effectiveModel: null,
    status: "succeeded",
    createdAt: "2026-10-01T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    usage: {
      quality: "unknown",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      providerTurns: 0,
      queueWaitMs: null,
      runDurationMs: null,
      ...overrides,
    },
  } as GarrsUsageRow;
}

describe("usage formatting", () => {
  it("exports coordinator runs separately with unknown values, truncation and no unrelated fields", () => {
    const row = {
      threadId: "thread-1",
      runId: "run-1",
      projectId: "project-1",
      agentId: "garras",
      providerInstanceId: "codex",
      model: "=1+1",
      effectiveModel: null,
      status: "completed",
      createdAt: "2026-10-01T00:00:00.000Z",
      startedAt: null,
      endedAt: null,
      estimatedCostUsd: 0.2,
      estimatePriceSource: null,
      usage: usageRow({
        pricingSelectionConsistent: false,
        reportedModels: ["model-b"],
        modelIdentityComplete: false,
        reportedCost: {
          amountUsd: 0.25,
          source: "provider_api_report",
          scope: "query_delta",
          status: "partial",
        },
      }).usage,
      credentials: "SECRET",
    } as unknown as GarrsConversationUsageRow;
    const csv = conversationUsageRowsToCsv([row], false, true);
    const [header, values] = csv.split("\n");
    const columns = header!.split(",");
    const cells = values!.split(",");
    expect(cells[columns.indexOf("model")]).toBe("'=1+1");
    expect(cells[columns.indexOf("effectiveModel")]).toBe("");
    expect(cells[columns.indexOf("exportTruncated")]).toBe("false");
    expect(cells[columns.indexOf("evidenceTruncated")]).toBe("true");
    expect(cells[columns.indexOf("pricingSelectionConsistent")]).toBe("false");
    expect(cells[columns.indexOf("nativeProviderEstimateUsd")]).toBe("0.25");
    expect(cells[columns.indexOf("nativeProviderEstimateScope")]).toBe("query_delta");
    expect(cells[columns.indexOf("nativeProviderEstimateStatus")]).toBe("partial");
    expect(cells[columns.indexOf("modelIdentityComplete")]).toBe("false");
    expect(cells[columns.indexOf("estimatedCostUsd")]).toBe("0.2");
    expect(cells[columns.indexOf("subscriptionChargeUsd")]).toBe("");
    expect(csv).not.toContain("workItemId");
    expect(csv).not.toContain("SECRET");
    expect(JSON.stringify(conversationUsageRowsForExport([row]))).not.toContain("SECRET");
    expect(conversationUsageRowsForExport([row])[0]?.usage.pricingSelectionConsistent).toBe(false);
    expect(conversationUsageRowsForExport([row])[0]).toMatchObject({
      subscriptionChargeUsd: null,
      usage: { reportedModels: ["model-b"], reportedCost: { amountUsd: 0.25, status: "partial" } },
    });
    expect(conversationUsageExport([row], false, true)).toMatchObject({
      truncated: false,
      evidenceTruncated: true,
    });
    expect(conversationUsageExport([row], null, null)).toMatchObject({
      truncated: null,
      evidenceTruncated: null,
    });
  });
  it("includes the entire last local day in the exclusive usage filter", () => {
    expect(dateInputToIso("2026-03-08", "end")).toBe(new Date(2026, 2, 9).toISOString());
  });
  it("renders unknown as a dash and real zero as zero", () => {
    expect(formatCount(null)).toBe("Unknown");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(12_345)).toBe("12,345");
    expect(formatDurationMs(null)).toBe("Unknown");
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(65_000)).toBe("1m 05s");
  });

  it("keeps unknown usage out of CSV as empty cells, never zero", () => {
    const csv = usageRowsToCsv([
      {
        ...usageRow({ quality: "partial", inputTokens: 0, outputTokens: 42 }, "private title"),
        model: 'Say "hi", then go',
        estimatedCostUsd: 0.012,
      },
    ]);
    const [header, line] = csv.split("\n");
    const columns = header!.split(",");
    const cell = (name: string) => {
      const values = line!.replace('"Say ""hi"", then go"', "TITLE").split(",");
      return values[columns.indexOf(name)];
    };
    expect(line).toContain('"Say ""hi"", then go"');
    expect(csv).not.toContain("private title");
    expect(JSON.stringify(usageRowsForExport([usageRow({}, "private title")]))).not.toContain(
      "private title",
    );
    expect(cell("inputTokens")).toBe("0");
    expect(cell("outputTokens")).toBe("42");
    expect(cell("cachedInputTokens")).toBe("");
    expect(cell("runDurationMs")).toBe("");
    expect(cell("quality")).toBe("partial");
    expect(cell("pricingSelectionConsistent")).toBe("");
    expect(cell("nativeProviderEstimateUsd")).toBe("");
    expect(cell("subscriptionChargeUsd")).toBe("");
    expect(cell("estimatedCostUsd")).toBe("0.012");
    expect(usageRowsForExport([usageRow({})])[0]).toHaveProperty("subscriptionChargeUsd", null);
  });

  it("marks a CSV export when the results were truncated", () => {
    const [header, row] = usageRowsToCsv([usageRow({})], true).split("\n");
    expect(row!.split(",")[header!.split(",").indexOf("exportTruncated")]).toBe("true");
  });

  it("prevents spreadsheet formulas from executing when exporting text", () => {
    for (const title of [
      '=HYPERLINK("https://example.test")',
      "+1+2",
      "-1+2",
      "@SUM(1)",
      "\t=1+1",
    ]) {
      const csv = usageRowsToCsv([{ ...usageRow({}), model: title }]);
      const [header, row] = csv.split("\n");
      const titleCell = row!.split(",")[header!.split(",").indexOf("model")]!;
      expect(titleCell.startsWith("'") || titleCell.startsWith("\"'")).toBe(true);
    }
  });
});

describe("effectiveModelLabel", () => {
  const decision = (
    effectiveModelSource: GarrsModelDecision["effectiveModelSource"],
    effectiveModel: string | null,
  ) => ({ effectiveModelSource, effectiveModel }) as GarrsModelDecision;

  it("only trusts model identity reported by provider responses", () => {
    expect(effectiveModelLabel(decision("provider_response", "opus"))).toBe("opus");
    expect(effectiveModelLabel(decision("provider_response", null))).toBe("Not verifiable");
    expect(effectiveModelLabel(decision("provider_session", "opus"))).toBe("Not verifiable");
    expect(effectiveModelLabel(decision("pending", "opus"))).toBe("Not verifiable");
    expect(effectiveModelLabel(decision("unverifiable", null))).toBe("Not verifiable");
  });
});

describe("workItemControls", () => {
  it("offers nothing that reopens a finished work item", () => {
    expect(Object.values(workItemControls("accepted")).some(Boolean)).toBe(false);
    expect(workItemControls("delivered")).toMatchObject({ accept: true, cancel: true });
    expect(workItemControls("paused")).toMatchObject({ resume: true, pause: false });
  });
});
