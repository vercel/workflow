# tarballs

Static Vercel project that builds and serves preview tarballs for every public package in `packages/*`.

For each public package, `scripts/pack.ts`:

1. Rewrites the package version to `<version>-<git-sha>` and rewrites every workspace dependency to a tarball URL on the current Vercel deployment (`https://$VERCEL_URL/<escaped-name>.tgz`).
2. Runs `pnpm pack` and writes the result to `public/<escaped-name>.tgz`.
3. Restores the original `package.json`.

The deployment serves the resulting `*.tgz` files at the root of the project URL — e.g. `https://<deployment>.vercel.sh/workflow.tgz`.

This is used for pre-release testing of `vercel/workflow` PRs by installing tarballs directly:

```json
{
  "dependencies": {
    "workflow": "https://<deployment>.vercel.sh/workflow.tgz"
  }
}
```
