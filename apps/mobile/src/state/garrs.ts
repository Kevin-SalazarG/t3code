import { createGarrsEnvironmentAtoms } from "@t3tools/client-runtime/state/garrs";

import { connectionAtomRuntime } from "../connection/runtime";

export const garrsEnvironment = createGarrsEnvironmentAtoms(connectionAtomRuntime);
