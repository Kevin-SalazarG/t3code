import { GarrsToolResult, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as GarrsService from "../../../garrs/GarrsService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const GARRS_TOOL_ACTIONS = [
  "status",
  "models",
  "select_model",
  "start_work",
  "revise",
  "deliver",
  "submit_plan",
  "report",
  "request_helper",
  "propose_commit",
  "propose_push",
  "send_message",
  "submit_review",
] as const;

// One compact tool: every agent's context carries it, but only Garrs members can use it,
// and their instructions document each action's input, which the server validates.
const GarrsTool = Tool.make("garrs", {
  description: "Garrs team coordination. Only for Garrs team threads; see your Garrs instructions.",
  parameters: Schema.Struct({
    action: Schema.Literals(GARRS_TOOL_ACTIONS),
    input: Schema.optional(Schema.Unknown),
  }),
  success: GarrsToolResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    GarrsService.GarrsService,
  ],
}).annotate(Tool.Destructive, false);

export const GarrsToolkit = Toolkit.make(GarrsTool);
