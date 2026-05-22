# docs (stable branch)

This is a minimal placeholder Next.js app that lives on the `stable` branch
only. The real docs site is maintained on `main` and deployed from there.

The stub exists to keep the docs Vercel deploy check green on PRs targeting
`stable` — the corresponding Vercel project has `docs/` as its root directory.

`docs/content/` is the canonical markdown bundled into npm packages via their
`prepack` scripts (see `packages/{workflow,core,next,ai}/package.json`) — do
not remove it.

Per-deployment SDK tarballs are no longer built from this project; they are
served by the separate `tarballs/` app. See `tarballs/README.md` for details.

Do not grow this stub into a real app. The backport workflow auto-resolves any
cherry-pick conflict under `docs/` (outside `docs/content/`) by deleting the
conflicting file, so files here are disposable by design.
