import {
  ProjectIntegrationsError,
  EMPTY_PROJECT_INTEGRATIONS,
  SourceControlProviderKind,
  type ProjectId,
  type ProjectIntegrationSignInInput,
  type ProjectIntegrationSignInPrompt,
  type ProjectIntegrationSignInSession,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as IntegrationStore from "./ProjectIntegrationStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlSignIn from "../sourceControl/SourceControlSignIn.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";

const CALLBACK_PATH = "/api/project-integrations/oauth/callback";
const OAuthSession = Schema.Struct({
  provider: Schema.Literals(["supabase", "github"]),
  clientId: Schema.String,
  clientSecret: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
});
const OAuthSessionJson = Schema.fromJsonString(OAuthSession);
const OAuthTokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
});
const RegisteredClient = Schema.Struct({ client_id: Schema.String, client_secret: Schema.String });
const AppSession = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    accessTokenExpiresAt: Schema.NullOr(Schema.Number),
    refreshToken: Schema.NullOr(Schema.String),
  }),
);

const encodeOAuthSession = Schema.encodeEffect(OAuthSessionJson);
const decodeOAuthSession = Schema.decodeEffect(OAuthSessionJson);
const decodeAppSession = Schema.decodeUnknownEffect(AppSession);
const decodeAppSettings = Schema.decodeUnknownEffect(
  Schema.Struct({ signIns: Schema.Record(Schema.String, Schema.String) }),
);

interface Pending {
  readonly projectId: ProjectId;
  readonly prompt: ProjectIntegrationSignInPrompt;
  readonly done: Deferred.Deferred<void, ProjectIntegrationsError>;
  readonly oauth?: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly verifier: string;
    readonly redirectUri: string;
  };
  fiber?: Fiber.Fiber<void>;
  consumed: boolean;
  cancel?: Effect.Effect<void>;
}

export class ProjectIntegrationAuth extends Context.Service<
  ProjectIntegrationAuth,
  {
    readonly start: (
      input: ProjectIntegrationSignInInput,
    ) => Effect.Effect<ProjectIntegrationSignInPrompt, ProjectIntegrationsError>;
    readonly wait: (
      input: ProjectIntegrationSignInSession,
    ) => Effect.Effect<void, ProjectIntegrationsError>;
    readonly cancel: (
      input: ProjectIntegrationSignInSession,
    ) => Effect.Effect<void, ProjectIntegrationsError>;
    readonly complete: (query: URLSearchParams) => Effect.Effect<void, ProjectIntegrationsError>;
    readonly accessToken: (
      projectId: ProjectId,
      provider: "supabase" | "github",
      connectionId?: string,
    ) => Effect.Effect<string, ProjectIntegrationsError>;
  }
