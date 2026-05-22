# docs (stable branch)

This is a minimal placeholder Next.js app that lives on the `stable` branch
only. The real docs site is maintained on `main` and deployed from there.

The purpose of the stub is twofold:

1. Keep the `Vercel – workflow-docs` deploy check green on PRs targeting
   `stable` (the Vercel project has `docs/` as its root directory).
2. Keep the `prebuild` pack script (`scripts/pack.ts`), which publishes
   per-deployment package tarballs under the preview URL so that pre-release
   builds of the SDK can be installed against backport PRs for testing.

`docs/content/` is the canonical markdown bundled into npm packages via their
`prepack` scripts — do not remove it.

Do not grow this stub into a real app. The backport workflow auto-resolves any
cherry-pick conflict under `docs/` (outside `docs/content/`) by deleting the
conflicting file, so files here are disposable by design.
