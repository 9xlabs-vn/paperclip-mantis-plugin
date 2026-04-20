import { createRequire } from "node:module";

import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };
const SCHEDULE_TICK_CRON = "*/5 * * * *";
const MANIFEST_VERSION =
  process.env.PLUGIN_VERSION?.trim()
  || (typeof packageJson.version === "string" && packageJson.version.trim())
  || process.env.npm_package_version?.trim()
  || "0.1.0";

// Published @paperclipai/plugin-sdk types may lag behind the host; `issue.attachments.create`
// is valid at runtime on current Paperclip hosts but not always in the npm type union yet.
const manifest = {
  id: "paperclip-mantis-plugin",
  apiVersion: 1,
  version: MANIFEST_VERSION,
  displayName: "Mantis Sync",
  description: "Synchronize MantisBT issues into Paperclip projects.",
  author: "9xLabs",
  categories: ["connector", "ui"],
  capabilities: [
    "instance.settings.register",
    "plugin.state.read",
    "plugin.state.write",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "issue.attachments.create",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "ui.action.register",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      mantisBaseUrl: {
        type: "string",
        title: "Mantis base URL",
        description: "Root URL of your MantisBT instance (e.g. https://bugs.example.com/mantis).",
      },
      mantisTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Mantis API token secret",
        description:
          "Paperclip secret reference for a Mantis API token (generated under My Account → API Tokens).",
      },
      lastMantisApiIdentity: {
        type: "string",
        title: "Last validated Mantis user",
        description: "Display label from the last successful token validation (informational only).",
      },
      syncIntervalMinutes: {
        type: "number",
        title: "Sync interval (minutes)",
        description: "Minimum wall-clock spacing between scheduled sync attempts (default 15).",
      },
      paperclipBoardApiTokenRefs: {
        type: "object",
        title: "Paperclip Board Token Secrets",
        description:
          "Optional per-company secret references for Paperclip REST access when extending this connector.",
        additionalProperties: { type: "string" },
      },
      paperclipApiBaseUrl: {
        type: "string",
        title: "Trusted Paperclip API Origin",
        description:
          "Optional origin for callbacks into Paperclip when using board token integrations (future use).",
      },
    },
  },
  jobs: [
    {
      jobKey: "sync.mantis-issues",
      displayName: "Sync Mantis issues",
      description: "Polls Mantis and imports or updates mapped Paperclip issues on the configured cadence.",
      schedule: SCHEDULE_TICK_CRON,
    },
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "paperclip-mantis-plugin-settings",
        displayName: "Mantis Sync",
        exportName: "MantisConnectorSettingsPage",
      },
      {
        type: "toolbarButton",
        id: "mantis-sync-project-toolbar",
        displayName: "Mantis Sync",
        exportName: "MantisProjectToolbarButton",
        entityTypes: ["project"],
        order: 0,
      },
    ],
  },
} as PaperclipPluginManifestV1;

export default manifest;
