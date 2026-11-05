import {
  OrchestratorMcpFailure,
  ProjectIntegrationSummary,
  SupabaseCatalog,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectIntegrations from "../../../project/ProjectIntegrations.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const ProjectIntegrationsToolkit = Toolkit.make(
  Tool.make("project_integrations", {
    description:
      "Read this thread's project connections: Supabase projects and selected branches, and the independent GitHub account/repository. action=branches lists live Supabase branches for connectionId. Credentials are never returned. Configure connections in project Settings.",
    parameters: Schema.Struct({
      action: Schema.Literals(["get", "branches"]),
      connectionId: Schema.optionalKey(Schema.String),
    }),
    success: Schema.Union([
      ProjectIntegrationSummary,
      Schema.Struct({ branches: SupabaseCatalog.fields.branches }),
    ]),
    failure: OrchestratorMcpFailure,
    dependencies: [
      ProjectIntegrations.ProjectIntegrations,
      ThreadManagement.ThreadManagementService,
      McpInvocationContext.McpInvocationContext,
    ],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
