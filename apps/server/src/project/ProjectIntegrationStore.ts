import {
  EMPTY_PROJECT_INTEGRATIONS,
  ProjectIntegrationsError,
  type ProjectId,
  type ProjectIntegrations,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";

export class ProjectIntegrationStore extends Context.Service<
  ProjectIntegrationStore,
  {
    readonly modify: (
      projectId: ProjectId,
      change: (
        current: ProjectIntegrations,
      ) => Effect.Effect<ProjectIntegrations, ProjectIntegrationsError>,
    ) => Effect.Effect<ProjectIntegrations, ProjectIntegrationsError>;
  }
>()("t3/project/ProjectIntegrationStore") {}

export const layer = Layer.effect(
  ProjectIntegrationStore,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const lock = yield* KeyedLock.make<ProjectId>();
    const modify = Effect.fn("ProjectIntegrationStore.modify")(function (
      projectId: ProjectId,
      change: Parameters<ProjectIntegrationStore["Service"]["modify"]>[1],
    ) {
      return lock.withLock(
        projectId,
        Effect.gen(function* () {
          const project = yield* projects
            .get(projectId)
            .pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "persistence" })));
          if (Option.isNone(project))
            return yield* new ProjectIntegrationsError({ code: "project_not_found" });
          const current = yield* settings.getSettings.pipe(
            Effect.mapError(() => new ProjectIntegrationsError({ code: "persistence" })),
          );
          const next = yield* change(
            current.projectIntegrations[projectId] ?? EMPTY_PROJECT_INTEGRATIONS,
          );
          yield* settings
            .updateSettings({ projectIntegrations: { [projectId]: next } })
            .pipe(Effect.mapError(() => new ProjectIntegrationsError({ code: "persistence" })));
          return next;
        }),
      );
    });
    return ProjectIntegrationStore.of({ modify });
  }),
);
