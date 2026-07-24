import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import ignore, { type Ignore } from 'ignore';

/**
 * Directory-name fragments that are always excluded from the dev watcher,
 * regardless of `.gitignore`. Matched as POSIX substrings of the absolute
 * path (e.g. `/node_modules/` matches any path containing that segment).
 */
export const BUILTIN_IGNORED_PATH_FRAGMENTS: readonly string[] = [
  '/.git/',
  '/node_modules/',
  '/.next/',
  '/.turbo/',
  '/.vercel/',
  '/dist/',
  '/build/',
  '/out/',
  '/.cache/',
  '/.yarn/',
  '/.pnpm-store/',
  '/.parcel-cache/',
  '/.well-known/workflow/',
];

/**
 * Environment variable that lets a project add extra path fragments to the
 * dev watcher ignore list. Comma-separated; each entry is matched as a POSIX
 * substring of the absolute path, exactly like {@link BUILTIN_IGNORED_PATH_FRAGMENTS}.
 * Additive to `.gitignore` and the built-in list. Dev-mode only.
 */
export const WATCH_IGNORED_PATHS_ENV = 'WORKFLOW_DEV_WATCH_IGNORED_PATHS';

const toPosix = (pathname: string) => pathname.replace(/\\/g, '/');

/**
 * Parse the comma-separated {@link WATCH_IGNORED_PATHS_ENV} value into a list
 * of POSIX path fragments. Whitespace is trimmed and empty entries dropped.
 */
export function parseIgnoredPathsEnv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => toPosix(entry.trim()))
    .filter((entry) => entry.length > 0);
}

interface GitignoreMatcher {
  /** POSIX absolute directory the `.gitignore` lives in (no trailing slash). */
  dir: string;
  matcher: Ignore;
}

/**
 * Load `.gitignore` matchers for `workingDir` up to and including
 * `projectRoot`. In a monorepo the largest ignored trees are typically listed
 * at the workspace root, and app-level `.gitignore` files are covered too.
 *
 * Returned outermost-first (workspace root → app), which is the order git
 * applies them: a rule in a deeper `.gitignore` overrides a conflicting rule
 * from a shallower one.
 *
 * Nested `.gitignore` files *below* `workingDir` are intentionally not read —
 * the {@link WATCH_IGNORED_PATHS_ENV} env var backstops anything they'd cover.
 *
 * Known deviation from git: a deeper file can re-include an individual path
 * (`!keep.log`), but it cannot re-include the *contents* of a directory its
 * parent excluded (root `generated/` + app `!generated/` leaves
 * `app/generated/x.ts` pruned, where git would watch it). Matching git there
 * requires its per-directory-entry walk; `ignore` re-claims nested paths for
 * a directory pattern. Use {@link WATCH_IGNORED_PATHS_ENV}'s counterpart —
 * narrowing the parent rule — if you hit this.
 */
function loadGitignoreMatchers(
  workingDir: string,
  projectRoot: string
): GitignoreMatcher[] {
  const matchers: GitignoreMatcher[] = [];
  const stopAt = toPosix(projectRoot);

  let current = toPosix(workingDir);
  while (true) {
    let content: string | undefined;
    try {
      content = readFileSync(posix.join(current, '.gitignore'), 'utf-8');
    } catch {
      content = undefined;
    }
    if (content) {
      matchers.push({ dir: current, matcher: ignore().add(content) });
    }

    if (current === stopAt) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Collected innermost-first while walking up; git precedence is
  // outermost-first, with deeper files winning.
  return matchers.reverse();
}

export interface WatchIgnoreOptions {
  /** Absolute path of the app directory being built. */
  workingDir: string;
  /** Absolute path of the workspace/project root. Defaults to `workingDir`. */
  projectRoot?: string;
  /**
   * Extra POSIX substring fragments to ignore, in addition to the built-in
   * list and the {@link WATCH_IGNORED_PATHS_ENV} env var. Used by the caller
   * for build-time paths such as the generated workflow directory.
   */
  extraFragments?: string[];
  /**
   * Override for the {@link WATCH_IGNORED_PATHS_ENV} env var. Primarily for
   * testing; defaults to `process.env[WATCH_IGNORED_PATHS_ENV]`.
   */
  envIgnoredPaths?: string;
}

/**
 * Build the dev-watcher ignore predicate. The returned function receives a
 * POSIX-normalized absolute path and returns `true` when that path should be
 * pruned from both the initial directory walk and the chokidar watch set.
 *
 * A path is ignored when it matches any of:
 * - a built-in fragment ({@link BUILTIN_IGNORED_PATH_FRAGMENTS}) or caller
 *   `extraFragments` (POSIX substring match),
 * - a {@link WATCH_IGNORED_PATHS_ENV} fragment (POSIX substring match),
 * - a `.gitignore` rule from `workingDir` up to `projectRoot`.
 *
 * Matchers are built once here; the returned predicate is hot (called per path
 * during traversal and per chokidar event) and does no I/O.
 */
export function createWatchIgnorePredicate(
  options: WatchIgnoreOptions
): (normalizedPath: string) => boolean {
  const projectRoot = options.projectRoot ?? options.workingDir;
  const envIgnoredPaths =
    options.envIgnoredPaths ?? process.env[WATCH_IGNORED_PATHS_ENV];

  const fragments = [
    ...BUILTIN_IGNORED_PATH_FRAGMENTS,
    ...(options.extraFragments ?? []).map(toPosix),
    ...parseIgnoredPathsEnv(envIgnoredPaths),
  ];

  const gitignoreMatchers = loadGitignoreMatchers(
    options.workingDir,
    projectRoot
  );

  return (normalizedPath: string): boolean => {
    // Built-in and env-var fragments are hard excludes: they are deliberately
    // not subject to gitignore negation, so a stray `!` rule cannot drag
    // `node_modules` or the generated directory back into the watch set.
    for (const fragment of fragments) {
      if (normalizedPath.includes(fragment)) {
        return true;
      }
    }

    // Fold the gitignore matchers outermost-first so a deeper `.gitignore`
    // overrides a shallower one, matching git. Carrying the unignored result
    // (not just ignored) is what lets a child `!keep.log` re-include a file
    // that the workspace-root `*.log` excluded.
    let ignored = false;
    for (const { dir, matcher } of gitignoreMatchers) {
      const rel = posix.relative(dir, normalizedPath);
      // Empty means the path *is* the gitignore dir; a `..` prefix means it is
      // outside that dir. `ignore` only accepts relative, in-tree paths.
      if (rel === '' || rel === '..' || rel.startsWith('../')) {
        continue;
      }
      // Test the trailing-slash form too so a directory node itself matches a
      // `dir/` gitignore rule (not just its children) — this lets the walk and
      // chokidar prune the directory instead of descending into it.
      const asFile = matcher.test(rel);
      const asDir = matcher.test(`${rel}/`);
      if (asFile.ignored || asDir.ignored) {
        ignored = true;
      } else if (asFile.unignored || asDir.unignored) {
        ignored = false;
      }
    }

    return ignored;
  };
}
