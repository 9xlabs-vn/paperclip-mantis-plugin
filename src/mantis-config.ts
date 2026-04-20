import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";

const PAPERCLIP_ISSUE_STATUSES: readonly Issue["status"][] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];

export type MantisSyncAssigneeFilter = "any" | "unassigned" | "me";

/** Per-company sync rules (settings page is opened in company context). */
export interface MantisCompanyAdvancedSync {
  syncOnlyOpenIssues?: boolean;
  syncAssigneeFilter?: MantisSyncAssigneeFilter;
  defaultPaperclipStatus?: Issue["status"];
  /** Paperclip agent id on create when {@link defaultPaperclipStatus} is unset (auto map from Mantis only). */
  defaultAssigneeAgentId?: string;
  ignoreReporterNames?: string;
}

function normalizeOneCompanyAdvancedSync(
  v: Record<string, unknown>,
): MantisCompanyAdvancedSync {
  const out: MantisCompanyAdvancedSync = {};

  const assigneeRaw = v.syncAssigneeFilter;
  if (assigneeRaw === "any" || assigneeRaw === "unassigned" || assigneeRaw === "me") {
    out.syncAssigneeFilter = assigneeRaw;
  } else if (typeof assigneeRaw === "string") {
    const t = assigneeRaw.trim().toLowerCase();
    if (t === "any" || t === "unassigned" || t === "me") {
      out.syncAssigneeFilter = t as MantisSyncAssigneeFilter;
    }
  }

  const syncOnlyOpenIssuesRaw = v.syncOnlyOpenIssues;
  if (typeof syncOnlyOpenIssuesRaw === "boolean") {
    out.syncOnlyOpenIssues = syncOnlyOpenIssuesRaw;
  } else if (typeof syncOnlyOpenIssuesRaw === "string") {
    const lower = syncOnlyOpenIssuesRaw.trim().toLowerCase();
    if (lower === "true") out.syncOnlyOpenIssues = true;
    if (lower === "false") out.syncOnlyOpenIssues = false;
  }

  const defaultPaperclipStatus =
    v.defaultPaperclipStatus === "" || v.defaultPaperclipStatus === null
      ? undefined
      : normalizePaperclipIssueStatus(v.defaultPaperclipStatus);
  if (defaultPaperclipStatus) out.defaultPaperclipStatus = defaultPaperclipStatus;

  const ignoreReporterNames =
    typeof v.ignoreReporterNames === "string" ? v.ignoreReporterNames.trim() : undefined;
  if (ignoreReporterNames) out.ignoreReporterNames = ignoreReporterNames;

  const agentRaw = v.defaultAssigneeAgentId;
  if (typeof agentRaw === "string" && agentRaw.trim()) {
    out.defaultAssigneeAgentId = agentRaw.trim();
  }

  return out;
}

