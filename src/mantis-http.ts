import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";

/** HTML comment marker so imports stay discoverable without registry (repair path). */
export const MANTIS_MARKER_PREFIX = "<!-- paperclip-mantis-plugin-imported-from: ";
export const MANTIS_MARKER_SUFFIX = " -->";

export function normalizeMantisBaseUrl(raw: string): string {
  let t = raw.trim().replace(/\/+$/, "");
  // Common mistake: pasting the REST root — we always append `/api/rest/...` ourselves.
  if (t.endsWith("/api/rest")) {
    t = t.slice(0, -"/api/rest".length).replace(/\/+$/, "");
  }
  return t;
}

export function buildMantisIssueViewUrl(baseUrl: string, mantisIssueId: number): string {
  const base = normalizeMantisBaseUrl(baseUrl);
  return `${base}/view.php?id=${mantisIssueId}`;
}

export function buildImportDescription(
  baseUrl: string,
  mantisIssueId: number,
  mantisTitle: string,
  body: string,
): string {
  const url = buildMantisIssueViewUrl(baseUrl, mantisIssueId);
  const marker = `${MANTIS_MARKER_PREFIX}${url}${MANTIS_MARKER_SUFFIX}`;
  const trimmed = body.trim();
  const title = mantisTitle.trim();
  const metadataLines = [
    "- Mantis ID: " + String(mantisIssueId),
    "- Mantis URL: " + url,
    "- Mantis Title: " + title,
  ];
  if (!trimmed) return `${metadataLines.join("\n")}\n\n${marker}`;
  return `${metadataLines.join("\n")}\n\n${trimmed}\n\n${marker}`;
}

export function extractIssuesArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && "issues" in data) {
    const issues = (data as { issues?: unknown }).issues;
    if (Array.isArray(issues)) return issues;
  }
  return [];
}

export function extractProjectsArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && "projects" in data) {
    const projects = (data as { projects?: unknown }).projects;
    if (Array.isArray(projects)) return projects;
  }
  return [];
}

export interface MantisProjectSummary {
  id: number;
  name: string;
}

export function normalizeMantisProjectSummary(raw: unknown): MantisProjectSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const idRaw = o.id;
  const id =
    typeof idRaw === "number"
      ? idRaw
      : typeof idRaw === "string"
        ? Number(idRaw)
        : NaN;
  if (!Number.isFinite(id) || id <= 0) return null;
  const name =
    typeof o.name === "string" && o.name.trim()
      ? o.name.trim()
      : typeof o.project === "object" && o.project !== null
        ? String((o.project as Record<string, unknown>).name ?? "").trim()
        : "";
  return {
    id: Math.floor(id),
    name: name || `Project #${Math.floor(id)}`,
  };
}

/**
 * Paginated listing of Mantis projects visible to the API token (REST).
 */
