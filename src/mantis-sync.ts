import type { Issue } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";

import {
  MANTIS_REGISTRY_SCOPE,
  MANTIS_SYNC_RUN_SCOPE,
  type MantisConnectorPluginConfig,
  type MantisCompanyAdvancedSync,
  type MantisImportRecord,
  type MantisImportRegistry,
  type MantisProjectMapping,
  normalizeMantisBaseUrl,
  type MantisSyncAssigneeFilter,
} from "./mantis-config.js";
import {
  buildImportDescription,
  fetchMantisIssueFiles,
  fetchMantisIssueNotes,
  formatMantisNotePaperclipBody,
  isMantisIssueClosedLikeStatus,
  isMantisIssueFixedStatus,
  listProjectIssues,
  mapMantisStatusToPaperclip,
  type MantisIssueNormalized,
} from "./mantis-http.js";

const NOTE_FILE_SYNC_CONCURRENCY = 6;

function parseReporterIgnoreSet(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw?.trim()) return set;
  for (const part of raw.split(/[\n,]+/)) {
    const t = part.trim().toLowerCase();
    if (t) set.add(t);
  }
  return set;
}

function reporterMatchesIgnore(reporterLower: string, ignore: Set<string>): boolean {
  if (!ignore.size || !reporterLower) return false;
  for (const token of ignore) {
    if (token.length <= 2) {
      if (reporterLower === token) return true;
    } else if (reporterLower === token || reporterLower.includes(token)) {
      return true;
    }
  }
  return false;
}

/**
 * Paperclip requires a user or agent assignee for `in_progress` (see `server` issues service).
 * Mantis "assigned" / "in progress" often map here; if the company has no default agent, use `todo`
 * so sync does not fail; set a default assignee in Mantis plugin settings to keep in_progress.
 */
function paperclipStatusRequiresAssignee(status: Issue["status"]): boolean {
  return status === "in_progress";
}

/** Exported for tests — maps Mantis-driven status to one Paperclip accepts when `in_progress` needs an assignee. */
export function effectiveStatusForMantisSync(
  adv: MantisCompanyAdvancedSync,
  desired: Issue["status"],
): Issue["status"] {
  if (!paperclipStatusRequiresAssignee(desired)) return desired;
  if (adv.defaultAssigneeAgentId?.trim()) return desired;
  return "todo";
}

function syncAcceptsIssue(
  mi: MantisIssueNormalized,
  adv: MantisCompanyAdvancedSync,
  globalCfg: Pick<MantisConnectorPluginConfig, "lastMantisApiUserId">,
  ignoreReporter: Set<string>,
): boolean {
  if (reporterMatchesIgnore(mi.reporterName.trim().toLowerCase(), ignoreReporter)) {
    return false;
  }

  if (isMantisIssueFixedStatus(mi.statusName)) {
    return false;
  }

  const openOnly = adv.syncOnlyOpenIssues !== false;
  if (openOnly && isMantisIssueClosedLikeStatus(mi.statusName)) {
    return false;
  }

  const mode: MantisSyncAssigneeFilter = adv.syncAssigneeFilter ?? "any";
  if (mode === "any") return true;

  const unassigned = mi.handlerId === null;
  if (mode === "unassigned") return unassigned;

  const mine = globalCfg.lastMantisApiUserId;
  if (mine === undefined || mine <= 0) return false;
  return mi.handlerId === mine;
}

