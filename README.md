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

The published plugin entrypoint is `dist/backend/worker.js`, described by `bonobo.plugin.json` and `dist/bonobo.artifact.json`.