export async function listMantisProjects(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
): Promise<MantisProjectSummary[]> {
  const base = normalizeMantisBaseUrl(baseUrl);
  if (!base) return [];

  const out: MantisProjectSummary[] = [];
  const seen = new Set<number>();
  let page = 1;

  for (;;) {
    const path = `/api/rest/projects?page=${encodeURIComponent(String(page))}&page_size=100`;
    const data = await mantisApiJson<unknown>(ctx, baseUrl, tokenRef, "GET", path);
    const rows = extractProjectsArray(data);
    if (rows.length === 0) break;

    for (const row of rows) {
      const n = normalizeMantisProjectSummary(row);
      if (n && !seen.has(n.id)) {
        seen.add(n.id);
        out.push(n);
      }
    }

    if (rows.length < 100) break;
    page += 1;
    if (page > 100) {
      ctx.logger.warn("Mantis project list pagination stopped at page 100 (safety cap).");
      break;
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

export interface MantisIssueNormalized {
  id: number;
  summary: string;
  descriptionText: string;
  statusName: string;
  lastUpdated?: string;
  /** Mantis handler (assignee) id, or null when unassigned. */
  handlerId: number | null;
  /** Reporter display name / login for filtering (best-effort from REST). */
  reporterName: string;
}

/** One Mantis issue note (comment) from `GET /api/rest/issues/{id}`. */
export interface MantisIssueNoteNormalized {
  id: number;
  text: string;
  reporterLabel: string;
  createdAt: string;
}

/** One attachment row from `GET /api/rest/issues/{id}/files` (Mantis embeds base64 content when available). */
export interface MantisIssueFileNormalized {
  id: number;
  filename: string;
  contentType: string;
  size: number;
  /** Inline base64 from Mantis when the file exists and was returned in JSON. */
  contentBase64?: string;
}

function sanitizeMantisText(value: string, maxLen = 255): string {
  const normalized = Buffer.from(value, "utf8").toString("utf8");
  const cleaned = normalized.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!cleaned) return "";
  return maxLen > 0 && cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

export function mapMantisStatusToPaperclip(statusName: string): Issue["status"] {
  const s = statusName.toLowerCase();
  if (s.includes("closed") || s.includes("resolved")) return "done";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("block")) return "blocked";
  if (s.includes("feedback") || s.includes("review")) return "in_review";
  if (s.includes("progress") || s.includes("assigned")) return "in_progress";
  // Keep pre-triage/opening Mantis states in backlog to avoid churn to todo.
  if (s.includes("new") || s.includes("acknowledg") || s.includes("confirm")) return "backlog";
  return "todo";
}

/** True when Mantis workflow is treated as closed for "open only" sync filters. */
export function isMantisIssueClosedLikeStatus(statusName: string): boolean {
  const mapped = mapMantisStatusToPaperclip(statusName);
  return mapped === "done" || mapped === "cancelled";
}

/** Mantis "fixed" is pre-closed in many workflows; never import or update from this status. */
export function isMantisIssueFixedStatus(statusName: string): boolean {
  return /\bfixed\b/i.test(statusName.trim());
}

function readNestedString(obj: unknown, keys: string[]): string {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : "";
}

function readNestedNumericId(obj: unknown, keys: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === "number" && Number.isFinite(cur)) return Math.floor(cur);
  if (typeof cur === "string") {
    const n = Number(cur);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return undefined;
}

function extractDescriptionText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  const o = raw as Record<string, unknown>;
  if (typeof o.content === "string") return o.content;
  if (typeof o.raw === "string") return o.raw;
  return "";
}

export function normalizeMantisIssue(raw: unknown): MantisIssueNormalized | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id =
    typeof o.id === "number"
      ? o.id
      : typeof o.id === "string"
        ? Number(o.id)
        : NaN;
  if (!Number.isFinite(id) || id <= 0) return null;

  const summary =
    typeof o.summary === "string"
      ? o.summary
      : typeof o.summary === "object"
        ? readNestedString(o.summary, [])
        : "";

  const descriptionText = sanitizeMantisText(extractDescriptionText(o.description), 0);

  const statusRaw =
    readNestedString(o.status, ["name"])
    || readNestedString(o.status, ["label"])
    || (typeof o.status === "string" ? o.status : "")
    || "unknown";
  const statusName = statusRaw.trim().toLowerCase();

  const handlerRaw = readNestedNumericId(o, ["handler", "id"]);
  const handlerId =
    handlerRaw === undefined || handlerRaw <= 0
      ? null
      : Math.floor(handlerRaw);

  const reporterName =
    readNestedString(o, ["reporter", "name"])
    || readNestedString(o, ["reporter", "username"])
    || readNestedString(o, ["reporter", "login"])
    || "";

  const lastUpdated =
    typeof o.updated_at === "string"
      ? o.updated_at
      : typeof o.last_updated === "string"
        ? o.last_updated
        : typeof o.timestamp === "string"
          ? o.timestamp
          : undefined;

  return {
    id: Math.floor(id),
    summary: sanitizeMantisText(summary, 500) || `Mantis #${id}`,
    descriptionText,
    statusName,
    handlerId,
    reporterName: sanitizeMantisText(reporterName, 120),
    lastUpdated,
  };
}

/** Exported for tests — unwraps issue object from various Mantis REST envelopes. */
export function extractFirstIssueFromIssuesGetResponse(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const idRaw = o.id;
  if (typeof idRaw === "number" || typeof idRaw === "string") {
    return o;
  }
  for (const key of ["issues", "bugs"] as const) {
    const arr = o[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0];
      if (first && typeof first === "object") return first as Record<string, unknown>;
    }
  }
  if (o.issue && typeof o.issue === "object") {
    return o.issue as Record<string, unknown>;
  }
  const dataField = o.data;
  if (dataField && typeof dataField === "object") {
    return extractFirstIssueFromIssuesGetResponse(dataField);
  }
  return null;
}

