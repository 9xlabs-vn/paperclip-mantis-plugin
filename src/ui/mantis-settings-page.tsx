import React, { useEffect, useMemo, useState } from "react";

import type { Issue } from "@paperclipai/plugin-sdk";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

import { requiresPaperclipBoardAccess } from "../paperclip-health.js";
import { MANTIS_CONNECTOR_UI_STYLES } from "./mantis-ghsync-styles.js";
import {
  fetchJson,
  fetchPaperclipHealth,
  patchPluginConfig,
  resolveCliAuthPollUrl,
  resolveCliAuthUrl,
} from "./mantis-settings-http.js";
import { resolveOrCreateProject } from "./mantis-settings-projects.js";

type ThemeMode = "light" | "dark";

/** Loaded via browser fetch to `/api/companies/:id/agents` (user session — no plugin worker capability). */
type PaperclipAgentPick = { id: string; name: string };

const MANUAL_MANTIS_ID = "__manual__";

type MantisSyncAssigneeFilter = "any" | "unassigned" | "me";

const MANTIS_SYNC_ASSIGNEE_LABELS: Record<MantisSyncAssigneeFilter, string> = {
  any: "Any assignee",
  unassigned: "Unassigned only",
  me: "Assigned to me",
};

const PAPERCLIP_STATUS_OPTIONS: { value: Issue["status"]; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

type Tone = "neutral" | "success" | "warning" | "info" | "danger";

interface ThemePalette {
  text: string;
  title: string;
  muted: string;
  surface: string;
  surfaceAlt: string;
  surfaceRaised: string;
  border: string;
  borderSoft: string;
  inputBg: string;
  inputBorder: string;
  inputText: string;
  badgeBg: string;
  badgeBorder: string;
  badgeText: string;
  primaryBg: string;
  primaryBorder: string;
  primaryText: string;
  secondaryBg: string;
  secondaryBorder: string;
  secondaryText: string;
  dangerBg: string;
  dangerBorder: string;
  dangerText: string;
  successBg: string;
  successBorder: string;
  successText: string;
  warningBg: string;
  warningBorder: string;
  warningText: string;
  infoBg: string;
  infoBorder: string;
  infoText: string;
  shadow: string;
}

const LIGHT_PALETTE: ThemePalette = {
  text: "#18181b",
  title: "#09090b",
  muted: "#71717a",
  surface: "#ffffff",
  surfaceAlt: "#fafafa",
  surfaceRaised: "#f5f5f5",
  border: "#e4e4e7",
  borderSoft: "#f4f4f5",
  inputBg: "#ffffff",
  inputBorder: "#d4d4d8",
  inputText: "#18181b",
  badgeBg: "#fafafa",
  badgeBorder: "#e4e4e7",
  badgeText: "#3f3f46",
  primaryBg: "#18181b",
  primaryBorder: "#18181b",
  primaryText: "#fafafa",
  secondaryBg: "#ffffff",
  secondaryBorder: "#d4d4d8",
  secondaryText: "#27272a",
  dangerBg: "#fff1f2",
  dangerBorder: "#fecdd3",
  dangerText: "#be123c",
  successBg: "#f0fdf4",
  successBorder: "#bbf7d0",
  successText: "#166534",
  warningBg: "#fffbeb",
  warningBorder: "#fde68a",
  warningText: "#a16207",
  infoBg: "#eff6ff",
  infoBorder: "#bfdbfe",
  infoText: "#1d4ed8",
  shadow: "0 12px 30px rgba(15, 23, 42, 0.05)",
};

const DARK_PALETTE: ThemePalette = {
  text: "#f5f5f5",
  title: "#fafafa",
  muted: "#a1a1aa",
  surface: "rgba(10, 10, 11, 0.96)",
  surfaceAlt: "rgba(15, 15, 17, 1)",
  surfaceRaised: "rgba(19, 19, 24, 1)",
  border: "rgba(63, 63, 70, 0.92)",
  borderSoft: "rgba(39, 39, 42, 1)",
  inputBg: "rgba(15, 15, 17, 1)",
  inputBorder: "rgba(63, 63, 70, 1)",
  inputText: "#fafafa",
  badgeBg: "rgba(24, 24, 27, 0.9)",
  badgeBorder: "rgba(63, 63, 70, 1)",
  badgeText: "#d4d4d8",
  primaryBg: "#f4f4f5",
  primaryBorder: "rgba(82, 82, 91, 1)",
  primaryText: "#111113",
  secondaryBg: "rgba(24, 24, 27, 1)",
  secondaryBorder: "rgba(63, 63, 70, 1)",
  secondaryText: "#e4e4e7",
  dangerBg: "rgba(69, 10, 10, 0.24)",
  dangerBorder: "rgba(127, 29, 29, 0.8)",
  dangerText: "#fca5a5",
  successBg: "rgba(20, 83, 45, 0.16)",
  successBorder: "rgba(34, 197, 94, 0.25)",
  successText: "#bbf7d0",
  warningBg: "rgba(146, 64, 14, 0.2)",
  warningBorder: "rgba(245, 158, 11, 0.24)",
  warningText: "#fcd34d",
  infoBg: "rgba(29, 78, 216, 0.2)",
  infoBorder: "rgba(96, 165, 250, 0.24)",
  infoText: "#93c5fd",
  shadow: "0 18px 40px rgba(0, 0, 0, 0.24)",
};

function buildThemeVars(theme: ThemePalette, themeMode: ThemeMode): React.CSSProperties {
  return {
    colorScheme: themeMode,
    ["--ghsync-text" as string]: theme.text,
    ["--ghsync-title" as string]: theme.title,
    ["--ghsync-muted" as string]: theme.muted,
    ["--ghsync-surface" as string]: theme.surface,
    ["--ghsync-surfaceAlt" as string]: theme.surfaceAlt,
    ["--ghsync-surfaceRaised" as string]: theme.surfaceRaised,
    ["--ghsync-border" as string]: theme.border,
    ["--ghsync-border-soft" as string]: theme.borderSoft,
    ["--ghsync-input-bg" as string]: theme.inputBg,
    ["--ghsync-input-border" as string]: theme.inputBorder,
    ["--ghsync-input-text" as string]: theme.inputText,
    ["--ghsync-badge-bg" as string]: theme.badgeBg,
    ["--ghsync-badge-border" as string]: theme.badgeBorder,
    ["--ghsync-badge-text" as string]: theme.badgeText,
    ["--ghsync-primary-bg" as string]: theme.primaryBg,
    ["--ghsync-primary-border" as string]: theme.primaryBorder,
    ["--ghsync-primary-text" as string]: theme.primaryText,
    ["--ghsync-secondary-bg" as string]: theme.secondaryBg,
    ["--ghsync-secondary-border" as string]: theme.secondaryBorder,
    ["--ghsync-secondary-text" as string]: theme.secondaryText,
    ["--ghsync-danger-bg" as string]: theme.dangerBg,
    ["--ghsync-danger-border" as string]: theme.dangerBorder,
    ["--ghsync-danger-text" as string]: theme.dangerText,
    ["--ghsync-success-bg" as string]: theme.successBg,
    ["--ghsync-success-border" as string]: theme.successBorder,
    ["--ghsync-success-text" as string]: theme.successText,
    ["--ghsync-warning-bg" as string]: theme.warningBg,
    ["--ghsync-warning-border" as string]: theme.warningBorder,
    ["--ghsync-warning-text" as string]: theme.warningText,
    ["--ghsync-info-bg" as string]: theme.infoBg,
    ["--ghsync-info-border" as string]: theme.infoBorder,
    ["--ghsync-info-text" as string]: theme.infoText,
    ["--ghsync-shadow" as string]: theme.shadow,
  } as React.CSSProperties;
}

function getThemeMode(): ThemeMode {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return "dark";
  }

  const root = document.documentElement;
  const body = document.body;
  const candidates = [root, body].filter((node): node is HTMLElement => Boolean(node));

  for (const node of candidates) {
    const attrTheme =
      node.getAttribute("data-theme") || node.getAttribute("data-color-mode") || node.getAttribute("data-mode");
    if (attrTheme === "light" || attrTheme === "dark") {
      return attrTheme;
    }

    if (node.classList.contains("light")) {
      return "light";
    }

    if (node.classList.contains("dark")) {
      return "dark";
    }
  }

  const colorScheme = window.getComputedStyle(body).colorScheme || window.getComputedStyle(root).colorScheme;
  if (colorScheme === "light" || colorScheme === "dark") {
    return colorScheme;
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function useResolvedThemeMode(): ThemeMode {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getThemeMode());

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const matcher = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = () => {
      setThemeMode(getThemeMode());
    };

    handleChange();
    matcher.addEventListener("change", handleChange);

    const observer = new MutationObserver(handleChange);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-color-mode", "data-mode"],
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-color-mode", "data-mode"],
    });

    return () => {
      matcher.removeEventListener("change", handleChange);
      observer.disconnect();
    };
  }, []);

  return themeMode;
}

function getToneClass(tone: Tone): string {
  switch (tone) {
    case "success":
      return "ghsync__badge--success";
    case "warning":
      return "ghsync__badge--warning";
    case "info":
      return "ghsync__badge--info";
    case "danger":
      return "ghsync__badge--danger";
    default:
      return "ghsync__badge--neutral";
  }
}

