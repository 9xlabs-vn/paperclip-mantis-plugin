import React, { useMemo, useState } from "react";

import {
  usePluginAction,
  usePluginData,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";

/** Project toolbar — sync Mantis issues for the current Paperclip project only when a mapping exists. */
export interface MantisProjectToolbarButtonProps {
  slot: {
    pluginId: string;
    displayName?: string;
  };
  context: {
    companyId?: string | null;
    companyPrefix?: string | null;
    projectId?: string | null;
    entityId?: string | null;
    entityType?: string | null;
  };
}

interface RegistrationPayload {
  mantisTokenConfigured?: boolean;
  mappings?: Array<{ paperclipProjectId?: string }>;
}

interface RunSyncSummary {
  created: number;
  updated: number;
  skipped: number;
  commentsImported?: number;
  attachmentsImported?: number;
  errors: string[];
}

export function MantisProjectToolbarButton(props: MantisProjectToolbarButtonProps): React.JSX.Element {
  const { context } = props;
  const companyId = useMemo(() => (context.companyId ?? "").trim(), [context.companyId]);
  const projectId = useMemo(
    () => (context.entityType === "project" ? (context.entityId ?? context.projectId ?? "").trim() : ""),
    [context.entityId, context.entityType, context.projectId],
  );

  const registration = usePluginData<RegistrationPayload>(
    "settings.registration",
    companyId ? { companyId } : {},
  );

  const runSync = usePluginAction("settings.runSync");
  const toast = usePluginToast();
  const [syncing, setSyncing] = useState(false);

  const linkedToMantis =
    Boolean(companyId)
    && Boolean(projectId)
    && registration.data?.mantisTokenConfigured === true
    && (registration.data.mappings ?? []).some((m) => (m.paperclipProjectId ?? "").trim() === projectId);

  if (!linkedToMantis) {
    return <></>;
  }

  async function handleSync(): Promise<void> {
    setSyncing(true);
    try {
      const result = (await runSync({
        companyId,
        paperclipProjectId: projectId,
      })) as { summary?: RunSyncSummary; data?: { summary?: RunSyncSummary } };
      const summary =
        result?.summary
        ?? (result && typeof result === "object" && "data" in result
          ? (result as { data?: { summary?: RunSyncSummary } }).data?.summary
          : undefined);

      const errCount = summary?.errors?.length ?? 0;
      const c =
        summary && (summary.commentsImported ?? 0) > 0
          ? `, ${summary.commentsImported} comment(s) from Mantis`
          : "";
      const a =
        summary && (summary.attachmentsImported ?? 0) > 0
          ? `, ${summary.attachmentsImported} file(s) from Mantis`
          : "";
      const body = summary
        ? errCount > 0
          ? `${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped${c}${a}. ${errCount} issue(s) logged errors.`
          : `${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped${c}${a}.`
        : "Sync completed.";

      toast({
        dedupeKey: `mantis-toolbar-sync-${Date.now()}`,
        title: errCount ? "Mantis sync finished with warnings" : "Mantis sync finished",
        body,
        tone: errCount ? "warn" : "success",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Sync failed", body: message, tone: "error" });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <button
      type="button"
      disabled={syncing}
      onClick={() => void handleSync()}
      title="Import or update Mantis issues mapped to this Paperclip project."
      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-background px-3 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
    >
      {syncing ? "Syncing…" : "Sync now"}
    </button>
  );
}
