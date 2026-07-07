# Bonobo Image Plugin

First-party Bonobo workspace plugin for generating Markdown descriptions for uploaded images.

On `files.upload.completed` for `image/jpeg`, `image/png`, `image/webp`, or `image/gif`, the worker requests a temporary URL for the uploaded image, asks OpenAI `gpt-4.1-mini` to describe it (main subjects, visible text, colors, layout), and writes `<name>.description.md` next to the upload.

## Secrets

- `OPENAI_API_KEY` (required). By default the publisher secret is used, so the publisher's OpenAI account processes the images of every workspace that installs the plugin. A workspace can shadow it with an installation secret of the same name to process its images on its own OpenAI account.

## Outbound origins

- `https://api.openai.com`

## Checks

```powershell
pnpm run check
pnpm run test
```

The published plugin entrypoint is `dist/backend/worker.js`, described by `dist/bonobo.plugin.json`.

## Release

1. Bump `version` in `bonobo.plugin.json`.
2. Run `pnpm build:manifest` — recomputes the `files[]` hashes from disk, syncs the `package.json` version, and byte-copies the manifest to `dist/bonobo.plugin.json`.
3. Commit and push.
4. Publish the new version from the app's plugin publisher page.
