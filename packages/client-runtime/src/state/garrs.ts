import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Garrs team state and controls for one environment. The server owns every decision. */
export function createGarrsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const config = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:garrs:config",
    tag: WS_METHODS.garrsGetConfig,
  });
  const binding = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:garrs:binding",
    tag: WS_METHODS.garrsGetProjectBinding,
  });
  const memory = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:garrs:memory",
    tag: WS_METHODS.garrsListMemory,
  });
  return {
    config,
    binding,
    memory,
    usage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:garrs:usage",
      tag: WS_METHODS.garrsGetUsage,
      staleTimeMs: 30_000,
    }),
    exportConfig: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:garrs:export",
      tag: WS_METHODS.garrsExportConfig,
    }),
    /** Team members, their current work, and the project's work items. */
    projectLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:garrs:project:live",
      tag: WS_METHODS.garrsSubscribeProject,
    }),
    /** One work item: plan, tasks, attempts, messages, results and reviews. */
    workItemLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:garrs:work-item:live",
      tag: WS_METHODS.garrsSubscribeWorkItem,
    }),
    updateConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:garrs:config:update",
      tag: WS_METHODS.garrsUpdateConfig,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(config({ environmentId, input: {} }))),
    }),
    updateBinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:garrs:binding:update",
      tag: WS_METHODS.garrsUpdateProjectBinding,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(
            binding({ environmentId, input: { projectId: input.binding.projectId } }),
          ),
        ),
    }),
    importConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:garrs:config:import",
      tag: WS_METHODS.garrsImportConfig,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(config({ environmentId, input: {} }))),
    }),
    startConversation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:garrs:start-conversation",
      tag: WS_METHODS.garrsStartConversation,
    }),
    control: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:garrs:control",
      tag: WS_METHODS.garrsControl,
    }),
    mutateMemory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:garrs:memory:mutate",
      tag: WS_METHODS.garrsMutateMemory,
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(memory({ environmentId, input: { projectId: input.projectId } })),
        ),
    }),
  };
}
