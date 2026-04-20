# paperclip-mantis-plugin

Synchronize MantisBT issues into Paperclip projects, including:

- issue create/update
- comment import (Mantis notes -> Paperclip comments)
- attachment import (Mantis files -> Paperclip issue attachments)
- scheduled sync + manual sync from the project toolbar button

## Requirements

- Node.js 22+
- pnpm 9+
- A running Paperclip instance
- A Mantis API token stored as a Paperclip secret

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev      # watch worker + manifest + UI bundles
pnpm dev:ui   # local plugin UI dev server
```

## Install into Paperclip (local path)

After `pnpm build`, install with local package path:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip-mantis-plugin","isLocalPath":true}'
```

Example:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/Users/norashing/Documents/Work/paperclip/plugins/paperclip-mantis-plugin","isLocalPath":true}'
```

## Configuration in Paperclip

Open **Mantis Sync** in plugin settings and configure:

1. `mantisBaseUrl`: Base URL of your Mantis instance
2. `mantisTokenRef`: Paperclip secret ref that stores a Mantis API token
3. `syncIntervalMinutes`: Schedule interval for background sync
4. Project mappings: map Mantis project IDs to Paperclip projects

Optional per-company advanced sync:

- sync only open issues
- assignee filter (`any`, `unassigned`, `me`)
- default Paperclip status for imported/updated issues
- default assignee agent
- ignored reporter names

## Release and publish

This package is publishable as `@9xlabs/paperclip-mantis-plugin`.

- `prepublishOnly`: runs typecheck + tests
- `prepack`: builds distributable bundles
- published files: `dist/`, `README.md`

GitHub Actions publish workflow:

- file: `.github/workflows/publish.yml`
- triggers: manual (`workflow_dispatch`) or GitHub Release `published`
- requires repo secret: `NPM_TOKEN`
- publishes with: `pnpm publish --access public`

## Troubleshooting

- **No comments/attachments imported**: verify plugin capabilities in manifest and re-install plugin if capabilities changed.
- **Mantis API access errors (401/403)**: recheck token secret value and project-level permissions in Mantis.
- **Sync ran but no issue updates**: validate project mappings and assignee/open-issue filters in settings.
- **Attachment not viewable**: verify content type and filename/header handling on Paperclip server.
