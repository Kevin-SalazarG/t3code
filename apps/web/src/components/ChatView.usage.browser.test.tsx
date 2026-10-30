import { createMemoryHistory } from "@tanstack/react-router";
import { ProviderDriverKind, ServerProvider, TurnItemId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const decodeServerProvider = Schema.decodeSync(ServerProvider);

function provider(instanceId: string, driver: string, displayName: string, usedPercent: number) {
  return decodeServerProvider({
    instanceId,
    driver,
    displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2099-03-18T09:00:00.000Z",
    models: [
      driver === "codex"
        ? { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }
        : {
            slug: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            isCustom: false,
            capabilities: null,
          },
    ],
    usageLimits: {
      checkedAt: "2099-03-18T09:00:00.000Z",
      windows: [{ id: "session", kind: "session", label: "Session", usedPercent }],
    },
  });
}

it("updates usage for the selected account without sending a message", async () => {
  const original = threadWithHistory("usage-switch", 1);
  const thread = {
    ...original,
    historyOrigin: "v1_import" as const,
    items: [
      ...original.items,
      {
        id: TurnItemId.make("usage-switch-compaction"),
        threadId: original.id,
        runId: original.runs[0]?.id ?? null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: original.items.length,
        status: "completed" as const,
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: original.items[0]!.updatedAt,
        type: "compaction" as const,
        driver: ProviderDriverKind.make("codex"),
        beforeTokenCount: 4_000,
        afterTokenCount: 2_000,
      },
    ],
  };
  using _environment = installFakeEnvironment([thread], {
    providers: [
      provider("codex", "codex", "Codex", 10),
      provider("claude-one", "claudeAgent", "Claude 1", 20),
      provider("claude-two", "claudeAgent", "Claude 2", 30),
    ],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  // AppRoot owns the application router.
  await using _screen = await render(<AppRoot router={router} />, { router: false });
  await expect
    .element(page.getByText(`Answer 0 for ${thread.id}.`, { exact: false }))
    .toBeVisible();
  if (
    document
      .querySelector('[aria-label="Toggle thread details panel"]')
      ?.getAttribute("aria-pressed") !== "true"
  ) {
    await userEvent.click(page.getByRole("button", { name: "Toggle thread details panel" }));
  }
  await expect.element(page.getByRole("heading", { name: "Codex" })).toBeVisible();
  await expect.element(page.getByLabelText("Session: 90% left")).toBeVisible();
  await expect.element(page.getByLabelText("Context: 2k")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "GPT-5.4" }));
  await userEvent.click(
    page.getByRole("toolbar", { name: "Providers" }).getByRole("button", { name: "Claude 1" }),
  );
  await userEvent.click(page.getByRole("option", { name: /Claude Sonnet 4\.6/ }));
  await expect.element(page.getByRole("button", { name: /Claude Sonnet 4\.6/ })).toBeVisible();
  expect(document.querySelector("#thread-details-usage-heading")?.textContent).toBe("Claude 1");
  await expect.element(page.getByLabelText("Session: 80% left")).toBeVisible();
  await expect.element(page.getByLabelText("Context: 2k")).not.toBeInTheDocument();

  await userEvent.click(page.getByRole("button", { name: /Claude Sonnet 4\.6/ }));
  await userEvent.click(
    page.getByRole("toolbar", { name: "Providers" }).getByRole("button", { name: "Claude 2" }),
  );
  await userEvent.click(page.getByRole("option", { name: /Claude Sonnet 4\.6/ }));
  await expect.element(page.getByRole("heading", { name: "Claude 2" })).toBeVisible();
  await expect.element(page.getByLabelText("Session: 70% left")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: /Claude Sonnet 4\.6/ }));
  await userEvent.click(
    page.getByRole("toolbar", { name: "Providers" }).getByRole("button", { name: "Codex" }),
  );
  await userEvent.click(page.getByRole("option", { name: /GPT-5\.4/ }));
  await expect.element(page.getByRole("heading", { name: "Codex" })).toBeVisible();
  await expect.element(page.getByLabelText("Session: 90% left")).toBeVisible();
  await expect.element(page.getByLabelText("Context: 2k")).toBeVisible();
});