>()("t3/project/ProjectIntegrationAuth") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const store = yield* IntegrationStore.ProjectIntegrationStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const secrets = yield* SecretResolver.SecretResolver;
  const http = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const vcs = yield* VcsProcess.VcsProcess;
  const hostEnvironment = yield* HostProcess.Environment;
  const sourceControl = yield* Effect.serviceOption(SourceControlSignIn.SourceControlSignIn);
  const scope = yield* Effect.scope;
  const pending = new Map<string, Pending>();
  const refreshLock = yield* KeyedLock.make<string>();

  const read = Effect.fn("ProjectIntegrationAuth.read")(function* (projectId: ProjectId) {
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
  const request = Effect.fn("ProjectIntegrationAuth.request")(
    function* <S extends Schema.Top>(request: HttpClientRequest.HttpClientRequest, schema: S) {
      const response = yield* http
        .execute(request)
        .pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "unavailable" })));
      if (response.status < 200 || response.status >= 300)
        return yield* new ProjectIntegrationsError({
          code: response.status === 429 ? "rate_limited" : "credentials",
        });
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
  const postForm = (
    url: string,
    values: Record<string, string>,
    client?: { readonly clientId: string; readonly clientSecret: string },
  ) => {
    const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(values));
    return client
      ? request.pipe(
          HttpClientRequest.setHeader(
            "Authorization",
            `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
          ),
        )
      : request;
  };
  const saveSupabase = Effect.fn("ProjectIntegrationAuth.saveSupabase")(function* (
    projectId: ProjectId,
    connectionId: string,
    session: typeof OAuthSession.Type,
  ) {
    const oauthSession = yield* encodeOAuthSession(session).pipe(
      Effect.mapError(() => new ProjectIntegrationsError({ code: "persistence" })),
    );
    yield* store.modify(projectId, (config) =>
      Effect.succeed({
        ...config,
        supabase: {
          ...config.supabase,
          [connectionId]: {
            label: `Supabase ${Object.keys(config.supabase).length + 1}`,
            accessToken: "",
            oauthSession,
            project: null,
            branch: null,
          },
        },
      }),
    );
  });
  const saveGithub = Effect.fn("ProjectIntegrationAuth.saveGithub")(function* (
    projectId: ProjectId,
    token: string,
    session?: typeof OAuthSession.Type,
  ) {
    const user = yield* request(
      HttpClientRequest.get("https://api.github.com/user").pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("User-Agent", "T3-Code"),
      ),
      Schema.Struct({ login: Schema.String }),
    );
    const oauthSession = session
      ? yield* encodeOAuthSession(session).pipe(
          Effect.mapError(() => new ProjectIntegrationsError({ code: "persistence" })),
        )
      : undefined;
    yield* store.modify(projectId, (config) =>
      Effect.succeed({
        ...config,
        github: {
          account: user.login,
          repository: null,
          accessToken: session ? "" : token,
          ...(oauthSession === undefined ? {} : { oauthSession }),
        },
      }),
    );
  });

  const start = Effect.fn("ProjectIntegrationAuth.start")(function* (
    input: ProjectIntegrationSignInInput,
  ) {
    const { project } = yield* read(input.projectId);
    const now = yield* Clock.currentTimeMillis;
    for (const [id, entry] of pending)
      if (entry.prompt.expiresAt < now) {
        pending.delete(id);
        yield* Deferred.fail(entry.done, new ProjectIntegrationsError({ code: "auth_expired" }));
        if (entry.cancel) yield* entry.cancel;
        if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
      }
    if (pending.size >= 20) return yield* new ProjectIntegrationsError({ code: "rate_limited" });
    const id = Buffer.from(yield* random.randomBytes(32)).toString("base64url");
    const done = yield* Deferred.make<void, ProjectIntegrationsError>();
    if (input.provider === "supabase") {
      const redirect = yield* Effect.try({
        try: () => new URL(input.redirectUri),
        catch: () => new ProjectIntegrationsError({ code: "invalid_selection" }),
      });
      if (
        !["http:", "https:"].includes(redirect.protocol) ||
        redirect.username ||
        redirect.password ||
        !redirect.pathname.endsWith(CALLBACK_PATH) ||
        redirect.search ||
        redirect.hash
      )
        return yield* new ProjectIntegrationsError({ code: "invalid_selection" });
      const verifier = Buffer.from(yield* random.randomBytes(32)).toString("base64url");
      const challenge = Buffer.from(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)).pipe(Effect.orDie),
      ).toString("base64url");
      const client = yield* request(
        HttpClientRequest.post("https://api.supabase.com/platform/oauth/apps/register").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            client_name: "T3 Code",
            redirect_uris: [redirect.href],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "client_secret_basic",
            scope: "organizations:read projects:read environment:read",
          }),
        ),
        RegisteredClient,
      );
      const url = new URL("https://api.supabase.com/v1/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect.href,
        response_type: "code",
        state: id,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      const prompt = { id, url: url.href, userCode: null, expiresAt: now + 600_000 };
      pending.set(id, {
        projectId: input.projectId,
        prompt,
        done,
        consumed: false,
        oauth: {
          clientId: client.client_id,
          clientSecret: client.client_secret,
          verifier,
          redirectUri: redirect.href,
        },
      });
      return prompt;
    }
    const promptReady = yield* Deferred.make<
      ProjectIntegrationSignInPrompt,
      ProjectIntegrationsError
    >();
    const entry: Pending = {
      projectId: input.projectId,
      prompt: {
        id,
        url: "https://github.com/login/device",
        userCode: null,
        expiresAt: now + 600_000,
      },
      done,
      consumed: false,
    };
    pending.set(id, entry);
    const login = Effect.gen(function* () {
      const appPrompt = Option.isNone(sourceControl)
        ? null
        : yield* sourceControl.value
            .start({ provider: SourceControlProviderKind.make("github"), host: "github.com" })
            .pipe(
              Effect.catchTags({
                SourceControlSignInError: (error) =>
                  error.reason === "unsupported"
                    ? Effect.succeed(null)
                    : Effect.fail(new ProjectIntegrationsError({ code: "unavailable" })),
              }),
            );
      if (appPrompt !== null && Option.isSome(sourceControl)) {
        entry.cancel = sourceControl.value
          .cancel({ provider: SourceControlProviderKind.make("github"), host: "github.com" })
          .pipe(Effect.ignore);
        yield* Deferred.succeed(promptReady, {
          id,
          url: appPrompt.verificationUri,
          userCode: appPrompt.userCode,
          expiresAt: appPrompt.expiresAt,
        });
        yield* sourceControl.value
          .wait({ provider: SourceControlProviderKind.make("github"), host: "github.com" })
          .pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "credentials" })));
        const current = (yield* read(input.projectId)).settings.sourceControlHosts.github;
        const values = yield* decodeAppSettings(current).pipe(
          Effect.mapError(() => new ProjectIntegrationsError({ code: "credentials" })),
        );
        const session = yield* decodeAppSession(values.signIns["github.com"]).pipe(
          Effect.mapError(() => new ProjectIntegrationsError({ code: "credentials" })),
        );
        yield* saveGithub(input.projectId, session.accessToken, {
          provider: "github",
          clientId: hostEnvironment.T3CODE_GITHUB_APP_CLIENT_ID ?? "",
          clientSecret: "",
          accessToken: session.accessToken,
          refreshToken: session.refreshToken ?? "",
          expiresAt: session.accessTokenExpiresAt ?? Number.MAX_SAFE_INTEGER,
        });
      } else {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner
              .spawn(
                ChildProcess.make(
                  "gh",
                  [
                    "auth",
                    "login",
                    "--web",
                    "--hostname",
                    "github.com",
                    "--git-protocol",
                    "https",
                    "--skip-ssh-key",
                  ],
                  {
                    cwd: project.workspaceRoot,
                    env: {
                      GH_TOKEN: "",
                      GITHUB_TOKEN: "",
                      GH_BROWSER: "false",
                      GH_PROMPT_DISABLED: "1",
                    },
                  },
                ),
              )
              .pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "credentials" })));
            const readPrompt = (stream: typeof child.stdout) =>
              stream.pipe(
                Stream.decodeText,
                Stream.splitLines,
                Stream.runForEach((line) => {
                  const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(line)?.[1];
                  return code
                    ? Deferred.succeed(promptReady, { ...entry.prompt, userCode: code })
                    : Effect.void;
                }),
              );
            const [, , exitCode] = yield* Effect.all(
              [readPrompt(child.stdout), readPrompt(child.stderr), child.exitCode],
              { concurrency: "unbounded" },
            ).pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "credentials" })));
            if (Number(exitCode) !== 0)
              return yield* new ProjectIntegrationsError({ code: "credentials" });
          }),
        );
        const token = yield* vcs
          .run({
            operation: "ProjectIntegrationAuth.githubCredential",
            command: "gh",
            args: ["auth", "token", "--hostname", "github.com"],
            cwd: project.workspaceRoot,
            env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1", GH_TOKEN: "", GITHUB_TOKEN: "" },
            timeoutMs: 10_000,
          })
          .pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "credentials" })));
        yield* saveGithub(input.projectId, token.stdout.trim());
      }
    }).pipe(
      Effect.timeout("10 minutes"),
      Effect.mapError((error) =>
        error._tag === "TimeoutError"
          ? new ProjectIntegrationsError({ code: "auth_expired" })
          : error,
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.all([Deferred.fail(promptReady, error), Deferred.fail(done, error)]).pipe(
            Effect.asVoid,
          ),
        onSuccess: () => Deferred.succeed(done, undefined).pipe(Effect.asVoid),
      }),
    );
    entry.fiber = yield* Effect.forkIn(login, scope);
    return yield* Deferred.await(promptReady).pipe(
      Effect.timeout("20 seconds"),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(new ProjectIntegrationsError({ code: "unavailable" })),
      }),
    );
  });

  const complete = Effect.fn("ProjectIntegrationAuth.complete")(function* (query: URLSearchParams) {
    const entry = pending.get(query.get("state") ?? "");
    if (
      !entry?.oauth ||
      entry.consumed ||
      entry.prompt.expiresAt < (yield* Clock.currentTimeMillis)
    )
      return yield* new ProjectIntegrationsError({ code: "auth_expired" });
    entry.consumed = true;
    const result = yield* Effect.result(
      Effect.gen(function* () {
        if (query.has("error"))
          return yield* new ProjectIntegrationsError({ code: "auth_cancelled" });
        const code = query.get("code");
        if (!code || (query.has("iss") && query.get("iss") !== "https://api.supabase.com"))
          return yield* new ProjectIntegrationsError({ code: "credentials" });
        const oauth = entry.oauth!;
        const tokens = yield* request(
          postForm(
            "https://api.supabase.com/v1/oauth/token",
            {
              grant_type: "authorization_code",
              code,
              redirect_uri: oauth.redirectUri,
              code_verifier: oauth.verifier,
            },
            oauth,
          ),
          OAuthTokens,
        );
        if (pending.get(entry.prompt.id) !== entry)
          return yield* new ProjectIntegrationsError({ code: "auth_cancelled" });
        yield* saveSupabase(entry.projectId, entry.prompt.id, {
          provider: "supabase",
          clientId: oauth.clientId,
          clientSecret: oauth.clientSecret,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? "",
          expiresAt: (yield* Clock.currentTimeMillis) + (tokens.expires_in ?? 3600) * 1000,
        });
      }),
    );
    if (result._tag === "Failure") {
      yield* Deferred.fail(entry.done, result.failure);
      return yield* result.failure;
    }
    yield* Deferred.succeed(entry.done, undefined);
  });
  const sessionFor = (input: ProjectIntegrationSignInSession) => {
    const entry = pending.get(input.id);
    return entry?.projectId === input.projectId
      ? Effect.succeed(entry)
      : Effect.fail(new ProjectIntegrationsError({ code: "auth_expired" }));
  };
  const wait = Effect.fn("ProjectIntegrationAuth.wait")(function* (
    input: ProjectIntegrationSignInSession,
  ) {
    const entry = yield* sessionFor(input);
    yield* Deferred.await(entry.done).pipe(
      Effect.timeout("10 minutes"),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(new ProjectIntegrationsError({ code: "auth_expired" })),
      }),
      Effect.ensuring(Effect.sync(() => pending.delete(input.id))),
    );
  });
  const cancel = Effect.fn("ProjectIntegrationAuth.cancel")(function* (
    input: ProjectIntegrationSignInSession,
  ) {
    const entry = yield* sessionFor(input);
    pending.delete(input.id);
    entry.consumed = true;
    if (entry.cancel) yield* entry.cancel;
    if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
    yield* Deferred.fail(entry.done, new ProjectIntegrationsError({ code: "auth_cancelled" }));
  });
  const accessToken = Effect.fn("ProjectIntegrationAuth.accessToken")(function (
    projectId: ProjectId,
    provider: "supabase" | "github",
    connectionId?: string,
  ) {
    return refreshLock.withLock(
      `${projectId}:${provider}:${connectionId ?? ""}`,
      Effect.gen(function* () {
        const { config } = yield* read(projectId);
        const connection =
          provider === "github" ? config.github : config.supabase[connectionId ?? ""];
        if (!connection)
          return yield* new ProjectIntegrationsError({ code: "connection_not_found" });
        const resolve = (value: SettingsSecretValue) =>
          requireSettingsSecret(secrets, value).pipe(
            Effect.mapError(() => new ProjectIntegrationsError({ code: "credentials" })),
          );
        if (connection.oauthSession === undefined) return yield* resolve(connection.accessToken);
        const encoded = yield* resolve(connection.oauthSession);
        const session = yield* decodeOAuthSession(encoded).pipe(
          Effect.mapError(() => new ProjectIntegrationsError({ code: "credentials" })),
        );
        const now = yield* Clock.currentTimeMillis;
        if (session.provider !== provider)
          return yield* new ProjectIntegrationsError({ code: "credentials" });
        if (session.expiresAt > now + 60_000) return session.accessToken;
        if (!session.refreshToken)
          return yield* new ProjectIntegrationsError({ code: "credentials" });
        const url =
          provider === "supabase"
            ? "https://api.supabase.com/v1/oauth/token"
            : "https://github.com/login/oauth/access_token";
        const tokens = yield* request(
          postForm(
            url,
            {
              grant_type: "refresh_token",
              refresh_token: session.refreshToken,
              ...(provider === "github" ? { client_id: session.clientId } : {}),
            },
            provider === "supabase" ? session : undefined,
          ).pipe(HttpClientRequest.setHeader("Accept", "application/json")),
          OAuthTokens,
        );
        const oauthSession = yield* encodeOAuthSession({
          ...session,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? session.refreshToken,
          expiresAt: now + (tokens.expires_in ?? 3600) * 1000,
        }).pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "persistence" })));
        yield* store.modify(projectId, (latest) =>
          Effect.gen(function* () {
            const current =
              provider === "github" ? latest.github : latest.supabase[connectionId ?? ""];
            if (!current?.oauthSession || (yield* resolve(current.oauthSession)) !== encoded)
              return yield* new ProjectIntegrationsError({ code: "credentials" });
            return provider === "github"
              ? { ...latest, github: { ...latest.github!, oauthSession } }
              : {
                  ...latest,
                  supabase: {
                    ...latest.supabase,
                    [connectionId!]: { ...latest.supabase[connectionId!]!, oauthSession },
                  },
                };
          }),
        );
        return tokens.access_token;
      }),
    );
  });
  return ProjectIntegrationAuth.of({ start, complete, wait, cancel, accessToken });
});

export const layer = Layer.effect(ProjectIntegrationAuth, make);
export const layerCallback = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* ProjectIntegrationAuth;
    return HttpRouter.add(
      "GET",
      CALLBACK_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const result = yield* auth
          .complete(new URL(request.url, "http://localhost").searchParams)
          .pipe(Effect.result);
        const message =
          result._tag === "Success"
            ? "Connected. You can return to T3 Code and close this page."
            : result.failure.message;
        return HttpServerResponse.text(message, {
          status: result._tag === "Success" ? 200 : 400,
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
          },
        });
      }),
    );
  }),
);
