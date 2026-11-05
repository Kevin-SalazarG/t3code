import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SourceControlSignIn from "../sourceControl/SourceControlSignIn.ts";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Settings from "../serverSettings.ts";
import * as IntegrationStore from "./ProjectIntegrationStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Auth from "./ProjectIntegrationAuth.ts";

const projectId = ProjectId.make("oauth-project");
const redirectUri = "http://localhost:3773/api/project-integrations/oauth/callback";

const setup = (
  options: { readonly beforeToken?: Effect.Effect<void>; readonly githubApp?: boolean } = {},
) => {
  const requests: Array<{ path: string; body: string; authorization: string | undefined }> = [];
  let exchanges = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/token") && options.beforeToken) yield* options.beforeToken;
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ path, body, authorization: request.headers.authorization });
      const response = path.endsWith("/register")
        ? { client_id: "public-client", client_secret: "private-client-secret" }
        : path === "/user"
          ? { login: "project-account" }
          : {
              access_token: `private-access-${++exchanges}`,
              refresh_token: `private-refresh-${exchanges}`,
              expires_in: 120,
            };
      return HttpClientResponse.fromWeb(request, Response.json(response));
    }),
  );
  return {
    requests,
    layer: Auth.layer.pipe(
      Layer.provideMerge(IntegrationStore.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          Settings.ServerSettingsService.layerTest(
            options.githubApp
              ? {
                  sourceControlHosts: {
                    github: {
                      signIns: {
                        "github.com":
                          '{"accessToken":"private-github-access","accessTokenExpiresAt":9999999999999,"refreshToken":"private-github-refresh"}',
                      },
                    },
                  },
                }
              : {},
          ),
          ...(options.githubApp
            ? [
                Layer.mock(SourceControlSignIn.SourceControlSignIn)({
                  start: () =>
                    Effect.succeed({
                      userCode: "TEST-CODE",
                      verificationUri: "https://github.com/login/device",
                      expiresAt: 9999999999999,
                    }),
                  wait: () => Effect.succeed({ account: "project-account" }),
                  cancel: () => Effect.void,
                }),
              ]
            : []),
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(HostProcess.Environment, {}),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}),
          Layer.mock(VcsProcess.VcsProcess)({}),
          Layer.mock(SecretResolver.SecretResolver)({ read: () => Effect.succeed([]) }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) =>
              Effect.succeedSome({
                projectId: id,
                title: "App",
                workspaceRoot: "/home/user/app",
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                pinnedAt: null,
                archivedAt: null,
                createdAt: "2026-11-04T00:00:00Z",
                updatedAt: "2026-11-04T00:00:00Z",
                deletedAt: null,
              }),
          }),
        ),
      ),
      Layer.provide(NodeCrypto.layer),
    ),
  };
};