async function loadRegistry(ctx: PluginContext): Promise<MantisImportRegistry> {
  const raw = await ctx.state.get(MANTIS_REGISTRY_SCOPE);
  if (!raw || typeof raw !== "object") return { records: [] };
  const rec = raw as Record<string, unknown>;
  const records = Array.isArray(rec.records) ? rec.records : [];
  const out: MantisImportRecord[] = [];
  for (const row of records) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const mantisIssueId =
      typeof r.mantisIssueId === "number" ? r.mantisIssueId : Number(r.mantisIssueId);
    const mantisProjectId =
      typeof r.mantisProjectId === "number" ? r.mantisProjectId : Number(r.mantisProjectId);
    const paperclipIssueId =
      typeof r.paperclipIssueId === "string" ? r.paperclipIssueId.trim() : "";
    const paperclipProjectId =
      typeof r.paperclipProjectId === "string" ? r.paperclipProjectId.trim() : "";
    const companyId = typeof r.companyId === "string" ? r.companyId.trim() : "";
    const createdAt = typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString();
    const lastMantisIssueUpdatedAt =
      typeof r.lastMantisIssueUpdatedAt === "string" && r.lastMantisIssueUpdatedAt.trim()
        ? r.lastMantisIssueUpdatedAt
        : undefined;
    const syncedMantisNoteIds: number[] = [];
    const rawNotes = r.syncedMantisNoteIds;
    if (Array.isArray(rawNotes)) {
      for (const x of rawNotes) {
        const nid = typeof x === "number" ? x : Number(x);
        if (Number.isFinite(nid)) syncedMantisNoteIds.push(Math.floor(nid));
      }
    }
    const syncedMantisFileIds: number[] = [];
    const rawFiles = r.syncedMantisFileIds;
    if (Array.isArray(rawFiles)) {
      for (const x of rawFiles) {
        const fid = typeof x === "number" ? x : Number(x);
        if (Number.isFinite(fid)) syncedMantisFileIds.push(Math.floor(fid));
      }
    }
    if (!Number.isFinite(mantisIssueId) || !paperclipIssueId || !companyId || !paperclipProjectId) continue;
    out.push({
      mantisIssueId: Math.floor(mantisIssueId),
      mantisProjectId: Number.isFinite(mantisProjectId) ? Math.floor(mantisProjectId) : 0,
      paperclipIssueId,
      paperclipProjectId,
      companyId,
      createdAt,
      ...(lastMantisIssueUpdatedAt ? { lastMantisIssueUpdatedAt } : {}),
      ...(syncedMantisNoteIds.length > 0 ? { syncedMantisNoteIds } : {}),
      ...(syncedMantisFileIds.length > 0 ? { syncedMantisFileIds } : {}),
    });
  }
  return { records: out };
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array(items.length) as R[];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: cap }, async () => {
      for (;;) {
        const idx = cursor;
        cursor += 1;
        if (idx >= items.length) return;
        results[idx] = await worker(items[idx]!, idx);
      }
    }),
  );
  return results;
}

async function saveRegistry(ctx: PluginContext, registry: MantisImportRegistry): Promise<void> {
  await ctx.state.set(MANTIS_REGISTRY_SCOPE, registry);
}

/** Stable key for O(1) registry lookups at large scale (many projects × many issues). */
function recordLookupKey(
  companyId: string,
  paperclipProjectId: string,
  mantisIssueId: number,
): string {
  return `${companyId}\0${paperclipProjectId}\0${mantisIssueId}`;
}

function buildRegistryLookup(registry: MantisImportRegistry): Map<string, MantisImportRecord> {
  const m = new Map<string, MantisImportRecord>();
  for (const r of registry.records) {
    m.set(recordLookupKey(r.companyId, r.paperclipProjectId, r.mantisIssueId), r);
  }
  return m;
}

function upsertRecord(
  registry: MantisImportRegistry,
  lookup: Map<string, MantisImportRecord>,
  rec: MantisImportRecord,
): void {
  const key = recordLookupKey(rec.companyId, rec.paperclipProjectId, rec.mantisIssueId);
  const prev = lookup.get(key);
  if (prev) {
    const idx = registry.records.indexOf(prev);
    if (idx !== -1) registry.records[idx] = rec;
    else registry.records.push(rec);
  } else {
    registry.records.push(rec);
  }
  lookup.set(key, rec);
}

export interface MantisSyncResult {
  created: number;
  updated: number;
  skipped: number;
  /** Mantis issue notes posted as new Paperclip comments on this run. */
  commentsImported: number;
  /** Mantis issue attachment files uploaded to Paperclip on this run. */
  attachmentsImported: number;
  errors: string[];
}