function normalizeOneMantisNote(raw: unknown): MantisIssueNoteNormalized | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const idRaw = o.id ?? o.bugnote_id ?? o.note_id;
  const id =
    typeof idRaw === "number" ? idRaw : typeof idRaw === "string" ? Number(idRaw) : NaN;
  if (!Number.isFinite(id) || id <= 0) return null;

  let text = "";
  if (typeof o.text === "string") {
    text = o.text;
  } else if (typeof o.body === "string") {
    text = o.body;
  } else if (typeof o.note === "string") {
    text = o.note;
  } else if (o.text && typeof o.text === "object") {
    text = extractDescriptionText(o.text);
  }

  const reporterLabel =
    readNestedString(o, ["reporter", "name"])
    || readNestedString(o, ["reporter", "real_name"])
    || readNestedString(o, ["reporter", "username"])
    || readNestedString(o, ["user", "name"])
    || readNestedString(o, ["user", "real_name"])
    || readNestedString(o, ["author", "name"])
    || "unknown";

  const createdAt =
    typeof o.created_at === "string"
      ? o.created_at
      : typeof o.date_submitted === "string"
        ? o.date_submitted
        : typeof o.updated_at === "string"
          ? o.updated_at
          : "";

  return {
    id: Math.floor(id),
    text: sanitizeMantisText(text, 0),
    reporterLabel: sanitizeMantisText(reporterLabel, 120) || "unknown",
    createdAt,
  };
}

function collectIssueNoteRows(issue: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  for (const key of ["notes", "bugnotes", "issue_notes"] as const) {
    const v = issue[key];
    if (Array.isArray(v)) out.push(...v);
  }
  return out;
}

function countEmbeddedNoteRows(issue: Record<string, unknown>): number {
  return collectIssueNoteRows(issue).length;
}

/** Parses notes from a single-issue REST payload (`GET /api/rest/issues/{id}`). Mantis uses `notes` and/or `bugnotes`. Exported for tests. */
export function normalizeMantisNotesFromIssuePayload(issue: Record<string, unknown>): MantisIssueNoteNormalized[] {
  const byId = new Map<number, MantisIssueNoteNormalized>();
  for (const row of collectIssueNoteRows(issue)) {
    const n = normalizeOneMantisNote(row);
    if (n) byId.set(n.id, n);
  }
  const out = [...byId.values()];
  out.sort((a, b) => {
    const ac = a.createdAt || "";
    const bc = b.createdAt || "";
    if (ac !== bc) return ac.localeCompare(bc);
    return a.id - b.id;
  });
  return out;
}

