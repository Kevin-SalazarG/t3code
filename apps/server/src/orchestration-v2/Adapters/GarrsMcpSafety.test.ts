import { describe, expect, it } from "@effect/vitest";
import {
  hasGarrsMcpTool,
  isUnsafeGarrsMcpServer,
  unsafeConfiguredMcpServers,
} from "./GarrsMcpSafety.ts";

describe("Garrs MCP configuration", () => {
  it("accepts external status rows only when disabled with no advertised tools", () => {
    const disabled = { name: "external", runtimeStatus: "disabled", tools: {} };
    expect(isUnsafeGarrsMcpServer(disabled)).toBe(false);
    expect(isUnsafeGarrsMcpServer({ ...disabled, tools: { mutate: { name: "mutate" } } })).toBe(
      true,
    );
    expect(isUnsafeGarrsMcpServer({ ...disabled, resources: [{ uri: "external:resource" }] })).toBe(
      true,
    );
    expect(
      isUnsafeGarrsMcpServer({
        ...disabled,
        resourceTemplates: [{ uriTemplate: "external:{id}" }],
      }),
    ).toBe(true);
    expect(isUnsafeGarrsMcpServer({ ...disabled, toolsError: "Incomplete tool inventory" })).toBe(
      true,
    );
    for (const runtimeStatus of [
      undefined,
      null,
      "notStarted",
      "starting",
      "connected",
      "authenticationRequired",
      "failed",
      "cancelled",
    ]) {
      expect(
        isUnsafeGarrsMcpServer({
          name: disabled.name,
          tools: {},
          ...(runtimeStatus === undefined ? {} : { runtimeStatus }),
        }),
      ).toBe(true);
    }
    expect(isUnsafeGarrsMcpServer({ ...disabled, name: "t3-code" })).toBe(false);
  });
  it("does not treat a configured T3 server as ready until its Garrs tool is advertised", () => {
    expect(hasGarrsMcpTool({ name: "t3-code", tools: {} })).toBe(false);
    expect(hasGarrsMcpTool({ name: "external", tools: { garrs: { name: "garrs" } } })).toBe(false);
    expect(hasGarrsMcpTool({ name: "t3-code", tools: { status: { name: "status" } } })).toBe(false);
    expect(hasGarrsMcpTool({ name: "t3-code", tools: { garrs: { name: "garrs" } } })).toBe(true);
    expect(
      hasGarrsMcpTool({
        name: "t3-code",
        tools: { garrs: { name: "garrs" } },
        runtimeStatus: "failed",
      }),
    ).toBe(false);
    expect(
      hasGarrsMcpTool({
        name: "t3-code",
        tools: { garrs: { name: "garrs" } },
        toolsError: "Unavailable",
      }),
    ).toBe(false);
  });
  it("refuses active external servers, accepts disabled servers, and fails closed on malformed entries", () => {
    expect(unsafeConfiguredMcpServers({})).toEqual([]);
    expect(unsafeConfiguredMcpServers({ mcp_servers: { disabled: { enabled: false } } })).toEqual(
      [],
    );
    expect(unsafeConfiguredMcpServers({ mcp_servers: { "t3-code": { url: "local" } } })).toEqual([
      "t3-code",
    ]);
    expect(unsafeConfiguredMcpServers({ mcp_servers: { external: { enabled: true } } })).toEqual([
      "external",
    ]);
    expect(unsafeConfiguredMcpServers({ mcp_servers: { external: {} } })).toEqual(["external"]);
    expect(unsafeConfiguredMcpServers({ mcp_servers: null })).toBeNull();
    expect(unsafeConfiguredMcpServers({ mcp_servers: { external: "invalid" } })).toBeNull();
  });
});