function normalizeCompanyAdvancedSyncMap(
  raw: unknown,
): Record<string, MantisCompanyAdvancedSync> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, MantisCompanyAdvancedSync> = {};

  for (const [companyId, entry] of Object.entries(src)) {
    if (!companyId.trim()) continue;
    if (!entry || typeof entry !== "object") continue;
    const normalized = normalizeOneCompanyAdvancedSync(entry as Record<string, unknown>);
    if (
      normalized.syncAssigneeFilter !== undefined
      || normalized.syncOnlyOpenIssues !== undefined
      || normalized.defaultPaperclipStatus !== undefined
      || normalized.defaultAssigneeAgentId !== undefined
      || normalized.ignoreReporterNames !== undefined
    ) {
      out[companyId] = normalized;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizePaperclipIssueStatus(raw: unknown): Issue["status"] | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase().replace(/-/g, "_");
  return (PAPERCLIP_ISSUE_STATUSES as readonly string[]).includes(s) ? (s as Issue["status"]) : undefined;
}

function newStableMappingRowId(): string {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `mapping-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export const MANTIS_SETTINGS_SCOPE = {
  scopeKind: "instance" as const,
  stateKey: "paperclip-mantis-plugin-settings-v1",
};

export const MANTIS_REGISTRY_SCOPE = {
  scopeKind: "instance" as const,
  stateKey: "paperclip-mantis-plugin-import-registry-v1",
};

export const MANTIS_SYNC_RUN_SCOPE = {
  scopeKind: "instance" as const,
  stateKey: "paperclip-mantis-plugin-sync-run-v1",
};

/** One Mantis project id mapped to one Paperclip project within a company. */
export interface MantisProjectMapping {
  id: string;
  mantisProjectId: number;
  /** Display name from Mantis when chosen from the project list (optional). */
  mantisProjectName?: string;
  paperclipProjectId: string;
  paperclipProjectName?: string;
  companyId?: string;
}

export interface MantisConnectorPluginConfig {
  mantisBaseUrl?: string;
  mantisTokenRef?: string;
  /** Set when token validation succeeds; shown in settings UI summary. */
  lastMantisApiIdentity?: string;
  /** From `/api/rest/users/me` when available; enables "assigned to me" filtering. */
  lastMantisApiUserId?: number;
  paperclipApiBaseUrl?: string;
  paperclipBoardApiTokenRefs?: Record<string, string>;
  /** Minutes between scheduled sync runs (minimum enforced in worker). */
  syncIntervalMinutes?: number;
  /**
   * Per-company advanced sync options (assignee filter, default status, ignore list).
   * Keys are company ids.
   */
  companyAdvancedSync?: Record<string, MantisCompanyAdvancedSync>;
  mappings?: MantisProjectMapping[];
  updatedAt?: string;
}

export interface MantisImportRecord {
  mantisIssueId: number;
  mantisProjectId: number;
  paperclipIssueId: string;
  paperclipProjectId: string;
  companyId: string;
  createdAt: string;
  /** Last known `updated_at` value from Mantis issue payload for incremental sync gating. */
  lastMantisIssueUpdatedAt?: string;
  /** Mantis note ids already posted as Paperclip comments (dedupe on re-sync). */
  syncedMantisNoteIds?: number[];
  /** Mantis bug attachment ids already imported as Paperclip issue attachments. */
  syncedMantisFileIds?: number[];
}

export interface MantisImportRegistry {
  records: MantisImportRecord[];
}

export function normalizeMantisBaseUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let t = raw.trim().replace(/\/+$/, "");
  if (t.endsWith("/api/rest")) {
    t = t.slice(0, -"/api/rest".length).replace(/\/+$/, "");
  }
  return t;
}

export function normalizeMantisPluginConfig(raw: unknown): MantisConnectorPluginConfig {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const mappingsRaw = o.mappings;
  const mappings: MantisProjectMapping[] = [];
  if (Array.isArray(mappingsRaw)) {
    for (const row of mappingsRaw) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : newStableMappingRowId();
      const mp = typeof r.mantisProjectId === "number" ? r.mantisProjectId : Number(r.mantisProjectId);
      const pp =
        typeof r.paperclipProjectId === "string" && r.paperclipProjectId.trim()
          ? r.paperclipProjectId.trim()
          : "";
      const companyId =
        typeof r.companyId === "string" && r.companyId.trim() ? r.companyId.trim() : undefined;
      const paperclipProjectName =
        typeof r.paperclipProjectName === "string" && r.paperclipProjectName.trim()
          ? r.paperclipProjectName.trim()
          : undefined;
      const mantisProjectName =
        typeof r.mantisProjectName === "string" && r.mantisProjectName.trim()
          ? r.mantisProjectName.trim()
          : undefined;
      if (!Number.isFinite(mp) || mp <= 0 || !pp) continue;
      mappings.push({
        id,
        mantisProjectId: Math.floor(mp),
        mantisProjectName,
        paperclipProjectId: pp,
        paperclipProjectName,
        companyId,
      });
    }
  }

  const paperclipBoardApiTokenRefs = o.paperclipBoardApiTokenRefs;
  const refs: Record<string, string> = {};
  if (paperclipBoardApiTokenRefs && typeof paperclipBoardApiTokenRefs === "object") {
    for (const [k, v] of Object.entries(paperclipBoardApiTokenRefs as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) refs[k] = v.trim();
    }
  }

  const syncIntervalMinutes =
    typeof o.syncIntervalMinutes === "number" && Number.isFinite(o.syncIntervalMinutes)
      ? Math.max(1, Math.floor(o.syncIntervalMinutes))
      : typeof o.syncIntervalMinutes === "string"
        ? Math.max(1, Math.floor(Number(o.syncIntervalMinutes)) || 15)
        : undefined;

  let lastMantisApiUserId: number | undefined;
  const uidRaw = o.lastMantisApiUserId;
  if (typeof uidRaw === "number" && Number.isFinite(uidRaw) && uidRaw > 0) {
    lastMantisApiUserId = Math.floor(uidRaw);
  } else if (typeof uidRaw === "string") {
    const n = Number(uidRaw);
    if (Number.isFinite(n) && n > 0) lastMantisApiUserId = Math.floor(n);
  }

  const companyAdvancedSync = normalizeCompanyAdvancedSyncMap(o.companyAdvancedSync);

  return {
    mantisBaseUrl: typeof o.mantisBaseUrl === "string" ? o.mantisBaseUrl.trim() : undefined,
    mantisTokenRef: typeof o.mantisTokenRef === "string" ? o.mantisTokenRef.trim() : undefined,
    lastMantisApiIdentity:
      typeof o.lastMantisApiIdentity === "string" && o.lastMantisApiIdentity.trim()
        ? o.lastMantisApiIdentity.trim()
        : undefined,
    paperclipApiBaseUrl:
      typeof o.paperclipApiBaseUrl === "string" ? o.paperclipApiBaseUrl.trim() : undefined,
    paperclipBoardApiTokenRefs: Object.keys(refs).length > 0 ? refs : undefined,
    syncIntervalMinutes: syncIntervalMinutes ?? 15,
    ...(companyAdvancedSync ? { companyAdvancedSync } : {}),
    ...(lastMantisApiUserId !== undefined ? { lastMantisApiUserId } : {}),
    mappings: mappings.length > 0 ? mappings : undefined,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : undefined,
  };
}

/** Optional per-company fields where an explicit clear (null / "" / missing after save) must remove a prior stored value. */
const CLEAR_COMPANY_ADVANCED_EMPTY = new Set([
  "defaultPaperclipStatus",
  "defaultAssigneeAgentId",
  "ignoreReporterNames",
]);

function mergeCompanyAdvancedSyncMaps(
  a: Record<string, MantisCompanyAdvancedSync> | undefined,
  b: Record<string, MantisCompanyAdvancedSync> | undefined,
): Record<string, MantisCompanyAdvancedSync> | undefined {
  if (!a && !b) return undefined;
  const ids = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const out: Record<string, MantisCompanyAdvancedSync> = {};
  for (const id of ids) {
    const aRec = { ...((a?.[id] ?? {}) as unknown as Record<string, unknown>) };
    const bRec = (b?.[id] ?? {}) as unknown as Record<string, unknown>;
    const mergedRaw: Record<string, unknown> = { ...aRec };
    for (const [key, val] of Object.entries(bRec)) {
      if (val === null || val === undefined) {
        delete mergedRaw[key];
      } else if (
        typeof val === "string"
        && val === ""
        && CLEAR_COMPANY_ADVANCED_EMPTY.has(key)
      ) {
        delete mergedRaw[key];
      } else {
        mergedRaw[key] = val;
      }
    }
    const mergedEntry = normalizeOneCompanyAdvancedSync(mergedRaw);
    if (
      mergedEntry.syncAssigneeFilter !== undefined
      || mergedEntry.syncOnlyOpenIssues !== undefined
      || mergedEntry.defaultPaperclipStatus !== undefined
      || mergedEntry.defaultAssigneeAgentId !== undefined
      || mergedEntry.ignoreReporterNames !== undefined
    ) {
      out[id] = mergedEntry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mergeMantisPluginConfig(
  prev: unknown,
  patch: MantisConnectorPluginConfig,
): MantisConnectorPluginConfig {
  const a = normalizeMantisPluginConfig(prev);
  const b = patch;
  const merged = normalizeMantisPluginConfig({
    ...a,
    ...b,
    paperclipBoardApiTokenRefs: {
      ...(a.paperclipBoardApiTokenRefs ?? {}),
      ...(b.paperclipBoardApiTokenRefs ?? {}),
    },
    companyAdvancedSync: mergeCompanyAdvancedSyncMaps(a.companyAdvancedSync, b.companyAdvancedSync),
    mappings: b.mappings !== undefined ? b.mappings : a.mappings,
  });
  const identity =
    typeof b.lastMantisApiIdentity === "string"
      ? b.lastMantisApiIdentity.trim() || undefined
      : merged.lastMantisApiIdentity?.trim()
        ? merged.lastMantisApiIdentity.trim()
        : a.lastMantisApiIdentity?.trim()
          ? a.lastMantisApiIdentity.trim()
          : undefined;
  return normalizeMantisPluginConfig({
    ...merged,
    lastMantisApiIdentity: identity,
  });
}

export async function loadResolvedMantisPluginConfig(ctx: PluginContext): Promise<MantisConnectorPluginConfig> {
  const [dbRaw, savedRaw] = await Promise.all([ctx.config.get(), ctx.state.get(MANTIS_SETTINGS_SCOPE)]);
  const db = normalizeMantisPluginConfig(dbRaw);
  const st = normalizeMantisPluginConfig(savedRaw);
  return normalizeMantisPluginConfig({
    ...db,
    ...st,
    paperclipBoardApiTokenRefs: {
      ...(db.paperclipBoardApiTokenRefs ?? {}),
      ...(st.paperclipBoardApiTokenRefs ?? {}),
    },
    companyAdvancedSync: mergeCompanyAdvancedSyncMaps(db.companyAdvancedSync, st.companyAdvancedSync),
    mappings: st.mappings ?? db.mappings,
    lastMantisApiIdentity: st.lastMantisApiIdentity?.trim() || db.lastMantisApiIdentity?.trim() || undefined,
  });
}