function extractNotesRowsFromStandaloneEndpoint(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const o = data as Record<string, unknown>;
  for (const key of ["notes", "bugnotes", "issue_notes", "issues"]) {
    const v = o[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

async function fetchMantisIssueNotesSubresource(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
  mantisIssueId: number,
): Promise<MantisIssueNoteNormalized[]> {
  const idStr = encodeURIComponent(String(mantisIssueId));
  try {
    const data = await mantisApiJson<unknown>(
      ctx,
      baseUrl,
      tokenRef,
      "GET",
      `/api/rest/issues/${idStr}/notes`,
    );
    const rows = extractNotesRowsFromStandaloneEndpoint(data);
    const byId = new Map<number, MantisIssueNoteNormalized>();
    for (const row of rows) {
      const n = normalizeOneMantisNote(row);
      if (n) byId.set(n.id, n);
    }
    const out = [...byId.values()];
    out.sort((a, b) => {
      const ac = a.createdAt || "";
      const bc = b.createdAt || "";
      if (ac !== bc) return ac.localeCompare(bc);
      return a.id - b.id;
    });
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.logger.debug("mantis.fetch_notes.subresource_failed", {
      mantisIssueId,
      path: `/api/rest/issues/${idStr}/notes`,
      message: msg.slice(0, 200),
    });
    return [];
  }
}

export async function fetchMantisIssueNotes(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
  mantisIssueId: number,
): Promise<MantisIssueNoteNormalized[]> {
  const idStr = encodeURIComponent(String(mantisIssueId));

  let data: unknown;
  try {
    data = await mantisApiJson<unknown>(ctx, baseUrl, tokenRef, "GET", `/api/rest/issues/${idStr}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b404\b/i.test(msg)) {
      data = await mantisApiJson<unknown>(ctx, baseUrl, tokenRef, "GET", `/api/rest/issues?id=${idStr}`);
    } else {
      throw e;
    }
  }

  let issue = extractFirstIssueFromIssuesGetResponse(data);
  if (!issue) {
    try {
      const alt = await mantisApiJson<unknown>(ctx, baseUrl, tokenRef, "GET", `/api/rest/issues?id=${idStr}`);
      issue = extractFirstIssueFromIssuesGetResponse(alt);
    } catch {
      /* fall through */
    }
  }

  let notes = issue ? normalizeMantisNotesFromIssuePayload(issue) : [];
  let filledViaSubresource = false;

  if (notes.length === 0) {
    const sub = await fetchMantisIssueNotesSubresource(ctx, baseUrl, tokenRef, mantisIssueId);
    if (sub.length > 0) {
      notes = sub;
      filledViaSubresource = true;
    }
  }

  ctx.logger.debug("mantis.fetch_notes.summary", {
    mantisIssueId,
    normalizedNoteCount: notes.length,
    parsedIssueEnvelope: Boolean(issue),
    embeddedRawRows: issue ? countEmbeddedNoteRows(issue) : 0,
    filledViaSubresource,
  });

  if (!issue) {
    ctx.logger.warn("mantis.fetch_notes.no_issue_envelope", {
      mantisIssueId,
      hint: "GET /api/rest/issues returned JSON we could not unwrap (expected id, issues[], bugs[], or data.*).",
    });
  } else if (notes.length === 0 && countEmbeddedNoteRows(issue) > 0) {
    ctx.logger.warn("mantis.fetch_notes.rows_dropped_by_parser", {
      mantisIssueId,
      embeddedRawRows: countEmbeddedNoteRows(issue),
      hint: "Bugnote rows exist but normalized to zero — check id/text/reporter shape.",
    });
  }

  return notes;
}

function normalizeOneMantisFile(raw: unknown): MantisIssueFileNormalized | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const idRaw = o.id ?? o.file_id;
  const id =
    typeof idRaw === "number" ? idRaw : typeof idRaw === "string" ? Number(idRaw) : NaN;
  if (!Number.isFinite(id) || id <= 0) return null;

  const filename =
    typeof o.filename === "string" && o.filename.trim()
      ? sanitizeMantisText(o.filename, 255)
      : typeof o.display_name === "string" && o.display_name.trim()
        ? sanitizeMantisText(o.display_name, 255)
        : `mantis-file-${Math.floor(id)}`;

  const sizeRaw = o.size ?? o.filesize ?? o.byte_size;
  const size =
    typeof sizeRaw === "number"
      ? sizeRaw
      : typeof sizeRaw === "string"
        ? Number(sizeRaw)
        : 0;

  const contentType =
    typeof o.content_type === "string" && o.content_type.trim()
      ? o.content_type.trim()
      : "application/octet-stream";

  const contentBase64 =
    typeof o.content === "string" && o.content.length > 0 ? o.content : undefined;

  return {
    id: Math.floor(id),
    filename,
    contentType,
    size: Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0,
    ...(contentBase64 !== undefined ? { contentBase64 } : {}),
  };
}

/** Lists issue attachments via Mantis REST; each entry may include base64 `content` when the server embeds it. */
export async function fetchMantisIssueFiles(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
  mantisIssueId: number,
): Promise<MantisIssueFileNormalized[]> {
  const idStr = encodeURIComponent(String(mantisIssueId));
  try {
    const data = await mantisApiJson<unknown>(
      ctx,
      baseUrl,
      tokenRef,
      "GET",
      `/api/rest/issues/${idStr}/files`,
    );
    let rows: unknown[] = [];
    if (Array.isArray(data)) {
      rows = data;
    } else if (data && typeof data === "object" && "files" in data) {
      const f = (data as { files?: unknown }).files;
      if (Array.isArray(f)) rows = f;
    }
    const byId = new Map<number, MantisIssueFileNormalized>();
    for (const row of rows) {
      const n = normalizeOneMantisFile(row);
      if (n) byId.set(n.id, n);
    }
    const out = [...byId.values()];
    out.sort((a, b) => a.id - b.id);
    const withInlineContent = out.filter((file) => Boolean(file.contentBase64?.trim())).length;
    ctx.logger.info("mantis.fetch_files.summary", {
      mantisIssueId,
      normalizedFileCount: out.length,
      withInlineContent,
      withoutInlineContent: out.length - withInlineContent,
    });
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.logger.warn("mantis.fetch_files.failed", {
      mantisIssueId,
      message: msg.slice(0, 200),
    });
    return [];
  }
}

export function formatMantisNotePaperclipBody(
  note: MantisIssueNoteNormalized,
  baseUrl: string,
  mantisIssueId: number,
): string {
  const when = note.createdAt ? ` · ${note.createdAt}` : "";
  const header = `**Mantis** note #${note.id} · _${note.reporterLabel}_${when}`;
  const body = note.text.trim();
  if (!body) {
    return `${header}\n\n_(empty)_`;
  }
  return `${header}\n\n${body}`;
}

async function resolveToken(ctx: PluginContext, tokenRef: string): Promise<string> {
  const resolved = await ctx.secrets.resolve(tokenRef);
  return typeof resolved === "string" ? resolved.trim() : "";
}

export async function mantisApiFetch(
  ctx: PluginContext,
  baseUrl: string,
  token: string,
  method: "GET" | "POST" | "PATCH",
  pathWithLeadingSlash: string,
  init?: RequestInit,
): Promise<Response> {
  const base = normalizeMantisBaseUrl(baseUrl);
  if (!base) throw new Error("Mantis base URL is not configured.");

  const url = `${base}${pathWithLeadingSlash.startsWith("/") ? pathWithLeadingSlash : `/${pathWithLeadingSlash}`}`;
  const extra =
    init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
      ? (init.headers as Record<string, string>)
      : {};
  const { headers: _h, method: _m, ...rest } = init ?? {};
  return ctx.http.fetch(url, {
    ...rest,
    method,
    headers: {
      Authorization: token.trim(),
      Accept: "application/json",
      ...extra,
    },
  });
}

export async function mantisApiJson<T>(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await resolveToken(ctx, tokenRef);
  if (!token) throw new Error("Could not resolve Mantis API token.");

  const response = await mantisApiFetch(ctx, baseUrl, token, method, path, init);
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const snippet = typeof parsed === "string" ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200);
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Mantis rejected this token (401/403)."
        : `Mantis HTTP ${response.status}: ${snippet}`,
    );
  }

  return parsed as T;
}

export async function updateMantisIssueStatusToFixed(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
  mantisIssueId: number,
): Promise<void> {
  const idStr = encodeURIComponent(String(mantisIssueId));
  const path = `/api/rest/issues/${idStr}`;
  await mantisApiJson<unknown>(ctx, baseUrl, tokenRef, "PATCH", path, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: { name: "fixed" },
    }),
  });
}

