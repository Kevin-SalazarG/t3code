import { expect, it } from "@effect/vitest";
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { conversationUsage } from "./GarrsConversationUsage.ts";

it("attributes only unambiguous root turns to the correct Garras run", () => {
  const selection = { instanceId: "codex", model: "cheap" };
  const run = (id: string, rootNodeId: string) =>
    ({
      id,
      rootNodeId,
      providerInstanceId: "codex",
      status: "completed",
      modelSelection: selection,
      requestedAt: null,
      startedAt: null,
      completedAt: null,
    }) as unknown as OrchestrationV2Run;
  const candidates = ["r1", "r2"].map((id, index) => ({
    threadId: "g" as ThreadId,
    projectId: "p" as ProjectId,
    run: run(id, `root${index + 1}`),
  }));
  const usage = {
    usageScope: "main_agent",
    usageStatus: "complete",
    hasSubagents: false,
    inputTokens: 100,
    cachedInputTokens: 20,
    cacheCreationTokens: 0,
    outputTokens: 30,
  };
  const turn = (id: string, nodeId: string, runAttemptId: string | null) =>
    ({ id, nodeId, runAttemptId, turnTokenUsage: usage }) as unknown as OrchestrationV2ProviderTurn;
  const records = [
    {
      threadId: "g",
      turn: turn("one", "root1", "a1"),
      attemptRun: "r1",
      attemptRoot: "root1",
      nodeRun: "r1",
    },
    {
      threadId: "g",
      turn: turn("one", "root1", "a1"),
      attemptRun: "r1",
      attemptRoot: "root1",
      nodeRun: "r1",
    },
    {
      threadId: "g",
      turn: turn("two", "root2", null),
      attemptRun: null,
      attemptRoot: null,
      nodeRun: "r2",
    },
    {
      threadId: "g",
      turn: turn("child", "child", "a1"),
      attemptRun: "r1",
      attemptRoot: "root1",
      nodeRun: "r1",
    },
    {
      threadId: "g",
      turn: turn("conflict", "root2", "a1"),
      attemptRun: "r1",
      attemptRoot: "root1",
      nodeRun: "r2",
    },
  ];
  const rows = conversationUsage(candidates, records, false);
  expect(rows.map((entry) => entry.usage.inputTokens)).toEqual([100, 100]);
  expect(rows.map((entry) => entry.usage.quality)).toEqual(["partial", "partial"]);
  expect(rows.every((entry) => entry.usage.pricingSelectionConsistent === false)).toBe(true);
  expect(
    conversationUsage(candidates, records.slice(0, 3), false).map((entry) => entry.usage.quality),
  ).toEqual(["reported", "reported"]);
  const active = [
    { ...candidates[0]!, run: { ...candidates[0]!.run, status: "running" as const } },
  ];
  expect(conversationUsage(active, records.slice(0, 1), false)[0]?.usage.quality).toBe("partial");
  const orphan = {
    threadId: "g",
    turn: turn("orphan", "unknown", null),
    attemptRun: null,
    attemptRoot: null,
    nodeRun: null,
  };
  const orphanRows = conversationUsage(candidates, [...records.slice(0, 3), orphan], false);
  expect(orphanRows.map((entry) => entry.usage.quality)).toEqual(["partial", "partial"]);
  expect(orphanRows.every((entry) => entry.usage.pricingSelectionConsistent === false)).toBe(true);
  const truncatedRows = conversationUsage(candidates, records.slice(0, 3), true);
  expect(truncatedRows.map((entry) => entry.usage.quality)).toEqual(["partial", "partial"]);
  expect(truncatedRows.every((entry) => entry.usage.pricingSelectionConsistent === false)).toBe(
    true,
  );
  const corruptRows = conversationUsage(
    candidates,
    [...records.slice(0, 3), { ...records[0]!, inconsistent: true }],
    false,
  );
  expect(corruptRows.map((entry) => entry.usage.quality)).toEqual(["partial", "partial"]);
  const unknown = conversationUsage(candidates, [], true);
  expect(unknown.map((entry) => entry.usage.inputTokens)).toEqual([null, null]);
  expect(unknown.map((entry) => entry.usage.quality)).toEqual(["unknown", "unknown"]);
  const failedZero = {
    ...records[0]!,
    turn: {
      ...records[0]!.turn,
      turnTokenUsage: {
        usageScope: "main_agent" as const,
        usageStatus: "partial" as const,
        hasSubagents: false,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
    },
  };
  expect(conversationUsage(candidates, [failedZero], false)[0]?.usage).toMatchObject({
    quality: "unknown",
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    providerTurns: 1,
  });
});
