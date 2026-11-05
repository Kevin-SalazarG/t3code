const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isUnsafeGarrsMcpServer(server: {
  readonly name: string;
  readonly tools: Readonly<Record<string, { readonly name: string }>>;
  readonly runtimeStatus?: string | null;
  readonly toolsError?: string | null;
  readonly resources?: ReadonlyArray<unknown>;
  readonly resourceTemplates?: ReadonlyArray<unknown>;
}): boolean {
  // Codex includes disabled servers in its inventory; unknown or advertised access stays blocked.
  return (
    server.name !== "t3-code" &&
    (server.runtimeStatus !== "disabled" ||
      Object.keys(server.tools).length > 0 ||
      server.toolsError != null ||
      (server.resources?.length ?? 0) > 0 ||
      (server.resourceTemplates?.length ?? 0) > 0)
  );
}

export function hasGarrsMcpTool(server: {
  readonly name: string;
  readonly tools: Readonly<Record<string, { readonly name: string }>>;
  readonly runtimeStatus?: string | null;
  readonly toolsError?: string | null;
}): boolean {
  return (
    server.name === "t3-code" &&
    (server.runtimeStatus == null || server.runtimeStatus === "connected") &&
    server.toolsError == null &&
    Object.values(server.tools).some((tool) => tool.name === "garrs")
  );
}

export function unsafeConfiguredMcpServers(config: unknown): ReadonlyArray<string> | null {
  if (!isRecord(config)) return null;
  if (config.mcp_servers === undefined) return [];
  if (!isRecord(config.mcp_servers)) return null;
  const unsafe: Array<string> = [];
  for (const [name, server] of Object.entries(config.mcp_servers)) {
    if (!isRecord(server) || (server.enabled !== undefined && typeof server.enabled !== "boolean"))
      return null;
    if (server.enabled !== false) unsafe.push(name);
  }
  return unsafe;
}