/** Best-effort label from `/api/rest/users/me` for validation UI (name + email when both exist). */
export function extractMantisUserDisplayLabel(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const o = data as Record<string, unknown>;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : "";
  const email = typeof o.email === "string" && o.email.trim() ? o.email.trim() : "";
  if (name && email) return `${name} (${email})`;
  return name || email || undefined;
}

/** Identity + numeric user id from `/api/rest/users/me` (used for "assigned to me" sync filter). */
export function extractMantisUserAccount(data: unknown): { identity?: string; userId?: number } {
  if (!data || typeof data !== "object") return {};
  const o = data as Record<string, unknown>;
  const idRaw = o.id;
  let userId: number | undefined;
  if (typeof idRaw === "number" && Number.isFinite(idRaw)) {
    userId = Math.floor(idRaw);
  } else if (typeof idRaw === "string") {
    const n = Number(idRaw);
    if (Number.isFinite(n) && n > 0) userId = Math.floor(n);
  }
  const identity = extractMantisUserDisplayLabel(data);
  return {
    ...(identity ? { identity } : {}),
    ...(userId !== undefined && userId > 0 ? { userId } : {}),
  };
}

async function tryMantisJsonGet(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
  pathWithQuery: string,
): Promise<unknown> {
  return mantisApiJson<unknown>(ctx, baseUrl, tokenRef, "GET", pathWithQuery);
}