const HOST_BUTTON_BASE_CLASSNAME = [
  "inline-flex items-center justify-center whitespace-nowrap text-sm font-medium",
  "transition-[color,background-color,border-color,box-shadow,opacity]",
  "disabled:pointer-events-none disabled:opacity-50",
  "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  "[&_svg]:shrink-0 outline-none focus-visible:border-ring",
  "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  "rounded-md gap-1.5 shrink-0 shadow-xs",
].join(" ");

const HOST_DEFAULT_BUTTON_CLASSNAME = [HOST_BUTTON_BASE_CLASSNAME, "bg-primary text-primary-foreground hover:bg-primary/90"].join(
  " ",
);

const HOST_OUTLINE_BUTTON_CLASSNAME = [
  HOST_BUTTON_BASE_CLASSNAME,
  "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
  "dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
].join(" ");

const HOST_DESTRUCTIVE_BUTTON_CLASSNAME = [
  HOST_BUTTON_BASE_CLASSNAME,
  "bg-destructive text-white hover:bg-destructive/90",
  "focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
].join(" ");

const HOST_ACTION_BUTTON_SIZE_CLASSNAME = "h-9 px-4 py-2 has-[>svg]:px-3";

function getConnectorButtonClassName(variant: "primary" | "secondary" | "danger"): string {
  const variantClassName =
    variant === "primary"
      ? HOST_DEFAULT_BUTTON_CLASSNAME
      : variant === "danger"
        ? HOST_DESTRUCTIVE_BUTTON_CLASSNAME
        : HOST_OUTLINE_BUTTON_CLASSNAME;

  return ["ghsync__button", variantClassName, HOST_ACTION_BUTTON_SIZE_CLASSNAME].join(" ");
}

type BoardAccessRequirementStatus = "loading" | "required" | "not_required" | "unknown";

function usePaperclipBoardAccessRequirement(): {
  status: BoardAccessRequirementStatus;
  required: boolean;
} {
  const [status, setStatus] = useState<BoardAccessRequirementStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const healthSnapshot = await fetchPaperclipHealth();
      if (cancelled) {
        return;
      }

      if (!healthSnapshot) {
        setStatus("unknown");
        return;
      }

      setStatus(requiresPaperclipBoardAccess(healthSnapshot) ? "required" : "not_required");
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return {
    status,
    required: status === "required",
  };
}

function getPluginIdFromLocation(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const parts = window.location.pathname.split("/").filter(Boolean);
  const pluginsIndex = parts.indexOf("plugins");
  if (pluginsIndex === -1 || pluginsIndex + 1 >= parts.length) {
    return null;
  }

  return parts[pluginsIndex + 1] ?? null;
}

const syncedPaperclipApiBaseUrlsByPluginId = new Map<string, string>();

function getPaperclipApiBaseUrlFromBrowser(): string | undefined {
  if (typeof window === "undefined" || !window.location?.origin) {
    return undefined;
  }

  return window.location.origin;
}

async function syncTrustedPaperclipApiBaseUrl(pluginId: string | null): Promise<string | undefined> {
  const paperclipApiBaseUrl = getPaperclipApiBaseUrlFromBrowser();
  if (!paperclipApiBaseUrl) {
    return undefined;
  }

  const resolvedPluginId = pluginId?.trim() ?? null;
  if (!resolvedPluginId) {
    return undefined;
  }

  const lastSynced = syncedPaperclipApiBaseUrlsByPluginId.get(resolvedPluginId);
  if (lastSynced === paperclipApiBaseUrl) {
    return paperclipApiBaseUrl;
  }

  await patchPluginConfig(resolvedPluginId, {
    paperclipApiBaseUrl,
  });
  syncedPaperclipApiBaseUrlsByPluginId.set(resolvedPluginId, paperclipApiBaseUrl);

  return paperclipApiBaseUrl;
}

function getActionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return fallback;
}

interface CliAuthChallengeResponse {
  token?: string;
  boardApiToken?: string;
  approvalUrl?: string;
  approvalPath?: string;
  pollUrl?: string;
  pollPath?: string;
  expiresAt?: string;
  suggestedPollIntervalMs?: number;
}

interface CliAuthChallengePollResponse {
  status?: string;
  boardApiToken?: string;
}

interface CliAuthIdentityResponse {
  user?: { displayName?: string; name?: string; login?: string; email?: string };
  displayName?: string;
  name?: string;
  login?: string;
  email?: string;
}

const CLI_AUTH_POLL_MIN_MS = 500;
const CLI_AUTH_POLL_MAX_MS = 5000;
const CLI_AUTH_POLL_FALLBACK_MS = 1000;

function normalizeCliAuthPollIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return CLI_AUTH_POLL_FALLBACK_MS;
  }

  return Math.min(CLI_AUTH_POLL_MAX_MS, Math.max(CLI_AUTH_POLL_MIN_MS, Math.floor(value)));
}

function waitForDuration(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, durationMs);
  });
}

