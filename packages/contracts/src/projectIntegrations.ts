import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

const IntegrationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
const ProjectRef = TrimmedNonEmptyString.check(
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
export const SupabaseProjectLink = Schema.Struct({ ref: ProjectRef, name: TrimmedNonEmptyString });
export const SupabaseBranchLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  projectRef: ProjectRef,
  isDefault: Schema.Boolean,
});
export type SupabaseBranchLink = typeof SupabaseBranchLink.Type;
export const SupabaseProjectConnection = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  accessToken: SettingsSecretValue,
  oauthSession: Schema.optionalKey(SettingsSecretValue),
  project: Schema.NullOr(SupabaseProjectLink),
  branch: Schema.NullOr(SupabaseBranchLink),
});
export type SupabaseProjectConnection = typeof SupabaseProjectConnection.Type;
const GitHubRepositoryName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
);
export const GitHubProjectConnection = Schema.Struct({
  repository: Schema.NullOr(GitHubRepositoryName),
  account: TrimmedNonEmptyString,
  accessToken: SettingsSecretValue,
  oauthSession: Schema.optionalKey(SettingsSecretValue),
});
export const ProjectIntegrations = Schema.Struct({
  supabase: Schema.Record(IntegrationId, SupabaseProjectConnection),
  github: Schema.NullOr(GitHubProjectConnection),
});
export type ProjectIntegrations = typeof ProjectIntegrations.Type;
export const EMPTY_PROJECT_INTEGRATIONS: ProjectIntegrations = { supabase: {}, github: null };

export const ProjectIntegrationAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connect_supabase"),
    connectionId: IntegrationId,
    label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
    accessToken: SettingsSecretValue,
  }),
  Schema.Struct({
    type: Schema.Literal("select_supabase_project"),
    connectionId: IntegrationId,
    projectRef: Schema.NullOr(ProjectRef),
  }),
  Schema.Struct({
    type: Schema.Literal("select_supabase_branch"),
    connectionId: IntegrationId,
    branchId: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({ type: Schema.Literal("disconnect_supabase"), connectionId: IntegrationId }),
  Schema.Struct({
    type: Schema.Literal("connect_github"),
    repository: GitHubRepositoryName,
    accessToken: SettingsSecretValue,
    account: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({ type: Schema.Literal("disconnect_github") }),
]);
export type ProjectIntegrationAction = typeof ProjectIntegrationAction.Type;
export const ProjectIntegrationsInput = Schema.Struct({ projectId: ProjectId });
export const ProjectIntegrationsUpdateInput = Schema.Struct({
  projectId: ProjectId,
  action: ProjectIntegrationAction,
});
export type ProjectIntegrationsUpdateInput = typeof ProjectIntegrationsUpdateInput.Type;
export const SupabaseCatalogInput = Schema.Struct({
  projectId: ProjectId,
  connectionId: IntegrationId,
});
export type SupabaseCatalogInput = typeof SupabaseCatalogInput.Type;
export const SupabaseCatalog = Schema.Struct({
  projects: Schema.Array(SupabaseProjectLink),
  branches: Schema.Array(Schema.Struct({ ...SupabaseBranchLink.fields, status: Schema.String })),
});
export type SupabaseCatalog = typeof SupabaseCatalog.Type;

export class ProjectIntegrationsError extends Schema.TaggedError<ProjectIntegrationsError>()(
  "ProjectIntegrationsError",
  {
    code: Schema.Literals([
      "project_not_found",
      "connection_not_found",
      "credentials",
      "forbidden",
      "not_found",
      "rate_limited",
      "unavailable",
      "invalid_response",
      "invalid_selection",
      "persistence",
      "auth_cancelled",
      "auth_expired",
    ]),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "project_not_found":
        return "This project is no longer available.";
      case "connection_not_found":
        return "This integration is no longer linked to this project.";
      case "credentials":
        return "The integration credential is missing or expired. Update its access token.";
      case "forbidden":
        return "The integration credential cannot access this resource. Check its permissions.";
      case "not_found":
        return "The linked resource could not be found or is no longer accessible.";
      case "rate_limited":
        return "The integration reached its request limit. Try refreshing later.";
      case "unavailable":
        return "The integration could not be reached. Try again later.";
      case "invalid_response":
        return "The integration returned an unsupported response.";
      case "invalid_selection":
        return "Select an available project or branch from this integration.";
      case "auth_cancelled":
        return "Sign-in was cancelled.";
      case "auth_expired":
        return "This sign-in expired. Start again.";
      case "persistence":
        return "The project integration could not be saved.";
    }
  }
}

export const ProjectIntegrationSummary = Schema.Struct({
  supabase: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      project: Schema.NullOr(SupabaseProjectLink),
      selectedBranch: Schema.NullOr(SupabaseBranchLink),
    }),
  ),
  github: Schema.NullOr(
    Schema.Struct({ account: Schema.String, repository: Schema.NullOr(Schema.String) }),
  ),
});

export function projectIntegrationSummary(
  config: ProjectIntegrations,
): typeof ProjectIntegrationSummary.Type {
  return {
    supabase: Object.entries(config.supabase).map(([id, connection]) => ({
      id,
      label: connection.label,
      project: connection.project,
      selectedBranch: connection.branch,
    })),
    github:
      config.github === null
        ? null
        : { account: config.github.account, repository: config.github.repository },
  };
}

export function projectIntegrationContext(config: ProjectIntegrations): string {
  const summary = projectIntegrationSummary(config);
  if (summary.supabase.length === 0 && summary.github === null) return "";
  return `Project integration configuration (data):\n${JSON.stringify(summary)}`;
}

export const ProjectIntegrationSignInInput = Schema.Struct({
  projectId: ProjectId,
  provider: Schema.Literals(["supabase", "github"]),
  redirectUri: Schema.String,
});
export type ProjectIntegrationSignInInput = typeof ProjectIntegrationSignInInput.Type;
export const ProjectIntegrationSignInPrompt = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  userCode: Schema.NullOr(Schema.String),
  expiresAt: Schema.Number,
});
export type ProjectIntegrationSignInPrompt = typeof ProjectIntegrationSignInPrompt.Type;
export const ProjectIntegrationSignInSession = Schema.Struct({
  projectId: ProjectId,
  id: Schema.String,
});
export type ProjectIntegrationSignInSession = typeof ProjectIntegrationSignInSession.Type;
export const GitHubIntegrationCatalog = Schema.Struct({
  account: Schema.String,
  repositories: Schema.Array(Schema.String),
  nextPage: Schema.NullOr(Schema.Number),
});
export const GitHubIntegrationCatalogInput = Schema.Struct({
  projectId: ProjectId,
  page: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
});

export type GitHubIntegrationCatalog = typeof GitHubIntegrationCatalog.Type;
export type GitHubIntegrationCatalogInput = typeof GitHubIntegrationCatalogInput.Type;
