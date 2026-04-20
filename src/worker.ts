import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";

import { loadResolvedMantisPluginConfig, MANTIS_SYNC_RUN_SCOPE } from "./mantis-config.js";
import { registerMantisSettingsHandlers } from "./mantis-settings-handlers.js";
import { performMantisSync } from "./mantis-sync.js";

const MIN_SCHEDULE_GAP_MS = 60_000;

async function runScheduledSyncIfDue(ctx: PluginContext): Promise<void> {
  const resolved = await loadResolvedMantisPluginConfig(ctx);
  const tokenRef = resolved.mantisTokenRef ?? "";
  const baseUrl = resolved.mantisBaseUrl ?? "";
  if (!tokenRef.trim() || !baseUrl.trim()) {
    return;
  }

  const intervalMinutes = resolved.syncIntervalMinutes ?? 15;
  const minGapMs = Math.max(MIN_SCHEDULE_GAP_MS, intervalMinutes * 60 * 1000);

  const raw = await ctx.state.get(MANTIS_SYNC_RUN_SCOPE);
  const lastCompletedAt =
    raw && typeof raw === "object" && typeof (raw as { lastCompletedAt?: unknown }).lastCompletedAt === "string"
      ? Date.parse((raw as { lastCompletedAt: string }).lastCompletedAt)
      : 0;

  if (lastCompletedAt && Number.isFinite(lastCompletedAt) && Date.now() - lastCompletedAt < minGapMs) {
    ctx.logger.debug("Mantis scheduled sync skipped (within sync interval).");
    return;
  }

  await performMantisSync(ctx, {
    resolvedConfig: resolved,
    tokenRef,
    trigger: "schedule",
  });
}

const plugin = definePlugin({
  async setup(ctx) {
    registerMantisSettingsHandlers(ctx);

    ctx.jobs.register("sync.mantis-issues", async () => {
      try {
        await runScheduledSyncIfDue(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.error("Mantis scheduled sync failed", { message });
      }
    });
  },

  async onHealth() {
    return { status: "ok" as const, message: "Mantis Sync worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
