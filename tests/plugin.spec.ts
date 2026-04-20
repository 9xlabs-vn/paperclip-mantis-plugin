import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("paperclip-mantis-plugin", () => {
  it("registers handlers and exposes registration data", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
      config: {
        mantisBaseUrl: "https://mantis.example.com",
        mantisTokenRef: "secret:test",
      },
    });

    harness.seed({
      companies: [{ id: "co_1" } as never],
      projects: [
        {
          id: "pr_1",
          companyId: "co_1",
          name: "Main",
          archivedAt: null,
        } as never,
      ],
    });

    await plugin.definition.setup(harness.ctx);

    const registration = await harness.getData<{ mantisBaseUrl?: string; projects?: { id: string }[] }>(
      "settings.registration",
      { companyId: "co_1" },
    );

    expect(registration.mantisBaseUrl).toBe("https://mantis.example.com");
    expect(registration.projects?.some((p) => p.id === "pr_1")).toBe(true);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
  });
});