function getCliAuthIdentityLabel(identity: CliAuthIdentityResponse): string | null {
  const candidates = [
    identity.user?.displayName,
    identity.user?.name,
    identity.user?.login,
    identity.user?.email,
    identity.displayName,
    identity.name,
    identity.login,
    identity.email,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

async function resolveOrCreateCompanySecret(
  companyId: string,
  name: string,
  value: string,
): Promise<{ id: string; name: string }> {
  const existingSecrets = await fetchJson<Array<{ id: string; name: string }>>(`/api/companies/${companyId}/secrets`);
  const existing = existingSecrets.find((secret) => secret.name.trim().toLowerCase() === name.trim().toLowerCase());

  if (existing) {
    return fetchJson<{ id: string; name: string }>(`/api/secrets/${existing.id}/rotate`, {
      method: "POST",
      body: JSON.stringify({
        value,
      }),
    });
  }

  return fetchJson<{ id: string; name: string }>(`/api/companies/${companyId}/secrets`, {
    method: "POST",
    body: JSON.stringify({
      name,
      value,
    }),
  });
}

async function requestBoardAccessChallenge(companyId: string): Promise<CliAuthChallengeResponse> {
  return fetchJson<CliAuthChallengeResponse>("/api/cli-auth/challenges", {
    method: "POST",
    body: JSON.stringify({
      command: "paperclip plugin mantis settings",
      clientName: "Mantis Sync plugin",
      requestedAccess: "board",
      requestedCompanyId: companyId,
    }),
  });
}

async function waitForBoardAccessApproval(challenge: CliAuthChallengeResponse): Promise<string> {
  const challengeToken = typeof challenge.token === "string" ? challenge.token.trim() : "";
  const pollUrl = resolveCliAuthPollUrl(challenge.pollUrl ?? challenge.pollPath);
  if (!challengeToken || !pollUrl) {
    throw new Error("Paperclip did not return a usable board access challenge.");
  }

  const expiresAtTimeMs = typeof challenge.expiresAt === "string" ? Date.parse(challenge.expiresAt) : NaN;
  const pollIntervalMs = normalizeCliAuthPollIntervalMs(challenge.suggestedPollIntervalMs);

  while (true) {
    const pollUrlWithToken = new URL(pollUrl);
    pollUrlWithToken.searchParams.set("token", challengeToken);
    const pollResult = await fetchJson<CliAuthChallengePollResponse>(pollUrlWithToken.toString());
    const status = typeof pollResult.status === "string" ? pollResult.status.trim().toLowerCase() : "pending";

    if (status === "approved") {
      const boardApiToken =
        typeof pollResult.boardApiToken === "string" && pollResult.boardApiToken.trim()
          ? pollResult.boardApiToken.trim()
          : typeof challenge.boardApiToken === "string" && challenge.boardApiToken.trim()
            ? challenge.boardApiToken.trim()
            : "";
      if (!boardApiToken) {
        throw new Error("Paperclip approved board access but did not return a usable API token.");
      }

      return boardApiToken;
    }

    if (status === "cancelled") {
      throw new Error("Board access approval was cancelled.");
    }

    if (status === "expired") {
      throw new Error("Board access approval expired. Start the connection flow again.");
    }

    if (Number.isFinite(expiresAtTimeMs) && Date.now() >= expiresAtTimeMs) {
      throw new Error("Board access approval expired. Start the connection flow again.");
    }

    await waitForDuration(pollIntervalMs);
  }
}

async function fetchBoardAccessIdentity(boardApiToken: string): Promise<string | null> {
  const identity = await fetchJson<CliAuthIdentityResponse>("/api/cli-auth/me", {
    headers: {
      authorization: `Bearer ${boardApiToken.trim()}`,
    },
  });

  return getCliAuthIdentityLabel(identity);
}

function LoadingSpinner(props: { size?: "sm" | "md"; label?: string }): React.JSX.Element {
  const sizeClassName = props.size === "sm" ? "ghsync__spinner--sm" : "ghsync__spinner--md";

  return (
    <span
      role="status"
      aria-label={props.label ?? "Loading"}
      className={["ghsync__spinner", sizeClassName].join(" ")}
    />
  );
}

function LoadingButtonContent(props: {
  busy: boolean;
  label: string;
  busyLabel?: string;
}): React.JSX.Element {
  if (!props.busy) {
    return <>{props.label}</>;
  }

  return (
    <span className="ghsync__button-content">
      <LoadingSpinner size="sm" />
      <span>{props.busyLabel ?? props.label}</span>
    </span>
  );
}

type ProjectOption = {
  id: string;
  name: string;
};

type MappingRow = {
  id: string;
  mantisProjectId: number;
  mantisProjectName?: string;
  paperclipProjectId: string;
  /** If set when no project is selected, save creates or matches a Paperclip project by name (GitLab-style). */
  newPaperclipProjectName: string;
  /** When true, the numeric Mantis id is edited manually (not chosen from the REST project list). */
  manualMantisId: boolean;
};

type RegistrationData = {
  mantisBaseUrl: string;
  mantisTokenRef: string;
  /** From last successful Mantis API token validation (users/me). */
  mantisApiIdentity?: string;
  lastMantisApiUserId?: number;
  mantisTokenConfigured: boolean;
  syncIntervalMinutes: number;
  syncOnlyOpenIssues?: boolean;
  syncAssigneeFilter?: MantisSyncAssigneeFilter;
  defaultPaperclipStatus?: Issue["status"];
  /** Paperclip agent id for new imports; empty string if unset. */
  defaultAssigneeAgentId?: string;
  ignoreReporterNames?: string;
  paperclipApiBaseUrl?: string;
  paperclipBoardAccessConfigured: boolean;
  mappings: MappingRow[];
  projects: ProjectOption[];
  updatedAt?: string;
  lastSync?: unknown;
};

type SyncRunState = {
  lastCompletedAt?: string;
  lastTrigger?: string;
  summary?: {
    created?: number;
    updated?: number;
    skipped?: number;
    errors?: string[];
  };
};

type TokenAuditProject = {
  mantisProjectId: number;
  mantisProjectName?: string;
  paperclipProjectId: string;
  paperclipProjectName?: string;
  status: "verified" | "missing_access" | "error";
  message?: string;
};

type TokenAuditSummary = {
  status: string;
  allProjectsReachable: boolean;
  projects: TokenAuditProject[];
  warnings: string[];
};

export function MantisConnectorSettingsPage(_props: PluginSettingsPageProps): React.JSX.Element {
  const hostContext = useHostContext();
  const toast = usePluginToast();
  const pluginIdFromLocation = getPluginIdFromLocation();
  const companyId = hostContext.companyId ?? "";
  const hasCompany = Boolean(companyId);
  const companyScopeLabel =
    hostContext.companyName?.trim() || hostContext.companyPrefix?.trim() || (companyId ? `${companyId.slice(0, 8)}…` : "");

  const themeMode = useResolvedThemeMode();
  const theme = themeMode === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  const themeVars = buildThemeVars(theme, themeMode);

  const registrationParams = useMemo(() => (companyId ? { companyId } : {}), [companyId]);

  const registration = usePluginData<RegistrationData>("settings.registration", registrationParams);
  const mantisProjects = usePluginData<{
    ok: boolean;
    reason?: string;
    message?: string;
    projects: Array<{ id: number; name: string }>;
  }>("settings.mantisProjects", {});
  const syncStatus = usePluginData<SyncRunState | null>("sync.status", {});
  const tokenAudit = usePluginData<TokenAuditSummary>("settings.tokenPermissionAudit", registrationParams);

  const saveRegistration = usePluginAction("settings.saveRegistration");
  const updateBoardAccess = usePluginAction("settings.updateBoardAccess");
  const validateToken = usePluginAction("settings.validateToken");
  const validateSavedToken = usePluginAction("settings.validateSavedToken");

  const boardAccessRequirement = usePaperclipBoardAccessRequirement();

  const [localBaseUrl, setLocalBaseUrl] = useState("");
  /** Plain Mantis API token; saved to a company secret on Save (same pattern as GitLab PAT). */
  const [mantisPatDraft, setMantisPatDraft] = useState("");
  const [interval, setInterval] = useState(15);
  const [syncOnlyOpenIssues, setSyncOnlyOpenIssues] = useState(true);
  const [syncAssigneeFilter, setSyncAssigneeFilter] = useState<MantisSyncAssigneeFilter>("any");
  const [defaultPaperclipStatusDraft, setDefaultPaperclipStatusDraft] = useState<Issue["status"] | "">("");
  const [defaultAssigneeAgentIdDraft, setDefaultAssigneeAgentIdDraft] = useState("");
  const [paperclipAgentsForSelect, setPaperclipAgentsForSelect] = useState<PaperclipAgentPick[]>([]);
  const [paperclipAgentsListLoading, setPaperclipAgentsListLoading] = useState(false);
  const [paperclipAgentsListError, setPaperclipAgentsListError] = useState<string | null>(null);
  const [ignoreReporterNames, setIgnoreReporterNames] = useState("");
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validatedIdentity, setValidatedIdentity] = useState<string | null>(null);
  const [replacingMantisToken, setReplacingMantisToken] = useState(true);
  const [connectingBoard, setConnectingBoard] = useState(false);
  const [boardAccessIdentity, setBoardAccessIdentity] = useState<string | null>(null);

  useEffect(() => {
    if (!registration.data || submitting) {
      return;
    }
    const d = registration.data;
    setLocalBaseUrl(d.mantisBaseUrl ?? "");
    setInterval(typeof d.syncIntervalMinutes === "number" ? d.syncIntervalMinutes : 15);
    setSyncOnlyOpenIssues(d.syncOnlyOpenIssues !== false);
    const af = d.syncAssigneeFilter;
    setSyncAssigneeFilter(
      af === "unassigned" || af === "me" || af === "any" ? af : "any",
    );
    setDefaultPaperclipStatusDraft(d.defaultPaperclipStatus ?? "");
    setDefaultAssigneeAgentIdDraft(
      d.defaultPaperclipStatus
        ? ""
        : typeof d.defaultAssigneeAgentId === "string"
          ? d.defaultAssigneeAgentId
          : "",
    );
    setIgnoreReporterNames(typeof d.ignoreReporterNames === "string" ? d.ignoreReporterNames : "");
    setRows(
      (d.mappings ?? []).map((m) => ({
        id: m.id,
        mantisProjectId: m.mantisProjectId,
        mantisProjectName: m.mantisProjectName,
        paperclipProjectId: m.paperclipProjectId,
        newPaperclipProjectName: "",
        manualMantisId: false,
      })),
    );
  }, [registration.data, submitting]);

  useEffect(() => {
    if (!companyId || !registration.data?.mantisTokenConfigured) {
      return;
    }
    void mantisProjects.refresh?.();
  }, [companyId, registration.data?.mantisTokenConfigured]);

  useEffect(() => {
    if (!companyId) {
      setPaperclipAgentsForSelect([]);
      setPaperclipAgentsListError(null);
      setPaperclipAgentsListLoading(false);
      return;
    }
    let cancelled = false;
    setPaperclipAgentsListLoading(true);
    setPaperclipAgentsListError(null);
    void (async () => {
      try {
        const list = await fetchJson<PaperclipAgentPick[]>(
          `/api/companies/${encodeURIComponent(companyId)}/agents`,
        );
        if (cancelled) return;
        const arr = Array.isArray(list) ? list : [];
        setPaperclipAgentsForSelect(
          [...arr].sort((a, b) =>
            (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: "base" }),
          ),
        );
      } catch (e) {
        if (!cancelled) {
          setPaperclipAgentsForSelect([]);
          setPaperclipAgentsListError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setPaperclipAgentsListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  /** If the saved Mantis id is not returned by the projects API (custom id), switch to manual entry. */
  useEffect(() => {
    const payload = mantisProjects.data;
    if (!payload?.ok || payload.projects.length === 0) {
      return;
    }
    const ids = new Set(payload.projects.map((p) => p.id));
    setRows((prev) =>
      prev.map((row) => {
        if (row.manualMantisId || row.mantisProjectId <= 0) {
          return row;
        }
        if (!ids.has(row.mantisProjectId)) {
          return { ...row, manualMantisId: true };
        }
        return row;
      }),
    );
  }, [mantisProjects.data]);

  useEffect(() => {
    if (!registration.data?.paperclipBoardAccessConfigured) {
      setBoardAccessIdentity(null);
    }
  }, [registration.data?.paperclipBoardAccessConfigured]);

  useEffect(() => {
    if (registration.data?.mantisTokenConfigured) {
      setReplacingMantisToken(false);
      return;
    }
    if (!validatedIdentity) {
      setReplacingMantisToken(true);
    }
  }, [registration.data?.mantisTokenConfigured, validatedIdentity]);

  async function refreshAll(): Promise<void> {
    registration.refresh?.();
    syncStatus.refresh?.();
    tokenAudit.refresh?.();
  }

  /**
   * Writes company secret (if token draft), instance config, and plugin state so the host can
   * resolve secrets and "Refresh Mantis projects" works — without sending `mappings` (mappings
   * are saved only from the main Save button).
   */
  async function persistMantisCredentialsWithoutMappings(mantisApiIdentityLabel?: string): Promise<boolean> {
    const pluginId = pluginIdFromLocation?.trim();
    if (!companyId) {
      toast({
        title: "Select a company",
        body: "Open Settings from a company context.",
        tone: "warn",
      });
      return false;
    }
    if (!pluginId) {
      toast({
        title: "Missing plugin id",
        body: "Reload the page or open Mantis Sync from Instance → Settings → Plugins.",
        tone: "error",
      });
      return false;
    }

    const baseUrl = localBaseUrl.trim();
    if (!baseUrl) {
      toast({
        title: "Mantis base URL required",
        body: "Enter your Mantis instance root URL first.",
        tone: "warn",
      });
      return false;
    }

    let mantisTokenRef = registration.data?.mantisTokenRef ?? "";
    if (mantisPatDraft.trim()) {
      const secretName = `paperclip_mantis_api_${companyId.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
      const secret = await resolveOrCreateCompanySecret(companyId, secretName, mantisPatDraft.trim());
      mantisTokenRef = secret.id;
    }

    if (!mantisTokenRef.trim()) {
      toast({
        title: "Mantis API token required",
        body: "Paste a token to validate first.",
        tone: "warn",
      });
      return false;
    }

    const trustedPaperclipApiBaseUrl = await syncTrustedPaperclipApiBaseUrl(pluginIdFromLocation);

    await patchPluginConfig(pluginId, {
      mantisBaseUrl: baseUrl,
      mantisTokenRef,
      syncIntervalMinutes: interval,
      ...(trustedPaperclipApiBaseUrl ? { paperclipApiBaseUrl: trustedPaperclipApiBaseUrl } : {}),
      ...(mantisApiIdentityLabel?.trim()
        ? { lastMantisApiIdentity: mantisApiIdentityLabel.trim() }
        : {}),
    });

    await saveRegistration({
      companyId,
      mantisBaseUrl: baseUrl,
      mantisTokenRef,
      syncIntervalMinutes: interval,
      ...(trustedPaperclipApiBaseUrl ? { paperclipApiBaseUrl: trustedPaperclipApiBaseUrl } : {}),
    });

    setMantisPatDraft("");
    return true;
  }

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!companyId) {
      toast({
        title: "Select a company",
        body: "Open Settings from a company context so mappings are saved to the right scope.",
        tone: "warn",
      });
      return;
    }

    setSubmitting(true);
    try {
      const pluginId = pluginIdFromLocation?.trim();
      if (!pluginId) {
        toast({
          title: "Missing plugin id",
          body: "Reload the page or open Mantis Sync from Instance → Settings → Plugins.",
          tone: "error",
        });
        return;
      }

      const baseUrl = localBaseUrl.trim();
      if (!baseUrl) {
        toast({
          title: "Mantis base URL required",
          body: "Enter your Mantis instance root URL (for example https://mantis.example.com).",
          tone: "warn",
        });
        return;
      }

      let mantisTokenRef = registration.data?.mantisTokenRef ?? "";
      if (mantisPatDraft.trim()) {
        const secretName = `paperclip_mantis_api_${companyId.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
        const secret = await resolveOrCreateCompanySecret(companyId, secretName, mantisPatDraft.trim());
        mantisTokenRef = secret.id;
      }

      if (!mantisTokenRef.trim()) {
        toast({
          title: "Mantis API token required",
          body: "Paste a Mantis API token (My Account → API Tokens), or save again after a token was stored previously.",
          tone: "warn",
        });
        return;
      }

      const resolvedMappingRows: MappingRow[] = [];
      for (const row of rows) {
        let paperclipProjectId = row.paperclipProjectId.trim();
        const draftName = row.newPaperclipProjectName.trim();

        if (!paperclipProjectId && draftName) {
          if (row.mantisProjectId <= 0) {
            toast({
              title: "Mantis project required",
              body: "Select or enter a Mantis project before creating a new Paperclip project for that row.",
              tone: "warn",
            });
            return;
          }
          const created = await resolveOrCreateProject(companyId, draftName);
          resolvedMappingRows.push({
            ...row,
            paperclipProjectId: created.id,
            newPaperclipProjectName: "",
          });
          continue;
        }

        resolvedMappingRows.push(row);
      }

      for (const row of resolvedMappingRows) {
        const hasMantis = row.mantisProjectId > 0;
        const hasPaperclip = Boolean(row.paperclipProjectId.trim()) || Boolean(row.newPaperclipProjectName.trim());
        const emptyRow = !hasMantis && !hasPaperclip;
        if (emptyRow) {
          continue;
        }
        if (hasMantis && !hasPaperclip) {
          toast({
            title: "Incomplete mapping",
            body: "Choose a Paperclip project for each Mantis project (or enter a new Paperclip project name).",
            tone: "warn",
          });
          return;
        }
        if (!hasMantis && hasPaperclip) {
          toast({
            title: "Incomplete mapping",
            body: "Choose or enter a Mantis project id for each Paperclip binding.",
            tone: "warn",
          });
          return;
        }
      }

      const mappingPayload = resolvedMappingRows
        .filter((row) => row.mantisProjectId > 0 && row.paperclipProjectId.trim())
        .map((row) => ({
          id: row.id,
          mantisProjectId: row.mantisProjectId,
          mantisProjectName: row.mantisProjectName,
          paperclipProjectId: row.paperclipProjectId.trim(),
        }));

      const trustedPaperclipApiBaseUrl = await syncTrustedPaperclipApiBaseUrl(pluginIdFromLocation);

      // Host allows secret resolution only for UUIDs in instance config (DB), not plugin state alone.
      await patchPluginConfig(pluginId, {
        mantisBaseUrl: baseUrl,
        mantisTokenRef,
        syncIntervalMinutes: interval,
        ...(companyId
          ? {
              companyAdvancedSync: {
                [companyId]: {
                  syncOnlyOpenIssues,
                  syncAssigneeFilter,
                  defaultPaperclipStatus: defaultPaperclipStatusDraft || "",
                  defaultAssigneeAgentId: defaultPaperclipStatusDraft
                    ? ""
                    : defaultAssigneeAgentIdDraft.trim(),
                  ignoreReporterNames: ignoreReporterNames.trim(),
                },
              },
            }
          : {}),
        ...(trustedPaperclipApiBaseUrl ? { paperclipApiBaseUrl: trustedPaperclipApiBaseUrl } : {}),
        ...((validatedIdentity ?? registration.data?.mantisApiIdentity)?.trim()
          ? {
              lastMantisApiIdentity: (validatedIdentity ?? registration.data?.mantisApiIdentity ?? "").trim(),
            }
          : {}),
      });

      await saveRegistration({
        companyId,
        mantisBaseUrl: baseUrl,
        mantisTokenRef,
        syncIntervalMinutes: interval,
        ...(companyId
          ? {
              syncOnlyOpenIssues,
              syncAssigneeFilter,
              defaultPaperclipStatus: defaultPaperclipStatusDraft || "",
              defaultAssigneeAgentId: defaultPaperclipStatusDraft ? "" : defaultAssigneeAgentIdDraft.trim(),
              ignoreReporterNames,
            }
          : {}),
        ...(trustedPaperclipApiBaseUrl ? { paperclipApiBaseUrl: trustedPaperclipApiBaseUrl } : {}),
        mappings: mappingPayload,
      });
      setMantisPatDraft("");
      setRows(resolvedMappingRows.map((row) => ({ ...row, newPaperclipProjectName: "" })));
      toast({ title: "Saved", body: "Mantis Sync settings updated.", tone: "success" });
      await refreshAll();
      void mantisProjects.refresh?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Save failed", body: message, tone: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConnectBoard(): Promise<void> {
    if (!companyId) {
      return;
    }

    const pluginId = pluginIdFromLocation?.trim();
    if (!pluginId) {
      toast({ title: "Missing plugin id", body: "Reload the page and try again.", tone: "error" });
      return;
    }

    setConnectingBoard(true);
    let approvalWindow: Window | null = null;

    try {
      if (typeof window !== "undefined") {
        approvalWindow = window.open("about:blank", "_blank");
      }

      const challenge = await requestBoardAccessChallenge(companyId);
      const approvalUrl = resolveCliAuthUrl(challenge.approvalUrl, challenge.approvalPath);

      if (!approvalUrl) {
        throw new Error("Paperclip did not return a board approval URL.");
      }

      if (!approvalWindow && typeof window !== "undefined") {
        approvalWindow = window.open(approvalUrl, "_blank");
      } else {
        approvalWindow?.location.replace(approvalUrl);
      }

      if (!approvalWindow) {
        throw new Error("Allow pop-ups for Paperclip, then try connecting board access again.");
      }

      const boardApiToken = await waitForBoardAccessApproval(challenge);
      const identity = await fetchBoardAccessIdentity(boardApiToken);
      const secretName = `paperclip_board_api_${companyId.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
      const secret = await resolveOrCreateCompanySecret(companyId, secretName, boardApiToken);

      await patchPluginConfig(pluginId, {
        paperclipBoardApiTokenRefs: {
          [companyId]: secret.id,
        },
      });

      await updateBoardAccess({
        companyId,
        paperclipBoardApiTokenRef: secret.id,
      });

      await registration.refresh?.();

      setBoardAccessIdentity(identity);

      toast({
        title: identity ? `Paperclip board connected as ${identity}` : "Paperclip board connected",
        body: "The plugin can authenticate back to Paperclip when needed.",
        tone: "success",
      });
    } catch (error) {
      toast({
        title: "Board access failed",
        body: getActionErrorMessage(error, "Unable to finish Paperclip board access."),
        tone: "error",
      });
    } finally {
      setConnectingBoard(false);
      try {
        approvalWindow?.close();
      } catch {
        /* ignore */
      }
    }
  }

  async function handleSavedProbe(): Promise<void> {
    if (mantisPatDraft.trim()) {
      const baseUrl = localBaseUrl.trim();
      if (!baseUrl) {
        toast({
          title: "Mantis base URL required",
          body: "Enter your Mantis instance URL before validating the token.",
          tone: "warn",
        });
        return;
      }

      setValidating(true);
      try {
        const result = (await validateToken({
          token: mantisPatDraft,
          mantisBaseUrl: baseUrl,
        })) as { identity?: string };
        const label =
          typeof result?.identity === "string" && result.identity.trim()
            ? result.identity.trim()
            : undefined;
        const persisted = await persistMantisCredentialsWithoutMappings(label);
        if (!persisted) {
          return;
        }
        setValidatedIdentity(label ?? "Token OK");
        setReplacingMantisToken(false);
        toast({
          title: "Mantis connected",
          body: label
            ? `Authenticated as ${label}. Token is saved — use Refresh Mantis projects below, then Save settings when mappings are ready.`
            : "Token saved — use Refresh Mantis projects below, then Save settings when mappings are ready.",
          tone: "success",
        });
        await refreshAll();
        void mantisProjects.refresh?.();
      } catch (e) {
        setValidatedIdentity(null);
        const message = e instanceof Error ? e.message : String(e);
        toast({ title: "Validation failed", body: message, tone: "error" });
      } finally {
        setValidating(false);
      }
      return;
    }

    const savedRef = registration.data?.mantisTokenRef?.trim();
    if (!savedRef) {
      toast({
        title: "Token required",
        body: "Paste a Mantis API token to validate, or save settings once so a stored secret exists.",
        tone: "warn",
      });
      return;
    }

    setValidating(true);
    try {
      const result = (await validateSavedToken()) as { identity?: string };
      const label =
        typeof result?.identity === "string" && result.identity.trim()
          ? result.identity.trim()
          : undefined;
      const persisted = await persistMantisCredentialsWithoutMappings(label);
      if (!persisted) {
        return;
      }
      setValidatedIdentity(label ?? "Saved token OK");
      setReplacingMantisToken(false);
      toast({
        title: "Mantis connected",
        body: label
          ? `Authenticated as ${label}. Instance config updated — you can refresh Mantis projects; Save settings when mappings are ready.`
          : "Instance config updated — refresh Mantis projects; Save settings when mappings are ready.",
        tone: "success",
      });
      await refreshAll();
      void mantisProjects.refresh?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast({ title: "Saved token failed", body: message, tone: "error" });
    } finally {
      setValidating(false);
    }
  }

  function addRow(): void {
    const id =
      typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `row-${Date.now()}`;
    setRows((prev) => [
      ...prev,
      {
        id,
        mantisProjectId: 0,
        mantisProjectName: undefined,
        paperclipProjectId: registration.data?.projects?.[0]?.id ?? "",
        newPaperclipProjectName: "",
        manualMantisId: true,
      },
    ]);
  }

  function removeRow(id: string): void {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  const mappedCount = rows.filter((row) => row.mantisProjectId > 0 && (row.paperclipProjectId.trim() || row.newPaperclipProjectName.trim())).length;

  const assigneeAgentSummaryLabel = useMemo(() => {
    const aid = String(defaultAssigneeAgentIdDraft ?? "").trim();
    if (!aid) return "Unassigned";
    const hit = paperclipAgentsForSelect.find((a) => a.id === aid);
    return hit?.name ?? (aid.length > 18 ? `${aid.slice(0, 16)}…` : aid);
  }, [defaultAssigneeAgentIdDraft, paperclipAgentsForSelect]);

  const advancedSummaryLine = useMemo(() => {
    const ign = ignoreReporterNames.trim().replace(/\n/g, ", ").replace(/\s+/g, " ").trim();
    const ignShort = ign.length > 44 ? `${ign.slice(0, 42)}…` : ign;
    const override = String(defaultPaperclipStatusDraft ?? "").trim();
    const newImportLabel =
      override === ""
        ? "From Mantis (auto map)"
        : (PAPERCLIP_STATUS_OPTIONS.find((o) => o.value === override)?.label ?? override);
    let agentSegment = "";
    if (override === "") {
      agentSegment = ` · Paperclip agent: ${assigneeAgentSummaryLabel}`;
    }
    return `${syncOnlyOpenIssues ? "Open issues only" : "Include closed issues"} · Assignee: ${
      MANTIS_SYNC_ASSIGNEE_LABELS[syncAssigneeFilter]
    } · New imports: ${newImportLabel}${agentSegment} · Reporters ignored: ${ignShort || "—"}`;
  }, [
    assigneeAgentSummaryLabel,
    defaultPaperclipStatusDraft,
    ignoreReporterNames,
    syncAssigneeFilter,
    syncOnlyOpenIssues,
  ]);

  const mantisAssigneeMeReady =
    typeof registration.data?.lastMantisApiUserId === "number"
    && Number.isFinite(registration.data.lastMantisApiUserId)
    && registration.data.lastMantisApiUserId > 0;

  const advancedTone: Tone =
    syncAssigneeFilter === "me" && !mantisAssigneeMeReady ? "warning" : "success";

  const mantisTokenSaved = Boolean(registration.data?.mantisTokenConfigured);
  const validatedPendingSave = Boolean(validatedIdentity && !mantisTokenSaved);
  const showMantisAccessCompact = !replacingMantisToken && (mantisTokenSaved || Boolean(validatedIdentity));

  const tokenAuditMeta = tokenAudit.data;
  const hasMappedProjects = mappedCount > 0;

  const tokenConfigured = mantisTokenSaved;
  const hasTokenInputOrSaved =
    Boolean(mantisPatDraft.trim()) || mantisTokenSaved || Boolean(registration.data?.mantisTokenRef?.trim());
  const tokenTone: Tone = mantisTokenSaved
    ? "success"
    : validatedPendingSave
      ? "info"
      : hasTokenInputOrSaved
        ? "info"
        : "warning";

  const mantisSectionBadgeLabel = mantisTokenSaved
    ? "Valid"
    : validatedPendingSave
      ? "Save settings"
      : "Required";

  const mantisHeaderStatusLabel = mantisTokenSaved
    ? "Valid"
    : validatedPendingSave
      ? "Save to connect"
      : localBaseUrl.trim() && hasTokenInputOrSaved
        ? "Configure"
        : "Needs URL + token";

  const headerConnectorTone: Tone =
    mantisTokenSaved
      ? "success"
      : validatedPendingSave
        ? "info"
        : localBaseUrl.trim() && hasTokenInputOrSaved
          ? "info"
          : "warning";

  const mappingTone: Tone = mappedCount > 0 ? "success" : "neutral";

  const mantisIdentityDisplay = (() => {
    const s = (validatedIdentity ?? registration.data?.mantisApiIdentity ?? "").trim();
    return s || null;
  })();

  const mantisSummaryTokenLabel = mantisTokenSaved
    ? "Valid"
    : validatedPendingSave
      ? "Pending save"
      : mantisPatDraft.trim()
        ? "Unsaved token"
        : registration.data?.mantisTokenRef?.trim()
          ? "Stored"
          : "Missing";

  const lastSaved = registration.data?.updatedAt
    ? new Date(registration.data.updatedAt).toLocaleString()
    : "Not saved yet";

  const lastRun = syncStatus.data?.lastCompletedAt
    ? new Date(syncStatus.data.lastCompletedAt).toLocaleString()
    : "Never";

  const lastSummary = syncStatus.data?.summary;
  const syncHealthTone: Tone =
    lastSummary && (lastSummary.errors?.length ?? 0) > 0 ? "warning" : lastSummary ? "success" : "neutral";

  const showInitialLoading = registration.loading && !registration.data;

  const boardAccessConfigured = Boolean(registration.data?.paperclipBoardAccessConfigured);
  const boardAccessRequired = boardAccessRequirement.required;

  const boardAccessTone: Tone =
    connectingBoard ? "info" : boardAccessConfigured ? "success" : boardAccessRequired ? "warning" : "info";

  const boardAccessBannerLabel =
    connectingBoard
      ? "Connecting"
      : boardAccessConfigured
        ? "Connected"
        : boardAccessRequired
          ? "Required"
          : boardAccessRequirement.status === "loading"
            ? "Checking"
            : "Optional";

  const canConnectBoardAccess = hasCompany && !connectingBoard && !showInitialLoading;

  return (
    <div className="ghsync ghsync-settings" style={themeVars}>
      <style>{MANTIS_CONNECTOR_UI_STYLES}</style>

      <section className="ghsync__header">
        <div className="ghsync__header-copy">
          <h2>Mantis Sync settings</h2>
          <p>
            Connect MantisBT with API token authentication. Map each Mantis project id to a Paperclip project — synced
            tickets become Paperclip issues one-to-one.
          </p>
        </div>
        <div className="ghsync__section-head-actions">
          <span
            className={`ghsync__scope-pill ${hasCompany ? "ghsync__scope-pill--company" : "ghsync__scope-pill--mixed"}`}
            title={hasCompany ? companyId : undefined}
          >
            {hasCompany ? companyScopeLabel || "Company" : "No company"}
          </span>
          <span className={`ghsync__badge ${getToneClass(headerConnectorTone)}`}>
            <span className="ghsync__badge-dot" aria-hidden="true" />
            {mantisHeaderStatusLabel}
          </span>
        </div>
      </section>

      <div className="ghsync__layout">
        <section className="ghsync__card">
          <div className="ghsync__card-header">
            <h3>Configuration</h3>
            <p>{hasCompany ? companyScopeLabel : "Company context required to edit mappings."}</p>
          </div>

          {showInitialLoading ? (
            <div className="ghsync__loading-inline" aria-live="polite">
              <LoadingSpinner size="sm" />
              <span>Loading Mantis Sync settings…</span>
            </div>
          ) : null}

          {!hasCompany ? (
            <div className="ghsync__locked">
              <div>
                <strong>Company required</strong>
                <span>Open Instance → Plugins → Mantis Sync from inside a company, or choose a company first.</span>
              </div>
              <span className="ghsync__badge ghsync__badge--neutral">Scoped</span>
            </div>
          ) : (
            <form className="ghsync__stack" onSubmit={(e) => void handleSave(e)}>
              <section className="ghsync__section">
                <div className="ghsync__section-head">
                  <div className="ghsync__section-copy">
                    <div className="ghsync__section-title-row">
                      <h4>Mantis access</h4>
                      <span className="ghsync__scope-pill ghsync__scope-pill--global">Shared</span>
                    </div>
                    {showMantisAccessCompact ? (
                      mantisTokenSaved ? (
                        <p>Shared token.</p>
                      ) : (
                        <p>Token verified — save below to connect.</p>
                      )
                    ) : (
                    <p>
                      Shared Mantis base URL and API token across companies. <strong>Validate token</strong> saves the
                      token to a company secret and updates instance config so you can load Mantis projects before saving
                      mappings.
                    </p>
                    )}
                  </div>
                  <span className={`ghsync__badge ${getToneClass(tokenTone)}`}>{mantisSectionBadgeLabel}</span>
                </div>

                {showMantisAccessCompact ? (
                  <div className="ghsync__stack">
                    <div className="ghsync__connected">
                      <div>
                        <strong>{mantisTokenSaved ? "Shared token ready" : "Token verified"}</strong>
                        <span>
                          {mantisTokenSaved
                            ? "Shared across all companies."
                            : "Save settings to store this credential for all companies."}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={getConnectorButtonClassName("secondary")}
                        disabled={submitting}
                        onClick={() => {
                          setReplacingMantisToken(true);
                          if (mantisTokenSaved) {
                            setValidatedIdentity(null);
                          }
                        }}
                      >
                        Replace token
                      </button>
                    </div>
                    <div
                      className={`ghsync__permission-audit ${
                        !hasMappedProjects
                        || !tokenAuditMeta?.projects?.length
                        || (tokenAuditMeta.projects.length > 0 && !tokenAuditMeta.allProjectsReachable)
                          ? "ghsync__permission-audit--warning"
                          : ""
                      }`}
                    >
                      <div className="ghsync__permission-audit-item">
                        <strong>
                          {!hasMappedProjects
                            ? "Token permission audit pending"
                            : !tokenAuditMeta?.projects?.length
                              ? "Token permission audit pending"
                              : tokenAuditMeta.allProjectsReachable
                                ? "Token permission audit complete"
                                : "Token permission audit needs attention"}
                        </strong>
                        <span>
                          {!hasMappedProjects
                            ? "Add at least one mapped project in this company to audit token permissions."
                            : !tokenAuditMeta?.projects?.length
                              ? "Save settings with a valid token to verify access to mapped Mantis projects."
                              : tokenAuditMeta.allProjectsReachable
                                ? "Token can reach every mapped Mantis project."
                                : "Some mapped projects returned errors — verify ids and token scope."}
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="ghsync__field">
                      <label htmlFor="mantis-base-url">Mantis base URL</label>
                      <input
                        id="mantis-base-url"
                        className="ghsync__input"
                        value={localBaseUrl}
                        disabled={submitting}
                        onChange={(e) => setLocalBaseUrl(e.target.value)}
                        placeholder="https://bugs.example.com/mantis"
                        autoComplete="off"
                      />
                    </div>

                    <div className="ghsync__field">
                      <label htmlFor="mantis-api-token">Mantis API token</label>
                      <input
                        id="mantis-api-token"
                        className="ghsync__input"
                        type="password"
                        value={mantisPatDraft}
                        disabled={submitting}
                        onChange={(e) => setMantisPatDraft(e.target.value)}
                        placeholder={
                          registration.data?.mantisTokenConfigured ? "Leave blank to keep saved token" : "Paste token…"
                        }
                        autoComplete="new-password"
                      />
                      <p className="ghsync__hint">
                        From Mantis: My Account → API Tokens. <strong>Validate token</strong> stores the token in a
                        Paperclip company secret (<code>paperclip_mantis_api_…</code>) and updates instance config for
                        the worker.
                      </p>
                    </div>

                    <div className="ghsync__actions">
                      <button
                        type="button"
                        className={getConnectorButtonClassName("secondary")}
                        disabled={submitting || validating}
                        onClick={() => void handleSavedProbe()}
                      >
                        {validating ? (
                          <>
                            <LoadingSpinner size="sm" />
                            Validating…
                          </>
                        ) : (
                          "Validate token"
                        )}
                      </button>
                      {validatedIdentity ? (
                        <span className="ghsync__hint">
                          Last check: <strong>{validatedIdentity}</strong>
                          {!mantisTokenSaved ? " — validate or save below to store the token." : null}
                        </span>
                      ) : null}
                    </div>

                    {replacingMantisToken && (mantisTokenSaved || validatedIdentity) ? (
                      <div className="ghsync__actions">
                        <button
                          type="button"
                          className={getConnectorButtonClassName("secondary")}
                          onClick={() => setReplacingMantisToken(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}

                    {tokenAuditMeta?.projects?.length ? (
                      <div
                        className={`ghsync__message${tokenAuditMeta.allProjectsReachable ? "" : " ghsync__message--warning"}`}
                      >
                        <strong>Project access audit</strong>
                        <span>
                          {tokenAuditMeta.allProjectsReachable
                            ? "Token can reach every mapped Mantis project."
                            : "Some mapped projects returned errors — verify ids and token scope."}
                        </span>
                      </div>
                    ) : null}
                  </>
                )}
              </section>

              <section className="ghsync__section">
                <div className="ghsync__section-head">
                  <div className="ghsync__section-copy">
                    <div className="ghsync__section-title-row">
                      <h4>Paperclip board access</h4>
                      <span className="ghsync__scope-pill ghsync__scope-pill--company">Company</span>
                    </div>
                    <p>
                      When this instance runs in authenticated mode, the worker may need a Paperclip API token for your
                      company. Save settings once to record this page’s origin; then connect to approve access in the
                      browser.
                    </p>
                  </div>
                  <span className={`ghsync__badge ${getToneClass(boardAccessTone)}`}>{boardAccessBannerLabel}</span>
                </div>

                {hasCompany ? (
                  <div className="ghsync__connected">
                    <div>
                      <strong>
                        {boardAccessConfigured
                          ? boardAccessIdentity
                            ? `Connected as ${boardAccessIdentity}`
                            : "Connected"
                          : boardAccessRequired
                            ? "Required"
                            : boardAccessRequirement.status === "loading"
                              ? "Checking requirement"
                              : "Optional"}
                      </strong>
                      <span>
                        {boardAccessConfigured
                          ? "Used for Paperclip API calls from the plugin worker."
                          : boardAccessRequired
                            ? "Required in authenticated deployments."
                            : boardAccessRequirement.status === "loading"
                              ? "Checking whether it is required."
                              : "Only needed when Paperclip API calls require sign-in."}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={getConnectorButtonClassName(boardAccessConfigured ? "secondary" : "primary")}
                      disabled={!canConnectBoardAccess}
                      onClick={() => void handleConnectBoard()}
                    >
                      <LoadingButtonContent
                        busy={connectingBoard}
                        label={boardAccessConfigured ? "Reconnect" : "Connect board access"}
                        busyLabel="Waiting for approval…"
                      />
                    </button>
                  </div>
                ) : (
                  <div className="ghsync__locked">
                    <div>
                      <strong>Company required</strong>
                      <span>Open a company context to connect board access.</span>
                    </div>
                    <span className="ghsync__badge ghsync__badge--neutral">Unavailable</span>
                  </div>
                )}
              </section>

              <section className="ghsync__section">
                <div className="ghsync__section-head">
                  <div className="ghsync__section-copy">
                    <div className="ghsync__section-title-row">
                      <h4>Project mappings</h4>
                      <span className="ghsync__scope-pill ghsync__scope-pill--company">Company</span>
                    </div>
                    <p>
                      Bind each Mantis project to one Paperclip project for issue sync. Load projects from your Mantis
                      instance or enter a numeric id if the list is unavailable.
                    </p>
                  </div>
                  <span className={`ghsync__badge ${getToneClass(mappingTone)}`}>
                    {mappedCount > 0 ? `${mappedCount} mapped` : "Empty"}
                  </span>
                </div>

                <div className="ghsync__stack">
                  <div className="ghsync__actions">
                    <button
                      type="button"
                      className={getConnectorButtonClassName("secondary")}
                      disabled={submitting || mantisProjects.loading || !registration.data?.mantisTokenConfigured}
                      onClick={() => void mantisProjects.refresh?.()}
                    >
                      {mantisProjects.loading ? (
                        <>
                          <LoadingSpinner size="sm" />
                          Loading Mantis projects…
                        </>
                      ) : (
                        "Refresh Mantis projects"
                      )}
                    </button>
                    {mantisProjects.data && !mantisProjects.data.ok ? (
                      <span className="ghsync__hint ghsync__hint--error">
                        {mantisProjects.data.message ?? "Could not list Mantis projects. Save a valid token and try again."}
                      </span>
                    ) : (
                      <span className="ghsync__hint">
                        Uses your saved Mantis API token. Add URL + token under Mantis access first.
                      </span>
                    )}
                  </div>

                  {rows.length === 0 ? (
                    <p className="ghsync__hint">No mappings yet. Add a row below.</p>
                  ) : (
                    <div className="ghsync__mapping-list">
                      {rows.map((row) => {
                        const mantisLabel =
                          row.mantisProjectName && row.mantisProjectId > 0
                            ? `${row.mantisProjectName} (#${row.mantisProjectId})`
                            : row.mantisProjectId > 0
                              ? `Project #${row.mantisProjectId}`
                              : "New mapping";
                        const selectValue = row.manualMantisId
                          ? MANUAL_MANTIS_ID
                          : row.mantisProjectId > 0
                            ? String(row.mantisProjectId)
                            : "";

                        return (
                          <section key={row.id} className="ghsync__mapping-card">
                            <div className="ghsync__mapping-head">
                              <div className="ghsync__mapping-title">
                                <strong>{mantisLabel}</strong>
                                <span>Mantis ↔ Paperclip binding for issue import.</span>
                              </div>
                              <button
                                type="button"
                                className={getConnectorButtonClassName("danger")}
                                disabled={submitting}
                                onClick={() => removeRow(row.id)}
                              >
                                Remove
                              </button>
                            </div>
                            <div className="ghsync__mapping-grid">
                              <div className="ghsync__field">
                                <label htmlFor={`mantis-pick-${row.id}`}>Mantis project</label>
                                <select
                                  id={`mantis-pick-${row.id}`}
                                  className="ghsync__input ghsync__input--select"
                                  value={selectValue}
                                  disabled={submitting}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    if (v === "" || v === MANUAL_MANTIS_ID) {
                                      setRows((prev) =>
                                        prev.map((r) =>
                                          r.id === row.id
                                            ? {
                                                ...r,
                                                manualMantisId: v === MANUAL_MANTIS_ID,
                                                mantisProjectId:
                                                  v === MANUAL_MANTIS_ID ? r.mantisProjectId || 0 : 0,
                                                mantisProjectName: undefined,
                                              }
                                            : r,
                                        ),
                                      );
                                      return;
                                    }
                                    const pid = Number(v);
                                    const meta =
                                      mantisProjects.data?.ok && "projects" in mantisProjects.data
                                        ? mantisProjects.data.projects.find((p) => p.id === pid)
                                        : undefined;
                                    setRows((prev) =>
                                      prev.map((r) =>
                                        r.id === row.id
                                          ? {
                                              ...r,
                                              manualMantisId: false,
                                              mantisProjectId: pid,
                                              mantisProjectName: meta?.name,
                                            }
                                          : r,
                                      ),
                                    );
                                  }}
                                >
                                  <option value="">Select Mantis project…</option>
                                  {mantisProjects.data?.ok
                                    ? mantisProjects.data.projects.map((p) => (
                                        <option key={p.id} value={String(p.id)}>
                                          {p.name} (#{p.id})
                                        </option>
                                      ))
                                    : null}
                                  <option value={MANUAL_MANTIS_ID}>Custom project ID…</option>
                                </select>
                                {row.manualMantisId ? (
                                  <input
                                    id={`mantis-pid-${row.id}`}
                                    type="number"
                                    min={1}
                                    className="ghsync__input"
                                    style={{ marginTop: "0.5rem" }}
                                    value={row.mantisProjectId > 0 ? row.mantisProjectId : ""}
                                    placeholder="Numeric id"
                                    disabled={submitting}
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      const v = raw === "" ? 0 : Number(raw);
                                      setRows((prev) =>
                                        prev.map((r) =>
                                          r.id === row.id
                                            ? {
                                                ...r,
                                                mantisProjectId: Number.isFinite(v) && v > 0 ? Math.floor(v) : 0,
                                                mantisProjectName: undefined,
                                              }
                                            : r,
                                        ),
                                      );
                                    }}
                                  />
                                ) : null}
                              </div>
                              <div className="ghsync__field">
                                <label htmlFor={`mantis-pc-${row.id}`}>Paperclip project</label>
                                <select
                                  id={`mantis-pc-${row.id}`}
                                  className="ghsync__input ghsync__input--select"
                                  value={row.newPaperclipProjectName.trim() ? "" : row.paperclipProjectId}
                                  disabled={submitting || Boolean(row.newPaperclipProjectName.trim())}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setRows((prev) =>
                                      prev.map((r) =>
                                        r.id === row.id
                                          ? { ...r, paperclipProjectId: v, newPaperclipProjectName: "" }
                                          : r,
                                      ),
                                    );
                                  }}
                                >
                                  <option value="">Select…</option>
                                  {(registration.data?.projects ?? []).map((p) => (
                                    <option key={p.id} value={p.id}>
                                      {p.name}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  id={`mantis-pc-new-${row.id}`}
                                  type="text"
                                  className="ghsync__input"
                                  style={{ marginTop: "0.5rem" }}
                                  value={row.newPaperclipProjectName}
                                  placeholder="Or new Paperclip project name…"
                                  disabled={submitting}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setRows((prev) =>
                                      prev.map((r) =>
                                        r.id === row.id
                                          ? {
                                              ...r,
                                              newPaperclipProjectName: v,
                                              paperclipProjectId: v.trim() ? "" : r.paperclipProjectId,
                                            }
                                          : r,
                                      ),
                                    );
                                  }}
                                />
                                <p className="ghsync__hint">
                                  Pick an existing project or type a name — Save creates or matches it in this company.
                                </p>
                              </div>
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  )}

                  <div className="ghsync__section-footer">
                    <div className="ghsync__button-row">
                      <button
                        type="button"
                        className={getConnectorButtonClassName("secondary")}
                        disabled={submitting}
                        onClick={addRow}
                      >
                        Add mapping
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="ghsync__section">
                <div className="ghsync__section-head">
                  <div className="ghsync__section-copy">
                    <div className="ghsync__section-title-row">
                      <h4>Advanced sync</h4>
                      <span className="ghsync__scope-pill ghsync__scope-pill--company">Company</span>
                    </div>
                    <p className="ghsync__hint" style={{ marginTop: "0.35rem" }}>
                      {advancedSummaryLine}
                    </p>
                  </div>
                  <div className="ghsync__section-head-actions">
                    <span className={`ghsync__badge ${getToneClass(advancedTone)}`}>
                      {advancedTone === "warning" ? "Needs user id" : "Ready"}
                    </span>
                  </div>
                </div>

                <div className="ghsync__stack">
                    <div className="ghsync__field">
                      <label
                        htmlFor="mantis-open-only"
                        style={{
                          display: "flex",
                          gap: "0.6rem",
                          alignItems: "flex-start",
                          cursor: submitting ? "default" : "pointer",
                        }}
                      >
                        <input
                          id="mantis-open-only"
                          type="checkbox"
                          checked={syncOnlyOpenIssues}
                          disabled={submitting}
                          style={{ marginTop: "0.15rem" }}
                          onChange={(e) => setSyncOnlyOpenIssues(e.target.checked)}
                        />
                        <span>
                          <strong>Sync only open issues</strong>
                          <span className="ghsync__hint">
                            {" "}
                            When enabled, skips tickets whose Mantis status contains <strong>closed</strong>,{" "}
                            <strong>resolved</strong>, or <strong>cancel</strong> (case-insensitive; treated as
                            finished or cancelled). <strong>Fixed</strong> is never synced, regardless of this
                            setting.
                          </span>
                        </span>
                      </label>
                    </div>

                    <div className="ghsync__field">
                      <label htmlFor="mantis-assignee-filter">Assignee filter</label>
                      <select
                        id="mantis-assignee-filter"
                        className="ghsync__input ghsync__input--select"
                        value={syncAssigneeFilter}
                        disabled={submitting}
                        onChange={(e) =>
                          setSyncAssigneeFilter(e.target.value as MantisSyncAssigneeFilter)
                        }
                      >
                        {(Object.keys(MANTIS_SYNC_ASSIGNEE_LABELS) as MantisSyncAssigneeFilter[]).map((k) => (
                          <option key={k} value={k}>
                            {MANTIS_SYNC_ASSIGNEE_LABELS[k]}
                          </option>
                        ))}
                      </select>
                      <p className="ghsync__hint">
                        &quot;Assigned to me&quot; uses your Mantis user id from <strong>Validate token</strong>{" "}
                        (<code>/api/rest/users/me</code>).
                        {syncAssigneeFilter === "me" && !mantisAssigneeMeReady ? (
                          <>
                            {" "}
                            <span className="ghsync__hint ghsync__hint--error">
                              Validate token once so Paperclip can record your id.
                            </span>
                          </>
                        ) : null}
                      </p>
                    </div>

                    <div className="ghsync__field">
                      <label htmlFor="mantis-default-pc-status">Default Paperclip status (new imports)</label>
                      <select
                        id="mantis-default-pc-status"
                        className="ghsync__input ghsync__input--select"
                        value={defaultPaperclipStatusDraft}
                        disabled={submitting}
                        onChange={(e) => {
                          const v = e.target.value === "" ? "" : (e.target.value as Issue["status"]);
                          setDefaultPaperclipStatusDraft(v);
                          if (v !== "") {
                            setDefaultAssigneeAgentIdDraft("");
                          }
                        }}
                      >
                        <option value="">From Mantis (mapped automatically)</option>
                        {PAPERCLIP_STATUS_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <p className="ghsync__hint">
                        When set, new Paperclip issues use this workflow status after import (otherwise we mirror Mantis).
                      </p>
                    </div>

                    {defaultPaperclipStatusDraft === "" ? (
                      <div className="ghsync__field">
                        <label htmlFor="mantis-default-pc-agent">Default Paperclip assignee (agent)</label>
                        {paperclipAgentsListError ? (
                          <>
                            <input
                              id="mantis-default-pc-agent"
                              type="text"
                              className="ghsync__input"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="Paste agent id (optional)"
                              value={defaultAssigneeAgentIdDraft}
                              disabled={submitting}
                              onChange={(e) => setDefaultAssigneeAgentIdDraft(e.target.value)}
                            />
                            <p className="ghsync__hint ghsync__hint--error">
                              Could not load agents list ({paperclipAgentsListError}). Enter an agent id manually.
                            </p>
                          </>
                        ) : (
                          <select
                            id="mantis-default-pc-agent"
                            className="ghsync__input ghsync__input--select"
                            value={defaultAssigneeAgentIdDraft}
                            disabled={submitting || paperclipAgentsListLoading}
                            onChange={(e) => setDefaultAssigneeAgentIdDraft(e.target.value)}
                          >
                            <option value="">
                              {paperclipAgentsListLoading ? "Loading agents…" : "Unassigned"}
                            </option>
                            {(() => {
                              const sorted = paperclipAgentsForSelect;
                              const sid = defaultAssigneeAgentIdDraft.trim();
                              const orphan = Boolean(sid) && !sorted.some((a) => a.id === sid);
                              return (
                                <>
                                  {orphan ? (
                                    <option value={sid}>{`${sid.slice(0, 10)}… (saved)`}</option>
                                  ) : null}
                                  {sorted.map((a) => (
                                    <option key={a.id} value={a.id}>
                                      {a.name}
                                    </option>
                                  ))}
                                </>
                              );
                            })()}
                          </select>
                        )}
                        <p className="ghsync__hint">
                          Only applies when new imports use automatic status mapping from Mantis (above). Agents are
                          loaded from Paperclip while you are signed in. Leave unassigned if you do not want a default.
                          Existing issues are not reassigned on later syncs.
                        </p>
                        {!paperclipAgentsListError &&
                        !paperclipAgentsListLoading &&
                        paperclipAgentsForSelect.length === 0 ? (
                          <p className="ghsync__hint">No agents found for this company — create one under Agents first.</p>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="ghsync__field">
                      <label htmlFor="mantis-ignore-reporters">Ignore issues from reporters</label>
                      <textarea
                        id="mantis-ignore-reporters"
                        className="ghsync__input ghsync__textarea"
                        rows={3}
                        value={ignoreReporterNames}
                        disabled={submitting}
                        onChange={(e) => setIgnoreReporterNames(e.target.value)}
                        placeholder="Comma or newline separated."
                      />
                      <p className="ghsync__hint">
                        Skip tickets whose Mantis reporter name matches (case-insensitive). Tokens with 3+ characters also
                        match when contained in the reporter field.
                      </p>
                    </div>
                  </div>
              </section>

              <section className="ghsync__section">
                <div className="ghsync__section-head">
                  <div className="ghsync__section-copy">
                    <div className="ghsync__section-title-row">
                      <h4>Issue sync</h4>
                      <span className="ghsync__scope-pill ghsync__scope-pill--global">Instance</span>
                    </div>
                    <p>
                      Scheduled polling cadence and one-off imports. Separate from Mantis authentication — adjust interval
                      without editing API access above.
                    </p>
                  </div>
                </div>

                <div className="ghsync__field">
                  <label htmlFor="mantis-sync-interval">Sync interval (minutes)</label>
                  <input
                    id="mantis-sync-interval"
                    type="number"
                    min={1}
                    className="ghsync__input"
                    style={{ maxWidth: "8rem" }}
                    value={interval}
                    disabled={submitting}
                    onChange={(e) => setInterval(Number(e.target.value))}
                  />
                  <p className="ghsync__hint">
                    The scheduler runs at most every 5 minutes; this value sets the minimum spacing between sync attempts.
                  </p>
                </div>
              </section>

              <div className="ghsync__section-footer">
                <button type="submit" className={getConnectorButtonClassName("primary")} disabled={submitting}>
                  {submitting ? "Saving…" : "Save settings"}
                </button>
              </div>
            </form>
          )}

          {registration.error ? (
            <div className="ghsync__message ghsync__message--error">{registration.error.message}</div>
          ) : null}
        </section>

        <aside className="ghsync__card">
          <div className="ghsync__card-header">
            <h3>Summary</h3>
            <p>Quick status snapshot</p>
          </div>

          <div className="ghsync__side-body">
            <div className="ghsync__check">
              <div className="ghsync__check-top">
                <strong>Mantis token</strong>
                <span className={`ghsync__badge ${getToneClass(tokenTone)}`}>{mantisSummaryTokenLabel}</span>
              </div>
              <span className="ghsync__hint">
                {mantisIdentityDisplay ? (
                  <>
                    <strong>Mantis API:</strong> {mantisIdentityDisplay}
                    <br />
                  </>
                ) : null}
                {mantisTokenSaved
                  ? "Secret ref is stored in instance config; worker resolves it for REST calls."
                  : validatedPendingSave
                    ? "Validated — use Save settings for mappings and sync interval."
                    : "Enter base URL and token, then Validate token (auto-saves) or Save settings."}
              </span>
            </div>

            <div className="ghsync__check">
              <div className="ghsync__check-top">
                <strong>Paperclip board</strong>
                <span className={`ghsync__badge ${getToneClass(boardAccessTone)}`}>
                  {connectingBoard
                    ? "Connecting"
                    : boardAccessConfigured
                      ? "Connected"
                      : boardAccessRequired
                        ? "Required"
                        : boardAccessRequirement.status === "loading"
                          ? "…"
                          : "Optional"}
                </span>
              </div>
              <span className="ghsync__hint">
                {boardAccessConfigured
                  ? boardAccessIdentity
                    ? `Identity: ${boardAccessIdentity}`
                    : "Company board token stored for worker API calls."
                  : boardAccessRequired
                    ? "Connect so the worker can call Paperclip APIs in this deployment."
                    : "Connect if the health endpoint reports authenticated mode."}
              </span>
            </div>

            <div className="ghsync__check">
              <div className="ghsync__check-top">
                <strong>Mappings</strong>
                <span className={`ghsync__badge ${getToneClass(mappingTone)}`}>
                  {mappedCount > 0 ? `${mappedCount} row${mappedCount === 1 ? "" : "s"}` : "None"}
                </span>
              </div>
              <span className="ghsync__hint">Only mapped Mantis projects are polled for issues.</span>
            </div>

            <div className="ghsync__check">
              <div className="ghsync__check-top">
                <strong>Sync interval</strong>
                <span className="ghsync__badge ghsync__badge--info">{interval} min</span>
              </div>
              <span className="ghsync__hint">Minimum spacing between scheduled sync runs.</span>
            </div>

            <div className="ghsync__check">
              <div className="ghsync__check-top">
                <strong>Last sync run</strong>
                <span className={`ghsync__badge ${getToneClass(syncHealthTone)}`}>
                  {lastSummary ? `${lastSummary.created ?? 0}+${lastSummary.updated ?? 0} Δ` : "—"}
                </span>
              </div>
              <span className="ghsync__hint">
                {syncStatus.data?.lastTrigger
                  ? `Trigger: ${syncStatus.data.lastTrigger}. Completed ${lastRun}.`
                  : "Use “Run sync now” or wait for the scheduler."}
              </span>
            </div>

            {lastSummary && (lastSummary.errors?.length ?? 0) > 0 ? (
              <div className="ghsync__permission-audit ghsync__permission-audit--warning">
                <div className="ghsync__permission-audit-item">
                  <strong>Recent sync warnings</strong>
                  <span>{(lastSummary.errors ?? []).slice(0, 3).join(" · ")}</span>
                </div>
              </div>
            ) : null}

            <div className="ghsync__detail-list">
              <div className="ghsync__detail">
                <span className="ghsync__detail-label">Last saved</span>
                <strong className="ghsync__detail-value">{lastSaved}</strong>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