function sortSyncedMantisNoteIds(ids: Set<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

function sortSyncedMantisFileIds(ids: Set<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

async function syncMantisNotesForImportedIssue(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
  rec: MantisImportRecord,
  result: MantisSyncResult,
): Promise<MantisImportRecord> {
  let notes: Awaited<ReturnType<typeof fetchMantisIssueNotes>>;
  try {
    notes = await fetchMantisIssueNotes(ctx, baseUrl, tokenRef, rec.mantisIssueId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`Mantis #${rec.mantisIssueId} notes: ${msg}`);
    ctx.logger.warn("mantis.sync_notes.fetch_failed", {
      paperclipIssueId: rec.paperclipIssueId,
      mantisIssueId: rec.mantisIssueId,
      message: msg.slice(0, 300),
    });
    return rec;
  }

  const synced = new Set(rec.syncedMantisNoteIds ?? []);
  let postedThisRun = 0;

  for (const note of notes) {
    if (synced.has(note.id)) continue;
    if (!note.text.trim()) {
      synced.add(note.id);
      continue;
    }
    const body = formatMantisNotePaperclipBody(note, baseUrl, rec.mantisIssueId);
    try {
      await ctx.issues.createComment(rec.paperclipIssueId, body, rec.companyId);
      synced.add(note.id);
      result.commentsImported += 1;
      postedThisRun += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`Mantis #${rec.mantisIssueId} note ${note.id}: ${msg}`);
      ctx.logger.warn("mantis.sync_notes.create_comment_failed", {
        paperclipIssueId: rec.paperclipIssueId,
        mantisIssueId: rec.mantisIssueId,
        mantisNoteId: note.id,
        message: msg.slice(0, 300),
      });
    }
  }

  ctx.logger.debug("mantis.sync_notes.issue_done", {
    paperclipIssueId: rec.paperclipIssueId,
    mantisIssueId: rec.mantisIssueId,
    fetchedNotes: notes.length,
    postedThisRun,
  });

  const sorted = sortSyncedMantisNoteIds(synced);
  const prev = rec.syncedMantisNoteIds ?? [];
  if (sorted.length === prev.length && sorted.every((v, i) => v === prev[i])) {
    return rec;
  }
  return { ...rec, syncedMantisNoteIds: sorted };
}

async function syncMantisFilesForImportedIssue(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
  rec: MantisImportRecord,
  result: MantisSyncResult,
): Promise<MantisImportRecord> {
  let files: Awaited<ReturnType<typeof fetchMantisIssueFiles>>;
  try {
    files = await fetchMantisIssueFiles(ctx, baseUrl, tokenRef, rec.mantisIssueId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`Mantis #${rec.mantisIssueId} files: ${msg}`);
    ctx.logger.warn("mantis.sync_files.fetch_failed", {
      paperclipIssueId: rec.paperclipIssueId,
      mantisIssueId: rec.mantisIssueId,
      message: msg.slice(0, 300),
    });
    return rec;
  }

  const synced = new Set(rec.syncedMantisFileIds ?? []);
  let uploadedThisRun = 0;
  let skippedAlreadySynced = 0;
  let skippedMissingInlineContent = 0;
  let failedThisRun = 0;

  for (const file of files) {
    if (synced.has(file.id)) {
      skippedAlreadySynced += 1;
      continue;
    }
    const b64 = file.contentBase64;
    if (!b64?.trim()) {
      skippedMissingInlineContent += 1;
      ctx.logger.warn("mantis.sync_files.skip_no_inline_content", {
        mantisIssueId: rec.mantisIssueId,
        mantisFileId: file.id,
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
        hint: "Mantis REST did not include file.content base64; this file cannot be imported by current bridge.",
      });
      continue;
    }

    try {
      await ctx.issues.createAttachment({
        issueId: rec.paperclipIssueId,
        companyId: rec.companyId,
        contentBase64: b64.trim(),
        contentType: file.contentType,
        originalFilename: file.filename,
      });
      synced.add(file.id);
      result.attachmentsImported += 1;
      uploadedThisRun += 1;
    } catch (e) {
      failedThisRun += 1;
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`Mantis #${rec.mantisIssueId} file ${file.id}: ${msg}`);
      ctx.logger.warn("mantis.sync_files.create_attachment_failed", {
        paperclipIssueId: rec.paperclipIssueId,
        mantisIssueId: rec.mantisIssueId,
        mantisFileId: file.id,
        message: msg.slice(0, 300),
      });
    }
  }

  ctx.logger.debug("mantis.sync_files.issue_done", {
    paperclipIssueId: rec.paperclipIssueId,
    mantisIssueId: rec.mantisIssueId,
    fetchedFiles: files.length,
    uploadedThisRun,
    skippedAlreadySynced,
    skippedMissingInlineContent,
    failedThisRun,
  });

  ctx.logger.info("mantis.sync_files.issue_summary", {
    paperclipIssueId: rec.paperclipIssueId,
    mantisIssueId: rec.mantisIssueId,
    fetchedFiles: files.length,
    uploadedThisRun,
    skippedAlreadySynced,
    skippedMissingInlineContent,
    failedThisRun,
  });

  const sorted = sortSyncedMantisFileIds(synced);
  const prev = rec.syncedMantisFileIds ?? [];
  if (sorted.length === prev.length && sorted.every((v, i) => v === prev[i])) {
    return rec;
  }
  return { ...rec, syncedMantisFileIds: sorted };
}