/**
 * Smoke-test API token against Mantis REST.
 *
 * Prefer `GET /api/rest/users/me` (auth-specific, one round-trip). Fall back to
 * `GET /api/rest/projects?...` for older deployments where `users/me` is missing.
 */
export async function validateMantisToken(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
): Promise<{ ok: true; identity?: string; userId?: number }> {
  try {
    const data = await tryMantisJsonGet(ctx, baseUrl, tokenRef, "/api/rest/users/me");
    const account = extractMantisUserAccount(data);
    return {
      ok: true,
      ...(account.identity ? { identity: account.identity } : {}),
      ...(account.userId !== undefined ? { userId: account.userId } : {}),
    };
  } catch (first) {
    const msg = first instanceof Error ? first.message : String(first);
    const looksLikeMissingRoute =
      /\b404\b/.test(msg) || /not\s*found/i.test(msg) || /HTTP 404/i.test(msg);
    if (!looksLikeMissingRoute) {
      throw first;
    }
  }

  await tryMantisJsonGet(ctx, baseUrl, tokenRef, "/api/rest/projects?page=1&page_size=1");
  return { ok: true };
}

/** Validate before saving token to secrets — uses API token string inline (same header as PAT). */
export async function validateMantisPlainToken(
  ctx: PluginContext,
  baseUrl: string,
  plainToken: string,
): Promise<{ ok: true; identity?: string; userId?: number }> {
  const base = normalizeMantisBaseUrl(baseUrl);
  if (!base) throw new Error("Mantis base URL is required.");
  const token = plainToken.trim();
  if (!token) throw new Error("Enter a Mantis API token.");

  let response = await ctx.http.fetch(`${base}/api/rest/users/me`, {
    headers: {
      Authorization: token,
      Accept: "application/json",
    },
  });

  if (!response.ok && response.status === 404) {
    response = await ctx.http.fetch(`${base}/api/rest/projects?page=1&page_size=1`, {
      headers: {
        Authorization: token,
        Accept: "application/json",
      },
    });
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Mantis rejected this token."
        : `Mantis returned HTTP ${response.status}: ${text.slice(0, 160)}`,
    );
  }

  const text = await response.text();
  let identity: string | undefined;
  let userId: number | undefined;
  try {
    if (text.trim()) {
      const parsed = JSON.parse(text) as unknown;
      const account = extractMantisUserAccount(parsed);
      identity = account.identity;
      userId = account.userId;
    }
  } catch {
    identity = undefined;
    userId = undefined;
  }

  return {
    ok: true,
    ...(identity ? { identity } : {}),
    ...(userId !== undefined ? { userId } : {}),
  };
}

/** Verify the token can list issues for a mapped Mantis project (permission / existence check). */
export async function probeMantisProjectAccess(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
  mantisProjectId: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await mantisApiJson<unknown>(
      ctx,
      baseUrl,
      tokenRef,
      "GET",
      `/api/rest/issues?project_id=${encodeURIComponent(String(mantisProjectId))}&page_size=1&page=1`,
    );
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error && e.message.trim() ? e.message.trim() : "Unknown error.";
    return { ok: false, message };
  }
}

export async function listProjectIssues(
  ctx: PluginContext,
  baseUrl: string,
  tokenRef: string,
  mantisProjectId: number,
): Promise<MantisIssueNormalized[]> {
  const out: MantisIssueNormalized[] = [];
  let page = 1;

  for (;;) {
    const path = `/api/rest/issues?project_id=${encodeURIComponent(String(mantisProjectId))}&page_size=100&page=${page}`;
    const data = await mantisApiJson<unknown>(ctx, baseUrl, tokenRef, "GET", path);
    const rows = extractIssuesArray(data);
    if (rows.length === 0) break;

    for (const row of rows) {
      const n = normalizeMantisIssue(row);
      if (n) out.push(n);
    }

    if (rows.length < 100) break;
    page += 1;
    if (page > 500) {
      ctx.logger.warn("Mantis issue list pagination stopped at page 500 (safety cap).");
      break;
    }
  }

  return out;
}
