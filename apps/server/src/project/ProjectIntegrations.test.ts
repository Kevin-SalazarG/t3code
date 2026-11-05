import { expect, it } from "@effect/vitest";
import { ProjectId, projectIntegrationContext } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Settings from "../serverSettings.ts";
import * as IntegrationStore from "./ProjectIntegrationStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Integrations from "./ProjectIntegrations.ts";
import * as Auth from "./ProjectIntegrationAuth.ts";

const first = ProjectId.make("project-one");
const second = ProjectId.make("project-two");
const production = { id: "production", name: "Database" };
const development = {
  id: "dev-branch",
  name: "dev",
  project_ref: "development",
  parent_project_ref: "production",
  is_default: false,
  status: "ACTIVE_HEALTHY",
};

const setup = (
  options: {
    readonly status?: number;
    readonly branches?: ReadonlyArray<typeof development>;
    readonly missingProject?: boolean;
    readonly rotateOnAccess?: boolean;
  } = {},
) => {
  const requests: Array<{ url: string; token: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, token: request.headers.authorization });
      const route = new URL(request.url).pathname;
      const body =
        route === "/v1/projects"
          ? [production, { id: "other", name: "Other" }]
          : route.endsWith("/branches")
            ? (options.branches ?? [development])
            : route === "/user"
              ? { login: "developer" }
              : route === "/user/repos"
                ? [{ full_name: "acme/app" }]
                : { full_name: "acme/app" };
      return HttpClientResponse.fromWeb(
        request,
        Response.json(body, { status: options.status ?? 200 }),
      );
    }),
  );
  const settingsLayer = Settings.ServerSettingsService.layerTest();
  const authLayer = options.rotateOnAccess
    ? Layer.effect(
        Auth.ProjectIntegrationAuth,
        Effect.gen(function* () {
          const settings = yield* Settings.ServerSettingsService;
          return yield* Layer.mock(Auth.ProjectIntegrationAuth)({
            accessToken: (projectId) =>
              Effect.gen(function* () {
                const config = (yield* settings.getSettings).projectIntegrations[projectId]!;
                const connection = config.supabase.db!;
                yield* settings.updateSettings({
                  projectIntegrations: {
                    [projectId]: {
                      ...config,
                      supabase: {
                        ...config.supabase,
                        db: { ...connection, oauthSession: "rotated-oauth" },
                        "new-db": {
                          ...connection,
                          label: "Other database",
                          project: null,
                          branch: null,
                        },
                      },
                    },
                  },
                });
                return "refreshed-token";
              }).pipe(Effect.orDie),
          }).pipe(
            Layer.build,
            Effect.map((context) => Context.get(context, Auth.ProjectIntegrationAuth)),
            Effect.scoped,
          );
        }),
      ).pipe(Layer.provide(settingsLayer))
    : Layer.empty;
  return {
    requests,
    layer: Integrations.layer.pipe(
      Layer.provideMerge(IntegrationStore.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          settingsLayer,
          authLayer,
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) =>
              Effect.succeed(
                options.missingProject
                  ? Option.none()
                  : Option.some({
                      projectId: id,
                      title: "App",
                      workspaceRoot: `/home/user/${id}`,
                      defaultModelSelection: null,
                      defaultThreadEnvMode: null,
                      autoPull: false,
                      faviconPath: null,
                      projectIcon: null,
                      scripts: [],
                      pinnedAt: null,
                      archivedAt: null,
                      createdAt: "2026-11-04T00:00:00.000Z",
                      updatedAt: "2026-11-04T00:00:00.000Z",
                      deletedAt: null,
                    }),
              ),
          }),
          Layer.mock(SecretResolver.SecretResolver)({ read: () => Effect.succeed([]) }),
          Layer.mock(VcsProcess.VcsProcess)({
            run: () =>
              Effect.succeed({
                stdout: "github-cli-credential",
                stderr: "",
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          }),
        ),
      ),
    ),
  };
};