export async function performMantisSync(
  ctx: PluginContext,
  opts: {
    resolvedConfig: MantisConnectorPluginConfig;
    tokenRef: string;
    trigger: "manual" | "schedule";
  },
): Promise<MantisSyncResult> {
  const baseUrl = normalizeMantisBaseUrl(opts.resolvedConfig.mantisBaseUrl ?? "");
  const result: MantisSyncResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    commentsImported: 0,
    attachmentsImported: 0,
    errors: [],
  };

  if (!baseUrl || !opts.tokenRef) {
    result.errors.push("Missing Mantis base URL or token secret.");
    return result;
  }

  const mappings = opts.resolvedConfig.mappings ?? [];
  const filtered = mappings.filter((m) => m.companyId && m.paperclipProjectId && m.mantisProjectId > 0);
  if (filtered.length === 0) {
    ctx.logger.info("Mantis sync: no project mappings configured.");
    return result;
  }

  const companiesUsingMeFilter = new Set<string>();
  for (const m of filtered) {
    const cid = m.companyId ?? "";
    const adv = opts.resolvedConfig.companyAdvancedSync?.[cid];
    if ((adv?.syncAssigneeFilter ?? "any") === "me") companiesUsingMeFilter.add(cid);
  }
  if (
    companiesUsingMeFilter.size > 0
    && (!opts.resolvedConfig.lastMantisApiUserId || opts.resolvedConfig.lastMantisApiUserId <= 0)
  ) {
    result.errors.push(
      'Assignee filter "Assigned to me" is enabled for at least one company but Mantis user id is unknown. Validate the API token once (GET /api/rest/users/me) so Paperclip can record your user id.',
    );
  }

  const registry = await loadRegistry(ctx);
  const registryLookup = buildRegistryLookup(registry);

  for (const mapping of filtered) {
    const companyId = mapping.companyId!;
    const adv: MantisCompanyAdvancedSync = opts.resolvedConfig.companyAdvancedSync?.[companyId] ?? {};
    const ignoreReporter = parseReporterIgnoreSet(adv.ignoreReporterNames);

    try {
      const issues = await listProjectIssues(ctx, baseUrl, opts.tokenRef, mapping.mantisProjectId);

      for (const mi of issues) {
        try {
          if (!syncAcceptsIssue(mi, adv, opts.resolvedConfig, ignoreReporter)) {
            result.skipped += 1;
            continue;
          }

          const paperclipStatus = mapMantisStatusToPaperclip(mi.statusName);
          const body = buildImportDescription(baseUrl, mi.id, mi.descriptionText);
          const rawCreatedStatus: Issue["status"] = adv.defaultPaperclipStatus ?? paperclipStatus;
          const createdIssueStatus = effectiveStatusForMantisSync(adv, rawCreatedStatus);

          const lookupKey = recordLookupKey(companyId, mapping.paperclipProjectId, mi.id);
          const existing = registryLookup.get(lookupKey);

          if (existing) {
            const current = await ctx.issues.get(existing.paperclipIssueId, companyId);
            if (!current) {
              registry.records = registry.records.filter((r) => r.paperclipIssueId !== existing.paperclipIssueId);
              registryLookup.delete(
                recordLookupKey(existing.companyId, existing.paperclipProjectId, existing.mantisIssueId),
              );
              result.skipped += 1;
              continue;
            }

            const targetStatus = effectiveStatusForMantisSync(
              adv,
              adv.defaultPaperclipStatus ?? paperclipStatus,
            );
            const titleChanged = current.title !== mi.summary;
            const descChanged = (current.description ?? "").trim() !== body.trim();
            const statusChanged = current.status !== targetStatus;
            const defaultAgentId = adv.defaultAssigneeAgentId?.trim();
            const needAssigneePatch =
              targetStatus === "in_progress"
              && Boolean(defaultAgentId)
              && !current.assigneeAgentId
              && !current.assigneeUserId;

            if (titleChanged || descChanged || statusChanged || needAssigneePatch) {
              await ctx.issues.update(
                existing.paperclipIssueId,
                {
                  ...(titleChanged ? { title: mi.summary } : {}),
                  ...(descChanged ? { description: body } : {}),
                  ...(statusChanged ? { status: targetStatus } : {}),
                  ...(needAssigneePatch ? { assigneeAgentId: defaultAgentId } : {}),
                },
                companyId,
              );
              result.updated += 1;
            } else {
              result.skipped += 1;
            }

            upsertRecord(registry, registryLookup, {
              ...existing,
              mantisProjectId: mapping.mantisProjectId,
              paperclipProjectId: mapping.paperclipProjectId,
              companyId,
            });
          } else {
            const useAutoMappedStatus = adv.defaultPaperclipStatus === undefined;
            const defaultAgentId = adv.defaultAssigneeAgentId?.trim();
            const assignPcAgent =
              defaultAgentId && (useAutoMappedStatus || createdIssueStatus === "in_progress")
                ? defaultAgentId
                : undefined;
            const created = await ctx.issues.create({
              companyId,
              projectId: mapping.paperclipProjectId,
              title: mi.summary,
              description: body,
              priority: "medium",
              ...(assignPcAgent ? { assigneeAgentId: assignPcAgent } : {}),
            });

            await ctx.issues.update(created.id, { status: createdIssueStatus }, companyId);

            upsertRecord(registry, registryLookup, {
              mantisIssueId: mi.id,
              mantisProjectId: mapping.mantisProjectId,
              paperclipIssueId: created.id,
              paperclipProjectId: mapping.paperclipProjectId,
              companyId,
              createdAt: new Date().toISOString(),
            });
            result.created += 1;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push(`Mantis #${mi.id}: ${msg}`);
          ctx.logger.warn("Mantis sync issue failed", { mantisIssueId: mi.id, message: msg });
        }
      }

      /** Pull Mantis notes/files for all bindings in this mapping, skipping records with unchanged issue `updated_at` when available. */
      const issueById = new Map<number, MantisIssueNormalized>();
      for (const mi of issues) issueById.set(mi.id, mi);
      const targetRecords = registry.records.filter(
        (rec) => rec.companyId === companyId && rec.paperclipProjectId === mapping.paperclipProjectId,
      );
      const syncedRecords = await runWithConcurrency(
        targetRecords,
        NOTE_FILE_SYNC_CONCURRENCY,
        async (rec) => {
          const sourceIssue = issueById.get(rec.mantisIssueId);
          const sourceUpdatedAt = sourceIssue?.lastUpdated;
          const hasSyncedContent =
            (rec.syncedMantisNoteIds?.length ?? 0) > 0
            || (rec.syncedMantisFileIds?.length ?? 0) > 0;
          if (sourceUpdatedAt && hasSyncedContent && rec.lastMantisIssueUpdatedAt === sourceUpdatedAt) {
            return rec;
          }
          let withNotes = await syncMantisNotesForImportedIssue(
            ctx,
            baseUrl,
            opts.tokenRef,
            rec,
            result,
          );
          withNotes = await syncMantisFilesForImportedIssue(ctx, baseUrl, opts.tokenRef, withNotes, result);
          return {
            ...withNotes,
            ...(sourceUpdatedAt ? { lastMantisIssueUpdatedAt: sourceUpdatedAt } : {}),
          };
        },
      );
      for (const rec of syncedRecords) {
        upsertRecord(registry, registryLookup, rec);
      }

      await saveRegistry(ctx, registry);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`Project ${mapping.mantisProjectId}: ${msg}`);
      ctx.logger.warn("Mantis sync mapping failed", { mantisProjectId: mapping.mantisProjectId, message: msg });
    }
  }

  await ctx.state.set(MANTIS_SYNC_RUN_SCOPE, {
    lastCompletedAt: new Date().toISOString(),
    lastTrigger: opts.trigger,
    summary: result,
  });

  ctx.logger.info("mantis.sync.summary", {
    trigger: opts.trigger,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    commentsImported: result.commentsImported,
    attachmentsImported: result.attachmentsImported,
    errors: result.errors.length,
  });

  return result;
}
