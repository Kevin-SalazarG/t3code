import { OrchestratorMcpFailure, projectIntegrationSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProjectIntegrations from "../../../project/ProjectIntegrations.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProjectIntegrationsToolkit } from "./tools.ts";

const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(ProjectIntegrationsToolkit, {
  project_integrations: McpToolAccess.readsAsCaller(
    Effect.fnUntraced(function* (input) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "project_integrations");
      const threads = yield* ThreadManagement.ThreadManagementService;
      const thread = yield* threads
        .getThreadShell(caller.thread.threadId)
        .pipe(Effect.mapError(failure));
      if (thread === null || thread.deletedAt !== null)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The calling thread is no longer available.",
        });
      const integrations = yield* ProjectIntegrations.ProjectIntegrations;
      if (input.action === "get")
        return projectIntegrationSummary(
          yield* integrations.get(thread.projectId).pipe(Effect.mapError(failure)),
        );
      if (!input.connectionId)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Select a connectionId from project_integrations get.",
        });
      const catalog = yield* integrations
        .catalog({ projectId: thread.projectId, connectionId: input.connectionId })
        .pipe(Effect.mapError(failure));
      return { branches: catalog.branches };
    }),
  ),
});