it.effect(
  "links multiple databases, selects Supabase branches independently, and preserves GitHub and other projects",
  () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const service = yield* Integrations.ProjectIntegrations;
      const update = (
        projectId: ProjectId,
        action: Parameters<typeof service.update>[0]["action"],
      ) => service.update({ projectId, action });
      for (const projectId of [first, second])
        yield* update(projectId, {
          type: "connect_supabase",
          connectionId: "db",
          label: "Database",
          accessToken: `${projectId}-credential`,
        });
      yield* update(first, {
        type: "select_supabase_project",
        connectionId: "db",
        projectRef: "production",
      });
      yield* update(first, {
        type: "select_supabase_branch",
        connectionId: "db",
        branchId: development.id,
      });
      yield* update(first, {
        type: "connect_github",
        repository: "acme/app",
        accessToken: "github-credential",
      });
      yield* update(first, {
        type: "connect_supabase",
        connectionId: "analytics",
        label: "Analytics",
        accessToken: "analytics-credential",
      });
      const repositories = yield* service.githubCatalog({ projectId: first, page: 1 });
      expect(repositories).toEqual({
        account: "developer",
        repositories: ["acme/app"],
        nextPage: null,
      });
      const config = yield* service.get(first);
      expect(Object.keys(config.supabase)).toEqual(["db", "analytics"]);
      expect(config.supabase.db?.branch?.projectRef).toBe("development");
      expect(config.github).toMatchObject({ repository: "acme/app", account: "developer" });
      expect(config.github?.accessToken).not.toBe("github-credential");
      expect(config.supabase.db?.accessToken).not.toBe(`${first}-credential`);
      const context = projectIntegrationContext(config);
      expect(context).toContain('"projectRef":"development"');
      expect(context).not.toContain("credential");
      expect(context).not.toContain("accessToken");
      expect((yield* service.get(second)).supabase.db?.project).toBeNull();
      const invalid = yield* update(first, {
        type: "select_supabase_branch",
        connectionId: "db",
        branchId: "foreign-branch",
      }).pipe(Effect.flip);
      expect(invalid.code).toBe("invalid_selection");
      expect((yield* service.get(first)).supabase.db?.branch?.id).toBe(development.id);
      yield* update(first, {
        type: "select_supabase_project",
        connectionId: "db",
        projectRef: "other",
      });
      expect((yield* service.get(first)).supabase.db?.branch).toBeNull();
      yield* update(first, { type: "disconnect_supabase", connectionId: "db" });
      yield* update(first, { type: "disconnect_github" });
      expect(Object.keys((yield* service.get(first)).supabase)).toEqual(["analytics"]);
      expect((yield* service.get(first)).github).toBeNull();
      expect(Object.keys((yield* service.get(second)).supabase)).toEqual(["db"]);
      expect(
        fixture.requests.every(
          (entry) =>
            entry.url.startsWith("https://api.supabase.com/") ||
            entry.url.startsWith("https://api.github.com/"),
        ),
      ).toBe(true);
      expect(fixture.requests[0]?.token).toBe(`Bearer ${first}-credential`);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect.each([
  [401, "credentials"],
  [403, "forbidden"],
  [404, "not_found"],
  [429, "rate_limited"],
  [500, "unavailable"],
  [302, "unavailable"],
] as const)("keeps failed connections unsaved and hides upstream response bodies: %s", (entry) => {
  const [status, code] = entry;
  const fixture = setup({ status });
  return Effect.gen(function* () {
    const service = yield* Integrations.ProjectIntegrations;
    const error = yield* service
      .update({
        projectId: first,
        action: {
          type: "connect_supabase",
          connectionId: "db",
          label: "Database",
          accessToken: "private-token",
        },
      })
      .pipe(Effect.flip);
    expect(error.code).toBe(code);
    expect(JSON.stringify(error)).not.toContain("private-token");
    expect((yield* service.get(first)).supabase).toEqual({});
  }).pipe(Effect.provide(fixture.layer));
});

it.effect.each([
  "main",
  "foreign-parent",
  "missing-project",
  "cli-account",
  "oauth-refresh",
] as const)("validates integration selection: %s", (scenario) => {
  const fixture = setup({
    branches:
      scenario === "main"
        ? []
        : scenario === "foreign-parent"
          ? [{ ...development, parent_project_ref: "foreign" }]
          : [development],
    missingProject: scenario === "missing-project",
    rotateOnAccess: scenario === "oauth-refresh",
  });
  return Effect.gen(function* () {
    const service = yield* Integrations.ProjectIntegrations;
    if (scenario === "missing-project") {
      expect((yield* service.get(first).pipe(Effect.flip)).code).toBe("project_not_found");
      expect(fixture.requests).toEqual([]);
      return;
    }
    if (scenario === "cli-account") {
      yield* service.update({
        projectId: first,
        action: {
          type: "connect_github",
          repository: "acme/app",
          accessToken: "",
          account: "developer",
        },
      });
      expect(fixture.requests[0]?.token).toBe("Bearer github-cli-credential");
      const error = yield* service
        .update({
          projectId: first,
          action: {
            type: "connect_github",
            repository: "acme/app",
            accessToken: "test",
            account: "different-account",
          },
        })
        .pipe(Effect.flip);
      expect(error.code).toBe("credentials");
      return;
    }
    yield* service.update({
      projectId: first,
      action: {
        type: "connect_supabase",
        connectionId: "db",
        label: "Database",
        accessToken: "token",
      },
    });
    yield* service.update({
      projectId: first,
      action: { type: "select_supabase_project", connectionId: "db", projectRef: "production" },
    });
    if (scenario === "oauth-refresh") {
      const settings = yield* Settings.ServerSettingsService;
      const config = (yield* settings.getSettings).projectIntegrations[first]!;
      yield* settings.updateSettings({
        projectIntegrations: {
          [first]: {
            ...config,
            supabase: {
              ...config.supabase,
              db: { ...config.supabase.db!, oauthSession: "old-oauth" },
            },
          },
        },
      });
      yield* service.update({
        projectId: first,
        action: {
          type: "select_supabase_branch",
          connectionId: "db",
          branchId: development.id,
        },
      });
      const saved = (yield* settings.getSettings).projectIntegrations[first]!;
      expect(saved.supabase.db?.oauthSession).toBe("rotated-oauth");
      expect(saved.supabase.db?.branch?.id).toBe(development.id);
      expect(saved.supabase["new-db"]?.label).toBe("Other database");
      return;
    }
    if (scenario === "foreign-parent") {
      expect(
        (yield* service.catalog({ projectId: first, connectionId: "db" }).pipe(Effect.flip)).code,
      ).toBe("invalid_response");
      return;
    }
    const catalog = yield* service.catalog({ projectId: first, connectionId: "db" });
    expect(catalog.branches).toEqual([
      {
        id: "production",
        name: "main",
        projectRef: "production",
        isDefault: true,
        status: "PRODUCTION",
      },
    ]);
    yield* service.update({
      projectId: first,
      action: { type: "select_supabase_branch", connectionId: "db", branchId: "production" },
    });
    expect((yield* service.get(first)).supabase.db?.branch?.isDefault).toBe(true);
  }).pipe(Effect.provide(fixture.layer));
});
