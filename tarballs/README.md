# tarballs

Static Vercel project that builds and serves preview tarballs for every public package in `packages/*`.

For each public package, `scripts/pack.ts`:

1. Rewrites the package version to `<version>-<git-sha>` and rewrites every workspace dependency to a tarball URL on the current Vercel deployment (`https://$VERCEL_URL/<escaped-name>.tgz`).
2. Runs `pnpm pack` and writes the result to `public/<escaped-name>.tgz`.
3. Restores the original `package.json`.

It also generates a `public/index.html` that lists every published package alongside a copyable `pnpm i …` command, so the bare deployment URL is itself useful when shared.

The deployment serves the resulting `*.tgz` files at the root of the project URL — e.g. `https://<deployment>.vercel.sh/workflow.tgz`.

This is used for pre-release testing of `vercel/workflow` PRs by installing tarballs directly:

```json
{
  "dependencies": {
    "workflow": "https://<deployment>.vercel.sh/workflow.tgz"
  }
}
```

The Vercel project must be configured to be **publicly accessible** (no Deployment Protection on previews or production) so that `pnpm`/`npm` can fetch tarball URLs from third-party projects. The smoke check (`scripts/check-tarballs-smoke.mjs`) verifies this on every deployment and fails loudly if the deployment is behind a login redirect.
