import * as ProjectIntegrationAuth from "./ProjectIntegrationAuth.ts";
import * as IntegrationStore from "./ProjectIntegrationStore.ts";
import {
  EMPTY_PROJECT_INTEGRATIONS,
  type GitHubIntegrationCatalog,
  type GitHubIntegrationCatalogInput,
  ProjectIntegrationsError,
  type ProjectId,
  type ProjectIntegrations as Config,
  type ProjectIntegrationsUpdateInput,
  type SettingsSecretValue,
  type SupabaseCatalog,
  type SupabaseCatalogInput,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED, mapSettingsSecrets } from "../settingsSecrets.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export class ProjectIntegrations extends Context.Service<
  ProjectIntegrations,
  {
    readonly githubCatalog: (
      input: GitHubIntegrationCatalogInput,
    ) => Effect.Effect<GitHubIntegrationCatalog, ProjectIntegrationsError>;
    readonly get: (projectId: ProjectId) => Effect.Effect<Config, ProjectIntegrationsError>;
    readonly update: (
      input: ProjectIntegrationsUpdateInput,
    ) => Effect.Effect<Config, ProjectIntegrationsError>;
    readonly catalog: (
      input: SupabaseCatalogInput,
    ) => Effect.Effect<SupabaseCatalog, ProjectIntegrationsError>;
  }
>()("t3/project/ProjectIntegrations") {}

const ApiProjects = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));
const ApiBranches = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    project_ref: Schema.String,
    parent_project_ref: Schema.String,
    is_default: Schema.Boolean,
    status: Schema.String,
  }),
);
const ApiUser = Schema.Struct({ login: Schema.String });
const ApiRepo = Schema.Struct({ full_name: Schema.String });

