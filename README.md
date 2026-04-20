# @9xlabs/paperclip-mantis-plugin

MantisBT connector plugin for [Paperclip](https://github.com/paperclipai/paperclip).

**This repository** is the 9xLabs–maintained home for the package (source, release, CI). The Paperclip **core** app and monorepo are upstream and are **not** developed here—install this plugin into any compatible Paperclip instance via npm or a local path.

This plugin helps operators:

- connect a Paperclip instance to MantisBT using API token validation (secret ref),
- map Mantis projects to Paperclip projects,
- import and update Paperclip issues from Mantis (title, description, status where applicable),
- import Mantis notes as Paperclip issue comments,
- import Mantis attachments as Paperclip issue attachments when the API returns inline file content,
- run scheduled sync (`sync.mantis-issues`) plus manual sync from the project toolbar.

## What this plugin includes

- Worker + UI entrypoints (`src/worker.ts`, `src/ui/index.tsx`)
- **Mantis Sync** settings page (base URL, token ref, mappings, advanced per-company options)
- Project **toolbar** action for on-demand sync
- Scheduled job: `sync.mantis-issues` (default poll cadence; respects configured sync interval in plugin state)
- No separate agent tool surface in v1—the value is **sync + UI**; agents are unaffected unless you extend the package later.

## Requirements

- Paperclip runtime with plugin support
- MantisBT **REST API** access and a **Personal Access Token** (or equivalent API token) stored as a Paperclip **secret ref** (`mantisTokenRef`)
- Network path from the Paperclip host to your Mantis base URL (the host’s outbound HTTP rules apply)
- For attachment import: the host must allow `issue.attachments.create` for this plugin manifest; very old Paperclip builds without plugin attachments may not support file upload from workers

## Development

Clone this repo (not the full Paperclip monorepo). Dependencies resolve from the public npm registry (`@paperclipai/plugin-sdk`, etc.).

```bash
pnpm install
pnpm dev
pnpm dev:ui
pnpm test
```

Useful commands:

```bash
pnpm typecheck
pnpm build
pnpm build:rollup
```

## Install into local Paperclip

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip-mantis-plugin","isLocalPath":true}'
```

Or from the CLI (with `PAPERCLIP_API_URL` pointing at your instance):

```bash
pnpm paperclipai plugin install /absolute/path/to/paperclip-mantis-plugin --local
```

From npm (after publish):

```bash
pnpm paperclipai plugin install @9xlabs/paperclip-mantis-plugin
```

## Configuration flow

1. Open Paperclip → **Settings** → **Plugins** → **Mantis Sync**
2. Set **`mantisBaseUrl`** (root URL of your Mantis instance)
3. Validate and save **`mantisTokenRef`** (Paperclip secret reference for the Mantis API token)
4. Add **project mappings**: Mantis project → Paperclip project (per company)
5. Optionally tune **`syncIntervalMinutes`** and per-company advanced options (open-only, assignee filter, default status/agent, ignored reporters)
6. Save settings; the scheduled job and toolbar action will use the resolved configuration

## Upgrading

Paperclip exposes **`POST /api/plugins/:pluginId/upgrade`** (instance admin) for npm upgrades; the board UI may surface the same flow. You can also install a newer npm version explicitly:

```bash
pnpm paperclipai plugin install @9xlabs/paperclip-mantis-plugin@<version>
```

Because npm **forbids re-publishing the same version**, each release needs a **new semver** in `package.json`.

## npm release

Package: `@9xlabs/paperclip-mantis-plugin`

Workflow: `.github/workflows/publish.yml`

- Trigger: GitHub Release `published` or manual `workflow_dispatch`
- Required repo secret: `NPM_TOKEN`
- Publish command:

```bash
pnpm publish --no-git-checks --access public --registry https://registry.npmjs.org/
```

Prepublish validation:

```bash
pnpm prepublishOnly
```

Which runs:

```bash
pnpm typecheck && pnpm test
```

`prepack` runs `pnpm build` to emit `dist/` before the tarball is packed.

## Troubleshooting

- **Sync does nothing**: confirm project mappings exist and the Mantis token is valid for the projects you mapped.
- **Notes import but attachments do not**: Mantis must return **inline base64** content for files in the REST payload; if the API omits it, the plugin logs a skip and cannot import that file.
- **Capability / upgrade errors after a Paperclip upgrade**: reinstall or upgrade this package so the manifest matches host expectations (`issue.attachments.create`, etc.).
