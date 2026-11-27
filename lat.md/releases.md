# Versioning & release strategy

This repository uses a dual-branch release model with [changesets](https://github.com/changesets/changesets) for version management.

## Branch model

Release branches select the supported version line and npm dist-tag.

- **`main`**: Current GA line (5.x). Changesets are in regular mode; published packages get the `latest` npm dist-tag (e.g. `5.0.0`). `main` re-enters pre-release mode only while a new major is baking, and publishes `beta`/`rc` dist-tags for as long as it stays there.
- **`stable`**: 4.x maintenance line. Changesets are in regular mode; published packages get the `previous` npm dist-tag (`ci:publish` passes `--tag previous`), so a 4.x patch never moves `latest` off 5.x. The tag is not version-numbered because npm rejects tag names that parse as a semver range (`v4`, `4.x`).

Before 5.0.0 this was inverted: `main` was the beta channel and `stable` owned `latest`. The `stable` side of the flip is a separate commit on that branch; see "Retiring a major" below for the order the two have to land in.

Both branches trigger the release workflow ([[.github/workflows/release.yml|`.github/workflows/release.yml`]]) on push. The changesets action creates a "Version Packages" PR on each branch when there are pending changesets.

**Important:** Some directories are not fully maintained on the `stable` branch:

- **[[docs/|`docs/`]]**: Only [[docs/content/|`docs/content/`]] is actively maintained on `stable`; the rest of the docs app is a minimal placeholder (documentation is deployed only from `main`). [[docs/content/|`docs/content/`]] is kept on `stable` because the markdown files are bundled into npm packages via `prepack` scripts.
- **[[skills/|`skills/`]]**: Not maintained on `stable` at all. Skill files are unrelated to npm packaging, so there is no reason to keep them in sync on the release branch.

When backporting changes to `stable`, any conflicts involving docs app files (outside of [[docs/content/|`docs/content/`]]) or [[skills/|`skills/`]] files should be resolved by keeping the `stable` branch version (discarding the incoming change from `main`). Conflicts in [[docs/content/|`docs/content/`]] should be resolved normally. The backport GitHub Action handles this automatically.

### The `changeset-release/main` branch is never deployed

Every Vercel project rooted in this repo sets `git.deploymentEnabled` to `false` for `changeset-release/main` in its `vercel.json`. **When you add a new Vercel project, add that key to its `vercel.json` too.**

The changesets action force-pushes `changeset-release/main`, and it can point at exactly main's HEAD SHA. Vercel keeps one commit status per project per SHA, so a preview deployment of that branch overwrites the production deployment's status for the same commit. Resolving the deployment ID from that status can then hand a production e2e run a preview deployment ID, forking the run across environments.

Because those PRs have no deployment of their own, CI treats them specially: the Vercel e2e lanes in `tests.yml` use [[.github/actions/resolve-vercel-deployment/resolve.js|`.github/actions/resolve-vercel-deployment/resolve.js`]], whose [[.github/actions/resolve-vercel-deployment/resolve.js#resolveTarget|`resolveTarget`]] selects the base commit's production deployment for `changeset-release/*` PRs. They therefore test main's production deployment and run as `production`. The deployment-dependent jobs in `docs-checks.yml`, `tarballs-checks.yml`, and `benchmarks.yml` are skipped. Anything new that waits on a deployment needs the same treatment.

## Changesets

Every PR requires a changeset describing the changed packages or an empty documentation changeset.

- `workflow`, `@workflow/core`, and `@workflow/world-vercel` use changesets' "fixed" versioning strategy, so they always have the same version number. A changeset touching only one of the three still republishes all of them, and the other two get a `No changes in this release.` changelog section.
  - `@workflow/world-vercel` joined the group at 5.0.0. `@workflow/core` already depended on it (`"@workflow/world-vercel": "workspace:*"`, published as an exact pin), so a world-vercel release always dragged core along; nothing pulled the other way, and the adapter drifted five betas behind by 5.0.0. Since the adapter reports its own version to the backend ([[packages/world-vercel/src/telemetry.ts#WorkflowClientVersion|`WorkflowClientVersion`]] in [[packages/world-vercel/src/events-v4.ts|`packages/world-vercel/src/events-v4.ts`]]), that drift made the reported version ambiguous.
  - The other worlds (`@workflow/world`, `@workflow/world-postgres`, `@workflow/world-local`) are deliberately **not** in the group. They version independently and are expected to drift from the SDK version.
- Every PR requires a changeset to be included before it will be merged
- Use `pnpm changeset status --since=main` to inspect the release plan; a successful status command does not waive the every-PR changeset requirement.
- Create a changeset using `pnpm changeset add`
  - All changed packages should be included in the changeset. Never include unchanged packages.
  - Never list a package from the `ignore` array in [[.changeset/config.json|`.changeset/config.json`]] (private workbench and simulation packages such as `@workflow/world-sim`), even when the PR changes it. Changesets rejects a changeset that mixes ignored and published packages, and the failure only surfaces in the Release job on `main`. `node scripts/check-changesets.mjs` runs that validation locally; CI runs it in `lint.yml`.
  - Use the correct semver bump type: `patch` for bug fixes, `minor` for new features, `major` for breaking changes
  - The bump type determines the released version on both branches. While `main` is in pre-release mode it only increments `beta.N`, but the type is still recorded and applies when pre mode exits and when changes are backported to `stable`
- Remember to always build any packages that get changed before running downstream tests like e2e tests in the workbench
- Remember that changes made to one workbench should propagate to all other workbenches. The workflows should typically only be written once inside the example workbench and symlinked into all the other workbenches
- When writing changesets (via `pnpm changeset add` from the repo root, as noted above), keep the description terse: one sentence, or two at most. Try to make changesets that are specific to each modified package so they are targeted.

## Backporting to `stable`

Backports are handled by a GitHub Action ([[.github/workflows/backport.yml|`.github/workflows/backport.yml`]]) that runs on every push to `main`.

For each commit, AI analyzes the change and decides whether to recommend a backport. The action **always opens a PR** against `stable` for human review; it never pushes directly. The changeset file is included in the cherry-pick, so the correct semver bump type is preserved on `stable`.

**Decision criteria.** `stable` is a maintenance branch and takes **stability fixes only**. Feature work stays on `main`, however small or cleanly it would cherry-pick. AI is instructed to recommend a backport only for:

- Bug fixes to functionality that already exists on `stable`
- Correctness, data-loss, crash, hang, deadlock, and resource-leak fixes
- Security fixes, including dependency bumps that address a known vulnerability
- Fixes for regressions introduced by an earlier backport
- Test-only changes covering behavior that also exists on `stable`, and flaky-test fixes
- Build/CI/release-plumbing fixes needed to keep `stable` buildable and releasable
- Documentation corrections for content already on `stable` (fixing what's wrong, not documenting new capabilities)

AI is told to recommend AGAINST backporting anything else: new features and feature enhancements (including small, self-contained, additive ones), performance work and refactors that aren't fixing a user-visible defect, non-defect behavior changes to existing APIs, changes that build on `main`-only APIs, breaking changes for the next major, routine non-security dependency bumps, changes confined to directories not maintained on `stable` (the [[docs/|`docs/`]] app outside [[docs/content/|`docs/content/`]], and [[skills/|`skills/`]]), and release plumbing like changeset/version-bump commits. Commits mixing a fix with feature work are declined, with the fix identified in the reasoning so a human can split it out.

When in doubt, AI is told to decline: a missed fix can be forced through later via `workflow_dispatch`, while unwanted change on `stable` costs its users the stability they stayed behind for.

**Manual override.** The workflow can be run manually from the GitHub Actions UI via `workflow_dispatch`, which accepts an optional `ref` input (a commit SHA on `main`; defaults to `main` HEAD) and an optional `model` input (the AI model used for AI-assisted decisions and conflict resolution, in `<provider>/<model>` form; defaults to the workflow's current default). Manual dispatch always forces a backport (skipping AI analysis). Use this when AI declined a backport that you want to ship to `stable`.

**No-backport notification.** When AI decides against a backport, it leaves a comment on the source PR (if one is associated with the commit) explaining its reasoning, with instructions for forcing a backport via `workflow_dispatch`.

**Conflict handling.** If the cherry-pick fails due to conflicts, the action first auto-resolves conflicts in directories that are not maintained on `stable` (docs app files under [[docs/|`docs/`]] except [[docs/content/|`docs/content/`]], and any files under [[skills/|`skills/`]]) by keeping the `stable` branch version. It also auto-resolves `pnpm-lock.yaml` conflicts by re-running `pnpm install`. Any remaining conflicts are resolved using [opencode](https://opencode.ai) (AI-powered conflict resolution); the resulting backport PR notes that conflicts were AI-resolved and must be reviewed carefully. If AI cannot resolve the conflicts, the action comments on the original PR with instructions for manual resolution.

## Pre-release lifecycle

`main` is **not** in pre-release mode today — it ships GA 5.x versions straight to the `latest` dist-tag.

The steps below apply when baking the next major, at which point `main` uses changesets' [pre-release mode](https://github.com/changesets/changesets/blob/main/docs/prereleases.md) to publish beta versions.

Changesets that a "Version Packages (beta)" merge has already turned into a beta live in `.changeset/pre/` (changesets v3 keeps them there instead of listing their ids in `pre.json`, which now holds only `mode` and `tag`). Only the `.md` files directly under [[.changeset/|`.changeset/`]] are pending. Do not edit or delete anything under `.changeset/pre/`: those files become the final stable release's changelog when pre mode exits.

**Starting a new pre-release cycle:**
1. Create a changeset with the desired base bump (e.g. `major` for a new major version)
2. Enter pre-release mode: `pnpm changeset pre enter beta`
3. Merge the "Version Packages (beta)" PR to publish the first beta

**Publishing subsequent betas:**
- Merge PRs with changesets to `main` as normal
- Each "Version Packages (beta)" PR merge publishes the next `beta.N` increment

**Graduating to GA:**
1. (Optional) Transition to release candidates: `pnpm changeset pre enter rc` (publishes `X.Y.Z-rc.N`)
2. Exit pre-release mode: `pnpm changeset pre exit`
3. The next "Version Packages" PR will publish the final GA version to npm under the `latest` dist-tag. That PR is enormous — exiting pre mode consumes every `.changeset/pre/*.md` at once, so it deletes hundreds of files and rewrites every CHANGELOG. Review it for *shape* (version bumps and changelogs only, nothing else touched), not line by line.
4. Retire the outgoing major — see below.

Note that between the `pre exit` merge and the "Version Packages" merge, `main` cannot cut another beta: the pending changesets all belong to the GA release now. Do not exit pre mode until you intend to ship GA promptly. Throughout that window the manifests on `main` are still `5.0.0-beta.N` — `pre exit` bumps nothing, it only flips `.changeset/pre.json` to `{"mode": "exit"}` so the next `changeset version` writes GA versions and deletes the file. Anything that keys off the release channel has to treat exit mode as still-a-prerelease for that reason; [[scripts/check-published.mjs|`scripts/check-published.mjs`]] does.

## Retiring a major

When a new major takes over `latest`, the outgoing major moves to a maintenance branch (`stable`) and needs its own dist-tag so its patches never reclaim `latest`:

- Pin the maintenance branch's `ci:publish` to that tag: `changeset publish --tag previous`. The tag must not parse as a semver range — npm rejects `v4` and `4.x` (`Tag name must not be a valid SemVer range`), which is why it is `previous` and not version-numbered.
- Pass the same tag to the publication check: `node scripts/check-published.mjs --tag previous`. That script defaults to the tag in `.changeset/pre.json` when that file exists and `latest` otherwise, so on a maintenance branch — which is in regular mode and has no `pre.json` — it would otherwise assert that `latest` points at the version just published and fail every release.

**Order matters, and getting it wrong is a user-visible regression.** The maintenance branch must keep publishing to `latest` right up until the new major's GA actually lands on npm. Pinning it to `previous` early does not "leave `latest` where it is" — it *freezes* `latest` at the last release before the pin, so `npm install workflow` silently stops picking up maintenance patches. This happened once: #3091 pinned 4.x to `previous` on 2026-07-24 while 4.x was still the GA line, and #3168 reverted it four days later, about three hours before `4.7.0` would have shipped without moving `latest`. Land the maintenance-branch pin **after** the new major's GA publish, not before.
