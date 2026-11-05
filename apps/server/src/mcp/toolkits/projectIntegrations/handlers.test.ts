import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Integrations from "../../../project/ProjectIntegrations.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Testkit from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ProjectIntegrationsToolkit } from "./tools.ts";

it.effect.each(["get", "branches", "outside-thread"] as const)(
  "binds project integrations to the caller and strips credentials: %s",
  (scenario) => {
    const readProjects: Array<ProjectId> = [];
    const threadId = ThreadId.make("integration-caller");
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "test",
      issuedAt: 0,
      capabilities: new Set(),
      client: undefined,
      thread:
        scenario === "outside-thread"
          ? undefined
          : {
              threadId,
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerSessionId: "session",
            },
    };
    const dependencies = Layer.mergeAll(
      Testkit.liveThreadsLayer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(Integrations.ProjectIntegrations)({
        get: (projectId) =>
          Effect.sync(() => {
            readProjects.push(projectId);
            return {
              supabase: {
                db: {
                  label: "Database",
                  accessToken: "private-token",
                  project: { name: "App", ref: "production" },
                  branch: {
                    id: "branch",
                    name: "dev",
                    projectRef: "development",
                    isDefault: false,
                  },
                },
              },
              github: {
                account: "developer",
                repository: "acme/app",
                accessToken: "private-github-token",
              },
            };
          }),
        catalog: ({ projectId }) =>
          Effect.sync(() => {
            readProjects.push(projectId);
            return { projects: [{ ref: "unrelated", name: "Other project" }], branches: [] };
          }),
      }),
    );
    return Effect.gen(function* () {
      const toolkit = yield* ProjectIntegrationsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const result = yield* toolkit
        .handle("project_integrations", {
          action: scenario === "branches" ? "branches" : "get",
          connectionId: "db",
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies), Effect.result);
      if (scenario === "outside-thread") {
        expect(readProjects).toEqual([]);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { code: "thread_credential_required" },
        });
        return;
      }
      expect(readProjects).toEqual([Testkit.liveThreadShell(threadId).projectId]);
      if (result._tag === "Failure") return yield* result.failure;
      const json = JSON.stringify(result.success.at(-1)?.result);
      expect(json).not.toContain("private-token");
      expect(json).not.toContain("accessToken");
      expect(json).not.toContain("unrelated");
      if (scenario === "get") expect(json).toContain("development");
    }).pipe(Effect.provide(dependencies));
  },
);
