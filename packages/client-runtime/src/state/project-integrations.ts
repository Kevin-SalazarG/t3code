import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { SourceControlIcon } from "../sourceControlClients.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createProjectIntegrationsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const config = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "project-integrations:config",
    tag: WS_METHODS.projectIntegrationsGet,
  });
  const catalogQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "project-integrations:catalog-query",
    tag: WS_METHODS.projectIntegrationsCatalog,
    staleTimeMs: 30_000,
  });
  const githubCatalog = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "project-integrations:github-catalog",
    tag: WS_METHODS.projectIntegrationsGithubCatalog,
    staleTimeMs: 30_000,
  });
  return {
    config,
    githubCatalog,
    signIn: createEnvironmentRpcCommand(runtime, {
      label: "project-integrations:sign-in",
      tag: WS_METHODS.projectIntegrationsSignIn,
    }),
    waitForSignIn: createEnvironmentRpcCommand(runtime, {
      label: "project-integrations:wait-sign-in",
      tag: WS_METHODS.projectIntegrationsWaitForSignIn,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(config({ environmentId, input: { projectId: input.projectId } }));
          registry.refresh(
            githubCatalog({ environmentId, input: { projectId: input.projectId, page: 1 } }),
          );
        }),
    }),
    cancelSignIn: createEnvironmentRpcCommand(runtime, {
      label: "project-integrations:cancel-sign-in",
      tag: WS_METHODS.projectIntegrationsCancelSignIn,
    }),
    catalogQuery,
    update: createEnvironmentRpcCommand(runtime, {
      label: "project-integrations:update",
      tag: WS_METHODS.projectIntegrationsUpdate,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(config({ environmentId, input: { projectId: input.projectId } }));
          if ("connectionId" in input.action && input.action.type !== "disconnect_supabase")
            registry.refresh(
              catalogQuery({
                environmentId,
                input: { projectId: input.projectId, connectionId: input.action.connectionId },
              }),
            );
        }),
    }),
  };
}

export const supabaseIcon: SourceControlIcon = {
  viewBox: "0 0 109 113",
  gradients: [
    {
      id: "fill",
      x1: 53.9738,
      y1: 54.974,
      x2: 94.1635,
      y2: 71.8295,
      stops: [
        { offset: 0, color: "#249361" },
        { offset: 1, color: "#3ECF8E" },
      ],
    },
    {
      id: "shade",
      x1: 36.1558,
      y1: 30.578,
      x2: 54.4844,
      y2: 65.0806,
      stops: [
        { offset: 0, color: "#000000" },
        { offset: 1, color: "#000000", opacity: 0 },
      ],
    },
  ],
  paths: [
    {
      d: "M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z",
      fill: { gradient: "fill" },
    },
    {
      d: "M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z",
      fill: { gradient: "shade" },
      fillOpacity: 0.2,
    },
    {
      d: "M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.1655 56.4175L45.317 2.07103Z",
      fill: "#3ECF8E",
    },
  ],
};
