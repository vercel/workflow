#!/usr/bin/env bash
#
# clean-artifacts.sh — scrub every gitignored build artifact so the workspace
# rebuilds from a pristine state. Run it after switching branches (or whenever
# the repo is behaving strangely); see "Why this exists" below.
#
# Usage:
#   pnpm clean:artifacts             # remove ignored artifacts, keep node_modules
#   pnpm clean:artifacts --dry-run   # print what would be removed
#   pnpm clean:artifacts --all       # also remove node_modules and the
#                                    # Cargo target/ dir (slower reinstall +
#                                    # Rust rebuild, but maximally pristine)
#
# Why this exists
# ---------------
# Build outputs (`packages/*/dist`, generated sources like
# `src/version.ts` / `quickjs-assets.generated.ts`, `tsc` incremental state,
# the Turbo cache, workbench state like `.next` / `.svelte-kit` / `.output`)
# are all gitignored, so they SURVIVE `git checkout` across branches whose
# layouts disagree — main vs stable, or any two branches spanning a
# refactor. The mismatched leftovers then wedge the repo in ways that look
# like unrelated breakage:
#
#   * `pnpm install` hangs or errors: workbench `prepare` scripts (e.g.
#     sveltekit's `svelte-kit sync`) load vite configs that resolve
#     `workflow` to a stale `packages/workflow/dist`, whose imports no
#     longer match the checked-out `package.json` exports map
#     ("Could not resolve \"workflow/internal/private\""), or compile the
#     checked-out workflows with a stale SWC plugin build that predates
#     their syntax ("Functions marked with \"use step\" must be async").
#   * `tsc` builds fail on generated files from the other branch (e.g.
#     `quickjs-assets.generated.ts` on a branch without QuickJS), or emit
#     nothing because a stale `.tsbuildinfo` claims outputs are fresh.
#   * Worst: a build that RUNS while dist is polluted lets Turbo capture
#     the polluted dist as that task's cached outputs — after which the
#     cache faithfully restores the pollution on every rebuild, and no
#     amount of `rm -rf dist` alone fixes it.
#
# Design notes
# ------------
# The candidate list comes from `git ls-files -o -i --exclude-standard
# --directory` — i.e. ONLY files git ignores. Untracked-but-not-ignored
# files (your work in progress) are never touched. `git clean -x` was
# deliberately avoided (it removes untracked files too), and so was
# `git clean -X -e <pattern>` (exclude patterns modify the ignore rules,
# which under -X can ADD to the removal set instead of protecting —
# negations leak into subdirectories). Filtering a listing in shell is
# boring and predictable.
#
# What is deliberately KEPT:
#   * node_modules   — reinstall is slow and pnpm's store makes staleness
#                      here rare (pass --all when you want it gone too);
#                      note the Turbo cache lives at .turbo/, which IS
#                      removed.
#   * .env*, *.local — local secrets/config (e.g. VERCEL_OIDC_TOKEN pulled
#                      via `vercel env pull`).
#   * .vercel        — Vercel project links; losing them forces relinking.
#   * target/        — Cargo's build cache; unlike the JS tooling above,
#                      Cargo fingerprints inputs correctly across branch
#                      switches, and a cold Rust rebuild of the SWC plugin
#                      costs minutes (pass --all to remove it anyway).
#   * .opencode, .claude, .agents — local agent tooling state.
set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=0
ALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run | -n) DRY_RUN=1 ;;
    --all) ALL=1 ;;
    --help | -h)
      sed -n '2,66p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

# Whether an ignored path should be preserved. Paths are repo-relative,
# directories carry a trailing slash (--directory).
keep() {
  local p="${1%/}"
  case "$p" in
    # Local secrets/config.
    .env* | */.env* | *.local) return 0 ;;
    # Vercel project links.
    .vercel | */.vercel | .vercel/* | */.vercel/*) return 0 ;;
    # Local agent tooling state.
    .opencode | .opencode/* | .claude | .claude/* | .agents | .agents/*) return 0 ;;
  esac
  if [[ "$ALL" -ne 1 ]]; then
    case "$p" in
      node_modules | node_modules/* | */node_modules | */node_modules/*) return 0 ;;
      target | target/* | */target | */target/*) return 0 ;;
    esac
  fi
  return 1
}

removed=0
kept=0
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if keep "$path"; then
    kept=$((kept + 1))
    continue
  fi
  # A parent directory earlier in the listing may have removed it already.
  [[ -e "$path" || -L "$path" ]] || continue
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Would remove $path"
  else
    echo "Removing $path"
    rm -rf -- "$path"
  fi
  removed=$((removed + 1))
done < <(git ls-files -o -i --exclude-standard --directory)

echo
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run — nothing removed ($removed candidates, $kept kept). Re-run without --dry-run to clean."
else
  echo "Cleaned $removed artifacts ($kept kept). Next steps:"
  echo '  pnpm install'
  echo '  pnpm build'
fi
