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
  /** Raw pattern lines, used to rebuild the matcher without a neutralized rule. */
  lines: string[];
  /** Whether this file contains any `!` re-inclusion rule. */
  hasNegation: boolean;
  /** Matchers rebuilt with some rules dropped, keyed by the dropped set. */
  filtered: Map<string, Ignore>;
}

/**
 * Rebuild a matcher with `dropped` pattern lines removed. Used when a rule
 * excluded a directory that a deeper `.gitignore` re-included: that rule must
 * stop applying to the subtree, while every *other* rule in the same file
 * (e.g. a `*.secret` that still matches a file inside) keeps applying.
 */
function matcherWithout(entry: GitignoreMatcher, dropped: Set<string>): Ignore {
  if (dropped.size === 0) {
    return entry.matcher;
  }
  const key = [...dropped].sort().join('\n');
  const cached = entry.filtered.get(key);
  if (cached) {
    return cached;
  }
  const rebuilt = ignore().add(
    entry.lines.filter((line) => !dropped.has(line.trim()))
  );
  entry.filtered.set(key, rebuilt);
  return rebuilt;
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
      const lines = content.split('\n');
      matchers.push({
        dir: current,
        matcher: ignore().add(content),
        lines,
        hasNegation: lines.some((line) => line.trim().startsWith('!')),
        filtered: new Map(),
      });
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
  // Re-inclusion is only possible when some file has a `!` rule. Without one,
  // the cheap flat scan below is equivalent to the full per-directory walk.
  const anyNegation = gitignoreMatchers.some((entry) => entry.hasNegation);
  const outermostDir = gitignoreMatchers[0]?.dir;

  /** Test one path against one matcher, as both a file and a directory node. */
  const testEntry = (
    entry: GitignoreMatcher,
    rel: string,
    dropped: Set<string> | undefined
  ) => {
    const matcher = dropped ? matcherWithout(entry, dropped) : entry.matcher;
    // Test the trailing-slash form too so a directory node itself matches a
    // `dir/` gitignore rule (not just its children) — this lets the walk and
    // chokidar prune the directory instead of descending into it.
    const asFile = matcher.test(rel);
    const asDir = matcher.test(`${rel}/`);
    if (asFile.ignored) {
      return { ignored: true, pattern: asFile.rule?.pattern };
    }
    if (asDir.ignored) {
      return { ignored: true, pattern: asDir.rule?.pattern };
    }
    if (asFile.unignored || asDir.unignored) {
      return { ignored: false, pattern: undefined };
    }
    return undefined;
  };

  /**
   * Resolve one path level against every applicable `.gitignore`, deepest file
   * last so it wins. Returns the level's verdict plus the rules that voted to
   * exclude it, which the caller neutralizes if the level is re-included.
   */
  const decideLevel = (
    prefix: string,
    neutralized: Map<number, Set<string>>
  ) => {
    let decision: boolean | undefined;
    let excludedBy: Array<{ index: number; pattern: string }> = [];

    for (let index = 0; index < gitignoreMatchers.length; index++) {
      const entry = gitignoreMatchers[index];
      const rel = posix.relative(entry.dir, prefix);
      // Empty means the path *is* the gitignore dir; a `..` prefix means it is
      // outside. `ignore` only accepts relative, in-tree paths.
      if (rel === '' || rel === '..' || rel.startsWith('../')) {
        continue;
      }
      const result = testEntry(entry, rel, neutralized.get(index));
      if (!result) {
        continue;
      }
      if (!result.ignored) {
        decision = false;
        continue;
      }
      if (decision !== true) {
        excludedBy = [];
      }
      decision = true;
      if (result.pattern) {
        excludedBy.push({ index, pattern: result.pattern });
      }
    }

    return { decision, excludedBy };
  };

  /**
   * Walk the path one directory segment at a time, the way git does. At each
   * level the deepest `.gitignore` with an opinion wins; if that verdict is
   * "ignored" git stops descending, so we can return immediately.
   *
   * When a level is re-included after a shallower file excluded it, the rule
   * that did the excluding is neutralized for the rest of the walk. That is
   * what lets root `generated/` + app `!generated/` watch `app/generated/x.ts`
   * while a sibling root rule such as `*.secret` still excludes
   * `app/generated/a.secret`.
   */
  const walkGitignore = (normalizedPath: string): boolean => {
    if (!outermostDir) {
      return false;
    }
    const relToBase = posix.relative(outermostDir, normalizedPath);
    if (relToBase === '' || relToBase === '..' || relToBase.startsWith('../')) {
      return false;
    }

    const neutralized = new Map<number, Set<string>>();
    let prefix = outermostDir;

    for (const segment of relToBase.split('/')) {
      prefix = `${prefix}/${segment}`;
      const { decision, excludedBy } = decideLevel(prefix, neutralized);

      if (decision === true) {
        // Git does not descend into an excluded directory.
        return true;
      }
      if (decision === false) {
        // This level was re-included; the rules that excluded it must not
        // resurrect for anything beneath it.
        for (const { index, pattern } of excludedBy) {
          const dropped = neutralized.get(index) ?? new Set<string>();
          dropped.add(pattern);
          neutralized.set(index, dropped);
        }
      }
    }

    return false;
  };

  return (normalizedPath: string): boolean => {
    // Built-in and env-var fragments are hard excludes: they are deliberately
    // not subject to gitignore negation, so a stray `!` rule cannot drag
    // `node_modules` or the generated directory back into the watch set.
    for (const fragment of fragments) {
      if (normalizedPath.includes(fragment)) {
        return true;
      }
    }

    if (!anyNegation) {
      // Fast path: no re-inclusion anywhere, so the first match decides.
      for (const entry of gitignoreMatchers) {
        const rel = posix.relative(entry.dir, normalizedPath);
        if (rel === '' || rel === '..' || rel.startsWith('../')) {
          continue;
        }
        if (entry.matcher.ignores(rel) || entry.matcher.ignores(`${rel}/`)) {
          return true;
        }
      }
      return false;
    }

    return walkGitignore(normalizedPath);
  };
}