const make = Effect.gen(function* () {
  const auth = yield* Effect.serviceOption(ProjectIntegrationAuth.ProjectIntegrationAuth);
  const settings = yield* ServerSettings.ServerSettingsService;
  const store = yield* IntegrationStore.ProjectIntegrationStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const secrets = yield* SecretResolver.SecretResolver;
  const http = yield* HttpClient.HttpClient;
  const process = yield* VcsProcess.VcsProcess;
  const locks = yield* KeyedLock.make<ProjectId>();

  const read = Effect.fn("ProjectIntegrations.read")(function* (projectId: ProjectId) {
    const project = yield* projects
      .get(projectId)
      .pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "persistence" })));
    if (Option.isNone(project))
      return yield* new ProjectIntegrationsError({ code: "project_not_found" });
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new ProjectIntegrationsError({ code: "persistence" })),
    );
    return {
      project: project.value,
      settings: current,
      config: current.projectIntegrations[projectId] ?? EMPTY_PROJECT_INTEGRATIONS,
    };
  });
  const credential = Effect.fn("ProjectIntegrations.credential")(function* (
    value: SettingsSecretValue,
  ) {
    const token = yield* requireSettingsSecret(secrets, value).pipe(
      Effect.mapError(() => new ProjectIntegrationsError({ code: "credentials" })),
    );
    if (token.trim() === "" || token === SECRET_REDACTED)
      return yield* new ProjectIntegrationsError({ code: "credentials" });
    return token;
  });

  const request = Effect.fn("ProjectIntegrations.request")(
    function* <S extends Schema.Top>(
      origin: "supabase" | "github",
      path: string,
      token: string,
      schema: S,
    ) {
      const response = yield* http
        .execute(
          HttpClientRequest.get(
            `${origin === "supabase" ? "https://api.supabase.com" : "https://api.github.com"}${path}`,
          ).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.setHeaders({
              Accept: "application/json",
              "User-Agent": "T3-Code",
              ...(origin === "github" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
            }),
          ),
        )
        .pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "unavailable" })));
      if (response.status < 200 || response.status >= 300) {
        const code =
          response.status === 401
            ? "credentials"
            : response.status === 403
              ? "forbidden"
              : response.status === 404
                ? "not_found"
                : response.status === 429
                  ? "rate_limited"
                  : "unavailable";
        return yield* new ProjectIntegrationsError({ code });
      }
      const body = yield* response.json.pipe(
        Effect.mapError(() => new ProjectIntegrationsError({ code: "invalid_response" })),
      );
      return yield* Schema.decodeEffect(schema)(body).pipe(
        Effect.mapError(() => new ProjectIntegrationsError({ code: "invalid_response" })),
      );
    },
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.withTracerEnabled(false),
    Effect.timeout("15 seconds"),
    Effect.catchTags({
      TimeoutError: () => Effect.fail(new ProjectIntegrationsError({ code: "unavailable" })),
    }),
  );

  const catalogFor = Effect.fn("ProjectIntegrations.catalogFor")(function* (
    connection: Config["supabase"][string],
    projectId: ProjectId,
    connectionId: string,
  ) {
    const token = yield* connection.oauthSession !== undefined && Option.isSome(auth)
      ? auth.value.accessToken(projectId, "supabase", connectionId)
      : credential(connection.accessToken);
    const available = yield* request("supabase", "/v1/projects", token, ApiProjects);
    const choices = available.map((entry) => ({ ref: entry.id, name: entry.name }));
    if (connection.project === null)
      return { projects: choices, branches: [] } satisfies SupabaseCatalog;
    if (!choices.some((entry) => entry.ref === connection.project?.ref))
      return yield* new ProjectIntegrationsError({ code: "not_found" });
    const branches = yield* request(
      "supabase",
      `/v1/projects/${encodeURIComponent(connection.project.ref)}/branches`,
      token,
      ApiBranches,
    );
    if (branches.some((branch) => branch.parent_project_ref !== connection.project?.ref))
      return yield* new ProjectIntegrationsError({ code: "invalid_response" });
    const result = branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      projectRef: branch.project_ref,
      isDefault: branch.is_default,
      status: branch.status,
    }));
    if (!result.some((branch) => branch.isDefault))
      result.unshift({
        id: connection.project.ref,
        name: "main",
        projectRef: connection.project.ref,
        isDefault: true,
        status: "PRODUCTION",
      });
    return { projects: choices, branches: result } satisfies SupabaseCatalog;
  });

  const get = Effect.fn("ProjectIntegrations.get")(function* (projectId: ProjectId) {
    const current = yield* read(projectId);
    const redacted = mapSettingsSecrets(current.settings, (secret) => ({
      value: secret.value,
      redacted: secret.value !== "",
    }));
    return redacted.projectIntegrations[projectId] ?? EMPTY_PROJECT_INTEGRATIONS;
  });
  const catalog = Effect.fn("ProjectIntegrations.catalog")(function* ({
    projectId,
    connectionId,
  }: SupabaseCatalogInput) {
    const { config } = yield* read(projectId);
    const connection = config.supabase[connectionId];
    if (!connection) return yield* new ProjectIntegrationsError({ code: "connection_not_found" });
    return yield* catalogFor(connection, projectId, connectionId);
  });

  const update = Effect.fn("ProjectIntegrations.update")(function (
    input: ProjectIntegrationsUpdateInput,
  ) {
    return locks.withLock(
      input.projectId,
      Effect.gen(function* () {
        const { config, project } = yield* read(input.projectId);
        const action = input.action;
        let next: Config;
        if (action.type === "connect_supabase") {
          const existing = config.supabase[action.connectionId];
          const accessToken =
            action.accessToken === SECRET_REDACTED && existing
              ? existing.accessToken
              : action.accessToken;
          const connection = {
            label: action.label,
            accessToken,
            project: existing?.project ?? null,
            branch: existing?.branch ?? null,
          };
          yield* catalogFor(connection, input.projectId, action.connectionId);
          next = { ...config, supabase: { ...config.supabase, [action.connectionId]: connection } };
        } else if (action.type === "disconnect_supabase") {
          const { [action.connectionId]: _removed, ...supabase } = config.supabase;
          next = { ...config, supabase };
        } else if (
          action.type === "select_supabase_project" ||
          action.type === "select_supabase_branch"
        ) {
          const connection = config.supabase[action.connectionId];
          if (!connection)
            return yield* new ProjectIntegrationsError({ code: "connection_not_found" });
          const available = yield* catalogFor(
            action.type === "select_supabase_project"
              ? { ...connection, project: null, branch: null }
              : connection,
            input.projectId,
            action.connectionId,
          );
          let selected = connection;
          if (action.type === "select_supabase_project") {
            const project =
              action.projectRef === null
                ? null
                : available.projects.find((entry) => entry.ref === action.projectRef);
            if (project === undefined)
              return yield* new ProjectIntegrationsError({ code: "invalid_selection" });
            selected = {
              ...connection,
              label: project?.name ?? connection.label,
              project,
              branch: null,
            };
          } else {
            const branch =
              action.branchId === null
                ? null
                : available.branches.find((entry) => entry.id === action.branchId);
            if (branch === undefined)
              return yield* new ProjectIntegrationsError({ code: "invalid_selection" });
            selected = {
              ...connection,
              branch:
                branch === null
                  ? null
                  : {
                      id: branch.id,
                      name: branch.name,
                      projectRef: branch.projectRef,
                      isDefault: branch.isDefault,
                    },
            };
          }
          next = { ...config, supabase: { ...config.supabase, [action.connectionId]: selected } };
        } else if (action.type === "disconnect_github") {
          next = { ...config, github: null };
        } else {
          let token: string;
          if (
            (action.accessToken === "" || action.accessToken === SECRET_REDACTED) &&
            config.github?.oauthSession !== undefined &&
            Option.isSome(auth)
          ) {
            token = yield* auth.value.accessToken(input.projectId, "github");
          } else if (action.accessToken === "") {
            const result = yield* process
              .run({
                operation: "ProjectIntegrations.githubCredential",
                command: "gh",
                args: [
                  "auth",
                  "token",
                  "--hostname",
                  "github.com",
                  ...(action.account ? ["--user", action.account] : []),
                ],
                cwd: project.workspaceRoot,
                env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1", GH_TOKEN: "", GITHUB_TOKEN: "" },
                timeoutMs: 10_000,
              })
              .pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "credentials" })));
            token = result.stdout.trim();
          } else
            token = yield* credential(
              action.accessToken === SECRET_REDACTED && config.github
                ? config.github.accessToken
                : action.accessToken,
            );
          if (!token) return yield* new ProjectIntegrationsError({ code: "credentials" });
          const user = yield* request("github", "/user", token, ApiUser);
          if (action.account && action.account.toLowerCase() !== user.login.toLowerCase())
            return yield* new ProjectIntegrationsError({ code: "credentials" });
          const repository = yield* request(
            "github",
            `/repos/${action.repository}`,
            token,
            ApiRepo,
          );
          next = {
            ...config,
            github: {
              repository: repository.full_name,
              account: user.login,
              accessToken:
                config.github?.oauthSession &&
                (action.accessToken === "" || action.accessToken === SECRET_REDACTED)
                  ? ""
                  : token,
              ...(config.github?.oauthSession &&
              (action.accessToken === "" || action.accessToken === SECRET_REDACTED)
                ? { oauthSession: config.github.oauthSession }
                : {}),
            },
          };
        }
        yield* store.modify(input.projectId, (latest) =>
          Effect.gen(function* () {
            if (action.type === "disconnect_github") return { ...latest, github: null };
            if (action.type === "connect_github") {
              if (next.github?.oauthSession) {
                if (!latest.github?.oauthSession || latest.github.account !== next.github.account)
                  return yield* new ProjectIntegrationsError({ code: "credentials" });
                return {
                  ...latest,
                  github: { ...next.github, oauthSession: latest.github.oauthSession },
                };
              }
              return { ...latest, github: next.github };
            }
            if (action.type === "disconnect_supabase") {
              const { [action.connectionId]: _removed, ...supabase } = latest.supabase;
              return { ...latest, supabase };
            }
            const candidate = next.supabase[action.connectionId]!;
            if (action.type === "connect_supabase")
              return {
                ...latest,
                supabase: { ...latest.supabase, [action.connectionId]: candidate },
              };
            const current = latest.supabase[action.connectionId];
            if (!current)
              return yield* new ProjectIntegrationsError({ code: "connection_not_found" });
            if (
              action.type === "select_supabase_branch" &&
              current.project?.ref !== candidate.project?.ref
            )
              return yield* new ProjectIntegrationsError({ code: "invalid_selection" });
            const selected =
              action.type === "select_supabase_project"
                ? { ...current, label: candidate.label, project: candidate.project, branch: null }
                : { ...current, branch: candidate.branch };
            return { ...latest, supabase: { ...latest.supabase, [action.connectionId]: selected } };
          }),
        );
        return yield* get(input.projectId);
      }),
    );
  });
  const githubCatalog = Effect.fn("ProjectIntegrations.githubCatalog")(function* ({
    projectId,
    page,
  }: GitHubIntegrationCatalogInput) {
    const { config } = yield* read(projectId);
    if (!config.github)
      return yield* new ProjectIntegrationsError({ code: "connection_not_found" });
    const token = yield* config.github.oauthSession !== undefined && Option.isSome(auth)
      ? auth.value.accessToken(projectId, "github")
      : credential(config.github.accessToken);
    const user = yield* request("github", "/user", token, ApiUser);
    if (user.login.toLowerCase() !== config.github.account.toLowerCase())
      return yield* new ProjectIntegrationsError({ code: "credentials" });
    const repositories = yield* request(
      "github",
      `/user/repos?per_page=100&page=${page}&sort=updated`,
      token,
      Schema.Array(ApiRepo),
    );
    return {
      account: user.login,
      repositories: repositories.map((repository) => repository.full_name),
      nextPage: repositories.length === 100 ? page + 1 : null,
    };
  });
  return ProjectIntegrations.of({ get, catalog, update, githubCatalog });
});

export const layer = Layer.effect(ProjectIntegrations, make);
