import type { PluginContext } from "@paperclipai/plugin-sdk";

import {
  mergeMantisPluginConfig,
  MANTIS_SETTINGS_SCOPE,
  MANTIS_SYNC_RUN_SCOPE,
  normalizeMantisPluginConfig,
  normalizePaperclipIssueStatus,
  type MantisConnectorPluginConfig,
  type MantisCompanyAdvancedSync,
  type MantisProjectMapping,
  loadResolvedMantisPluginConfig,
} from "./mantis-config.js";
import {
  listMantisProjects,
  probeMantisProjectAccess,
  validateMantisPlainToken,
  validateMantisToken,
} from "./mantis-http.js";
import { performMantisSync } from "./mantis-sync.js";

function normalizeCompanyId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeSecretRef(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getConfiguredBoardRef(
  resolved: MantisConnectorPluginConfig,
  companyId?: string,
): string | undefined {
  if (!companyId?.trim()) return undefined;
  const refs = resolved.paperclipBoardApiTokenRefs;
  if (!refs) return undefined;
  return normalizeSecretRef(refs[companyId]);
}

function hasBoardAccess(resolved: MantisConnectorPluginConfig, companyId?: string): boolean {
  if (companyId) {
    return Boolean(getConfiguredBoardRef(resolved, companyId));
  }

  const refs = resolved.paperclipBoardApiTokenRefs;
  return Boolean(refs && Object.keys(refs).length > 0);
}

function isArchivedProject(project: { archivedAt?: unknown }): boolean {
  return typeof project.archivedAt === "string" && project.archivedAt.trim().length > 0;
}

async function buildRegistrationPayload(ctx: PluginContext, input: Record<string, unknown>) {
  const requestedCompanyId = normalizeCompanyId(input.companyId);
  const resolved = await loadResolvedMantisPluginConfig(ctx);

  const rawSaved = await ctx.state.get(MANTIS_SETTINGS_SCOPE);
  const updatedAt =
    rawSaved && typeof rawSaved === "object" && typeof (rawSaved as { updatedAt?: unknown }).updatedAt === "string"
      ? (rawSaved as { updatedAt: string }).updatedAt
      : undefined;

  const syncRun = await ctx.state.get(MANTIS_SYNC_RUN_SCOPE);

  const projectsForCompany =
    requestedCompanyId
      ? (await ctx.projects.list({ companyId: requestedCompanyId }))
        .filter((project) => !isArchivedProject(project))
        .map((project) => ({
          id: project.id,
          name: project.name,
        }))
      : [];

  const mappingsForCompany = (resolved.mappings ?? []).filter(
    (m) => m.companyId === requestedCompanyId,
  );

  const advancedForCompany =
    requestedCompanyId ? resolved.companyAdvancedSync?.[requestedCompanyId] : undefined;

  return {
    mantisBaseUrl: resolved.mantisBaseUrl ?? "",
    mantisTokenRef: resolved.mantisTokenRef ?? "",
    mantisApiIdentity: resolved.lastMantisApiIdentity ?? "",
    lastMantisApiUserId: resolved.lastMantisApiUserId,
    mantisTokenConfigured: Boolean(resolved.mantisTokenRef?.trim() && resolved.mantisBaseUrl?.trim()),
    syncIntervalMinutes: resolved.syncIntervalMinutes ?? 15,
    syncOnlyOpenIssues: advancedForCompany?.syncOnlyOpenIssues !== false,
    syncAssigneeFilter: advancedForCompany?.syncAssigneeFilter ?? "any",
    defaultPaperclipStatus: advancedForCompany?.defaultPaperclipStatus,
    defaultAssigneeAgentId: advancedForCompany?.defaultAssigneeAgentId ?? "",
    ignoreReporterNames: advancedForCompany?.ignoreReporterNames ?? "",
    paperclipApiBaseUrl: resolved.paperclipApiBaseUrl ?? "",
    paperclipBoardAccessConfigured: hasBoardAccess(resolved, requestedCompanyId),
    mappings: mappingsForCompany,
    projects: projectsForCompany,
    updatedAt,
    lastSync:
      syncRun && typeof syncRun === "object" && "lastCompletedAt" in syncRun
        ? syncRun
        : null,
  };
}

export function registerMantisSettingsHandlers(ctx: PluginContext): void {
  ctx.data.register("settings.registration", async (input) => {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return buildRegistrationPayload(ctx, record);
  });

  ctx.data.register("sync.status", async () => {
    return (await ctx.state.get(MANTIS_SYNC_RUN_SCOPE)) ?? null;
  });

  ctx.data.register("settings.mantisProjects", async () => {
    const resolved = await loadResolvedMantisPluginConfig(ctx);
    const baseUrl = resolved.mantisBaseUrl ?? "";
    const tokenRef = resolved.mantisTokenRef ?? "";

    if (!baseUrl.trim() || !tokenRef.trim()) {
      return {
        ok: false as const,
        reason: "missing_config" as const,
        projects: [] as Array<{ id: number; name: string }>,
      };
    }

    try {
      const projects = await listMantisProjects(ctx, baseUrl, tokenRef);
      return { ok: true as const, projects };
    } catch (err) {
      const message = err instanceof Error ? err.message.trim() : String(err);
      return {
        ok: false as const,
        reason: "fetch_failed" as const,
        message,
        projects: [] as Array<{ id: number; name: string }>,
      };
    }
  });

  ctx.data.register("settings.tokenPermissionAudit", async (input) => {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const companyId = normalizeCompanyId(record.companyId);
    const resolved = await loadResolvedMantisPluginConfig(ctx);
    const baseUrl = resolved.mantisBaseUrl ?? "";
    const tokenRef = resolved.mantisTokenRef ?? "";

    if (!baseUrl.trim() || !tokenRef.trim()) {
      return {
        status: "missing_token",
        allProjectsReachable: false,
        projects: [] as Array<{
          mantisProjectId: number;
          paperclipProjectId: string;
          paperclipProjectName?: string;
          status: "verified" | "missing_access" | "error";
          message?: string;
        }>,
        warnings: ["Save Mantis base URL and API token secret reference first."],
      };
    }

    const mappings =
      companyId
        ? (resolved.mappings ?? []).filter((m) => m.companyId === companyId && m.mantisProjectId > 0)
        : [];

    if (!companyId || mappings.length === 0) {
      return {
        status: "pending",
        allProjectsReachable: false,
        projects: [],
        warnings: ["Add at least one project mapping for this company to audit access."],
      };
    }

    const projects: Array<{
      mantisProjectId: number;
      mantisProjectName?: string;
      paperclipProjectId: string;
      paperclipProjectName?: string;
      status: "verified" | "missing_access" | "error";
      message?: string;
    }> = [];

    for (const m of mappings) {
      const probe = await probeMantisProjectAccess(ctx, baseUrl, tokenRef, m.mantisProjectId);
      if (probe.ok) {
        projects.push({
          mantisProjectId: m.mantisProjectId,
          mantisProjectName: m.mantisProjectName,
          paperclipProjectId: m.paperclipProjectId,
          paperclipProjectName: m.paperclipProjectName,
          status: "verified",
        });
      } else {
        projects.push({
          mantisProjectId: m.mantisProjectId,
          mantisProjectName: m.mantisProjectName,
          paperclipProjectId: m.paperclipProjectId,
          paperclipProjectName: m.paperclipProjectName,
          status: probe.message.includes("401") || probe.message.includes("403") ? "missing_access" : "error",
          message: probe.message,
        });
      }
    }

    const allProjectsReachable = projects.length > 0 && projects.every((p) => p.status === "verified");

    return {
      status: allProjectsReachable ? "verified" : "error",
      allProjectsReachable,
      projects,
      warnings: [] as string[],
    };
  });

  ctx.actions.register("settings.saveRegistration", async (input) => {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const companyId = normalizeCompanyId(record.companyId);

    const patch: MantisConnectorPluginConfig = {};

    if ("mantisBaseUrl" in record) patch.mantisBaseUrl = typeof record.mantisBaseUrl === "string" ? record.mantisBaseUrl : "";
    if ("mantisTokenRef" in record) patch.mantisTokenRef = typeof record.mantisTokenRef === "string" ? record.mantisTokenRef : "";
    if ("paperclipApiBaseUrl" in record) {
      patch.paperclipApiBaseUrl =
        typeof record.paperclipApiBaseUrl === "string" ? record.paperclipApiBaseUrl : "";
    }
    if ("syncIntervalMinutes" in record) {
      const v = record.syncIntervalMinutes;
      patch.syncIntervalMinutes =
        typeof v === "number"
          ? v
          : typeof v === "string"
            ? Number(v)
            : undefined;
    }

    const prevState = await ctx.state.get(MANTIS_SETTINGS_SCOPE);

    if (
      companyId
      && (
        "syncOnlyOpenIssues" in record
        || "syncAssigneeFilter" in record
        ||         "defaultPaperclipStatus" in record
        || "defaultAssigneeAgentId" in record
        || "ignoreReporterNames" in record
      )
    ) {
      const prevNorm = normalizeMantisPluginConfig(prevState ?? {});
      const prevCo: MantisCompanyAdvancedSync = { ...(prevNorm.companyAdvancedSync?.[companyId] ?? {}) };

      if ("syncOnlyOpenIssues" in record) {
        const v = record.syncOnlyOpenIssues;
        prevCo.syncOnlyOpenIssues =
          typeof v === "boolean"
            ? v
            : v === "true"
              ? true
              : v === "false"
                ? false
                : prevCo.syncOnlyOpenIssues;
      }

      if ("syncAssigneeFilter" in record && typeof record.syncAssigneeFilter === "string") {
        const v = record.syncAssigneeFilter.trim().toLowerCase();
        if (v === "any" || v === "unassigned" || v === "me") {
          prevCo.syncAssigneeFilter = v;
        }
      }

      if ("defaultPaperclipStatus" in record) {
        const raw = record.defaultPaperclipStatus;
        if (raw === "" || raw === null) {
          (prevCo as Record<string, unknown>).defaultPaperclipStatus = null;
        } else {
          const normalized = normalizePaperclipIssueStatus(raw);
          if (normalized) prevCo.defaultPaperclipStatus = normalized;
        }
      }

      if ("ignoreReporterNames" in record && typeof record.ignoreReporterNames === "string") {
        if (record.ignoreReporterNames.trim()) {
          prevCo.ignoreReporterNames = record.ignoreReporterNames;
        } else {
          (prevCo as Record<string, unknown>).ignoreReporterNames = null;
        }
      }

      if ("defaultAssigneeAgentId" in record) {
        const raw = record.defaultAssigneeAgentId;
        if (raw === "" || raw === null || raw === undefined) {
          (prevCo as Record<string, unknown>).defaultAssigneeAgentId = null;
        } else if (typeof raw === "string" && raw.trim()) {
          prevCo.defaultAssigneeAgentId = raw.trim();
        }
      }

      patch.companyAdvancedSync = { [companyId]: prevCo };
    }

    let nextSettings = mergeMantisPluginConfig(prevState ?? {}, patch);

    if (Array.isArray(record.mappings) && companyId) {
      const projects = await ctx.projects.list({ companyId });
      const allowed = new Set(
        projects.filter((project) => !isArchivedProject(project)).map((project) => project.id),
      );

      const prevMappings = nextSettings.mappings ?? [];
      const others = prevMappings.filter((m) => m.companyId !== companyId);

      const incoming: MantisProjectMapping[] = [];
      for (const row of record.mappings) {
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        const paperclipProjectId =
          typeof rec.paperclipProjectId === "string" ? rec.paperclipProjectId.trim() : "";
        const rawMp = rec.mantisProjectId;
        const mantisProjectId =
          typeof rawMp === "number" ? rawMp : typeof rawMp === "string" ? Number(rawMp) : NaN;
        if (!paperclipProjectId || !allowed.has(paperclipProjectId)) continue;
        if (!Number.isFinite(mantisProjectId) || mantisProjectId <= 0) continue;

        const id =
          typeof rec.id === "string" && rec.id.trim()
            ? rec.id.trim()
            : `${companyId}-${paperclipProjectId}-${Math.floor(mantisProjectId)}`;

        const projectMeta = projects.find((p) => p.id === paperclipProjectId);
        const mantisProjectName =
          typeof rec.mantisProjectName === "string" && rec.mantisProjectName.trim()
            ? rec.mantisProjectName.trim()
            : undefined;
        incoming.push({
          id,
          mantisProjectId: Math.floor(mantisProjectId),
          mantisProjectName,
          paperclipProjectId,
          paperclipProjectName: projectMeta?.name,
          companyId,
        });
      }

      nextSettings = mergeMantisPluginConfig(nextSettings, { mappings: [...others, ...incoming] });
    }

    await ctx.state.set(MANTIS_SETTINGS_SCOPE, {
      ...nextSettings,
      updatedAt: new Date().toISOString(),
    });

    return buildRegistrationPayload(ctx, { companyId });
  });

  ctx.actions.register("settings.updateBoardAccess", async (input) => {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const companyId = normalizeCompanyId(record.companyId);
    if (!companyId) {
      throw new Error("A company id is required to update Paperclip board access.");
    }

    const nextSecretRef = normalizeSecretRef(record.paperclipBoardApiTokenRef);
    const prevState = normalizeMantisPluginConfig(await ctx.state.get(MANTIS_SETTINGS_SCOPE));
    const refs = { ...(prevState.paperclipBoardApiTokenRefs ?? {}) };

    if (nextSecretRef) {
      refs[companyId] = nextSecretRef;
    } else {
      delete refs[companyId];
    }

    const nextSettings = mergeMantisPluginConfig(prevState, {
      paperclipBoardApiTokenRefs: refs,
    });

    await ctx.state.set(MANTIS_SETTINGS_SCOPE, {
      ...nextSettings,
      updatedAt: new Date().toISOString(),
    });

    return buildRegistrationPayload(ctx, { companyId });
  });

  ctx.actions.register("settings.validateToken", async (input) => {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const plain = typeof record.token === "string" ? record.token.trim() : "";
    const baseUrl =
      typeof record.mantisBaseUrl === "string" && record.mantisBaseUrl.trim()
        ? record.mantisBaseUrl.trim()
        : (await loadResolvedMantisPluginConfig(ctx)).mantisBaseUrl ?? "";

    if (!plain) {
      throw new Error("Paste a Mantis API token to validate.");
    }

    const result = await validateMantisPlainToken(ctx, baseUrl, plain);
    const identity =
      typeof result.identity === "string" && result.identity.trim() ? result.identity.trim() : "";
    const userId =
      typeof result.userId === "number" && Number.isFinite(result.userId) && result.userId > 0
        ? Math.floor(result.userId)
        : undefined;
    const prevState = normalizeMantisPluginConfig(await ctx.state.get(MANTIS_SETTINGS_SCOPE));
    await ctx.state.set(MANTIS_SETTINGS_SCOPE, {
      ...(identity || userId !== undefined
        ? mergeMantisPluginConfig(prevState, {
            ...(identity ? { lastMantisApiIdentity: identity } : {}),
            ...(userId !== undefined ? { lastMantisApiUserId: userId } : {}),
          })
        : prevState),
      updatedAt: new Date().toISOString(),
    });

    return result;
  });

  ctx.actions.register("settings.validateSavedToken", async () => {
    const resolved = await loadResolvedMantisPluginConfig(ctx);
    const baseUrl = resolved.mantisBaseUrl ?? "";
    const tokenRef = resolved.mantisTokenRef ?? "";
    if (!baseUrl.trim() || !tokenRef.trim()) {
      throw new Error("Save Mantis base URL and token secret reference first.");
    }
    const result = await validateMantisToken(ctx, baseUrl, tokenRef);
    const identity =
      typeof result.identity === "string" && result.identity.trim() ? result.identity.trim() : "";
    const userId =
      typeof result.userId === "number" && Number.isFinite(result.userId) && result.userId > 0
        ? Math.floor(result.userId)
        : undefined;
    const prevState = normalizeMantisPluginConfig(await ctx.state.get(MANTIS_SETTINGS_SCOPE));
    await ctx.state.set(MANTIS_SETTINGS_SCOPE, {
      ...(identity || userId !== undefined
        ? mergeMantisPluginConfig(prevState, {
            ...(identity ? { lastMantisApiIdentity: identity } : {}),
            ...(userId !== undefined ? { lastMantisApiUserId: userId } : {}),
          })
        : prevState),
      updatedAt: new Date().toISOString(),
    });
    return result;
  });

  ctx.actions.register("settings.runSync", async (input) => {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const companyId = normalizeCompanyId(record.companyId);
    const paperclipProjectId =
      typeof record.paperclipProjectId === "string" ? record.paperclipProjectId.trim() : "";
    const resolved = await loadResolvedMantisPluginConfig(ctx);
    const tokenRef = resolved.mantisTokenRef ?? "";
    if (!tokenRef.trim()) {
      throw new Error("Configure mantisTokenRef before running sync.");
    }

    let scope = resolved;
    if (companyId && paperclipProjectId) {
      const narrowed = (resolved.mappings ?? []).filter(
        (m) => m.companyId === companyId && m.paperclipProjectId === paperclipProjectId,
      );
      if (narrowed.length === 0) {
        throw new Error(
          "This Paperclip project is not linked to Mantis. Add a mapping in Mantis Sync settings.",
        );
      }
      scope = { ...resolved, mappings: narrowed };
    } else if (companyId) {
      scope = {
        ...resolved,
        mappings: (resolved.mappings ?? []).filter((m) => !m.companyId || m.companyId === companyId),
      };
    }

    const summary = await performMantisSync(ctx, {
      resolvedConfig: scope,
      tokenRef,
      trigger: "manual",
    });
    return { ok: true as const, summary };
  });
}