it.effect(
  "authorizes with PKCE once and refreshes a vaulted session without losing project selection",
  () => {
    const fixture = setup();
    return Effect.gen(function* () {
      const auth = yield* Auth.ProjectIntegrationAuth;
      const settings = yield* Settings.ServerSettingsService;
      const prompt = yield* auth.start({ projectId, provider: "supabase", redirectUri });
      const url = new URL(prompt.url);
      expect(url.origin).toBe("https://api.supabase.com");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toHaveLength(43);
      expect(prompt.url).not.toContain("private-client-secret");
      expect(
        (yield* auth
          .wait({ projectId: ProjectId.make("other-project"), id: prompt.id })
          .pipe(Effect.flip)).code,
      ).toBe("auth_expired");
      yield* auth.complete(
        new URLSearchParams({
          state: prompt.id,
          code: "private-code",
          iss: "https://api.supabase.com",
        }),
      );
      yield* auth.wait({ projectId, id: prompt.id });
      expect(
        (yield* auth
          .complete(new URLSearchParams({ state: prompt.id, code: "replay" }))
          .pipe(Effect.flip)).code,
      ).toBe("auth_expired");
      const connection = (yield* settings.getSettings).projectIntegrations[projectId]!.supabase[
        prompt.id
      ]!;
      expect(connection.accessToken).toBe("");
      expect(connection.oauthSession).toContain("private-refresh-1");
      const config = (yield* settings.getSettings).projectIntegrations[projectId]!;
      yield* settings.updateSettings({
        projectIntegrations: {
          [projectId]: {
            ...config,
            supabase: {
              ...config.supabase,
              [prompt.id]: {
                ...connection,
                project: { ref: "production", name: "App" },
                branch: { id: "dev", name: "dev", projectRef: "development", isDefault: false },
              },
            },
          },
        },
      });
      expect(yield* auth.accessToken(projectId, "supabase", prompt.id)).toBe("private-access-1");
      yield* TestClock.adjust("90 seconds");
      expect(
        yield* Effect.all(
          [
            auth.accessToken(projectId, "supabase", prompt.id),
            auth.accessToken(projectId, "supabase", prompt.id),
          ],
          { concurrency: "unbounded" },
        ),
      ).toEqual(["private-access-2", "private-access-2"]);
      expect(
        (yield* settings.getSettings).projectIntegrations[projectId]?.supabase[prompt.id]?.branch
          ?.projectRef,
      ).toBe("development");
      const tokenRequests = fixture.requests.filter((request) => request.path.endsWith("/token"));
      expect(tokenRequests).toHaveLength(2);
      const exchange = new URLSearchParams(tokenRequests[0]?.body);
      expect(exchange.get("code")).toBe("private-code");
      expect(exchange.get("code_verifier")).toHaveLength(43);
      expect(tokenRequests[0]?.authorization).toBe(
        `Basic ${Buffer.from("public-client:private-client-secret").toString("base64")}`,
      );
      expect(new URLSearchParams(tokenRequests[1]?.body).get("refresh_token")).toBe(
        "private-refresh-1",
      );
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect.each(["cancel", "denied", "expired", "wrong-issuer", "invalid-callback"] as const)(
  "refuses an OAuth %s without saving credentials",
  (scenario) => {
    const fixture = setup();
    return Effect.gen(function* () {
      const auth = yield* Auth.ProjectIntegrationAuth;
      const settings = yield* Settings.ServerSettingsService;
      if (scenario === "invalid-callback") {
        expect(
          (yield* auth
            .start({ projectId, provider: "supabase", redirectUri: "https://example.test/other" })
            .pipe(Effect.flip)).code,
        ).toBe("invalid_selection");
        expect(fixture.requests).toEqual([]);
        return;
      }
      const prompt = yield* auth.start({ projectId, provider: "supabase", redirectUri });
      if (scenario === "cancel") yield* auth.cancel({ projectId, id: prompt.id });
      if (scenario === "expired") yield* TestClock.adjust("11 minutes");
      const result = yield* auth
        .complete(
          new URLSearchParams({
            state: prompt.id,
            code: "code",
            ...(scenario === "denied" ? { error: "access_denied" } : {}),
            ...(scenario === "wrong-issuer" ? { iss: "https://example.test" } : {}),
          }),
        )
        .pipe(Effect.flip);
      expect(result.code).toBe(
        scenario === "denied"
          ? "auth_cancelled"
          : scenario === "wrong-issuer"
            ? "credentials"
            : "auth_expired",
      );
      expect(fixture.requests.filter((request) => request.path.endsWith("/token"))).toEqual([]);
      expect((yield* settings.getSettings).projectIntegrations).toEqual({});
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect("does not save a cancelled session when the code exchange finishes afterwards", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const fixture = setup({
      beforeToken: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
      ),
    });
    yield* Effect.gen(function* () {
      const auth = yield* Auth.ProjectIntegrationAuth;
      const settings = yield* Settings.ServerSettingsService;
      const prompt = yield* auth.start({ projectId, provider: "supabase", redirectUri });
      const completing = yield* auth
        .complete(new URLSearchParams({ state: prompt.id, code: "code" }))
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* auth.cancel({ projectId, id: prompt.id });
      yield* Deferred.succeed(resume, undefined);
      expect(yield* Fiber.join(completing)).toMatchObject({
        _tag: "Failure",
        failure: { code: "auth_cancelled" },
      });
      expect((yield* settings.getSettings).projectIntegrations).toEqual({});
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect(
  "reuses GitHub's existing sign-in and keeps the account ready for repository selection",
  () => {
    const fixture = setup({ githubApp: true });
    return Effect.gen(function* () {
      const auth = yield* Auth.ProjectIntegrationAuth;
      const settings = yield* Settings.ServerSettingsService;
      const prompt = yield* auth.start({ projectId, provider: "github", redirectUri });
      expect(prompt.userCode).toBe("TEST-CODE");
      yield* auth.wait({ projectId, id: prompt.id });
      const github = (yield* settings.getSettings).projectIntegrations[projectId]?.github;
      expect(github?.account).toBe("project-account");
      expect(github?.repository).toBeNull();
      expect(github?.accessToken).toBe("");
      expect(github?.oauthSession).toContain("private-github-refresh");
      expect(yield* auth.accessToken(projectId, "github")).toBe("private-github-access");
    }).pipe(Effect.provide(fixture.layer));
  },
);
