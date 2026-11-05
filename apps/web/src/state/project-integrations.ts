import { createProjectIntegrationsAtoms } from "@t3tools/client-runtime/state/project-integrations";
import { connectionAtomRuntime } from "../connection/runtime";
export const projectIntegrations = createProjectIntegrationsAtoms(connectionAtomRuntime);
