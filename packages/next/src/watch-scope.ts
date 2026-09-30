import { existsSync } from 'node:fs';
import { normalize, posix } from 'node:path';

/**
 * Next.js route roots. Any file below one of these can become an entrypoint by
 * filename convention alone, without any existing module importing it, so these
 * are the only trees the dev watcher follows recursively.
 */
export const NEXT_ROUTE_ROOTS: readonly string[] = [
  'app',
  'src/app',
  'pages',
  'src/pages',
];

/**
 * Directories that can hold a root-level entrypoint. Next.js resolves those by
 * name relative to the project root, or to `src` when the project uses it.
 */
const ROOT_ENTRYPOINT_DIRECTORIES: readonly string[] = ['', 'src'];

/** Root-level entrypoints Next.js resolves by name, honoring `pageExtensions`. */
export const ROOT_ENTRYPOINT_NAMES: readonly string[] = [
  'instrumentation',
  'middleware',
  'proxy',
];

/** Root-level modules Next.js resolves by name with a fixed extension list. */
export const ROOT_MODULE_NAMES: readonly string[] = [
  'instrumentation-client',
  'mdx-components',
];

/** Extensions Next.js accepts for {@link ROOT_MODULE_NAMES}. */
export const ROOT_MODULE_EXTENSIONS: readonly string[] = [
  'js',
  'mjs',
  'tsx',
  'ts',
  'jsx',
];

/**
 * A watch scope, in the platform's own path form.
 *
 * Every path here is native (backslashes on Windows). Watchpack keys its
 * watchers by the string it is handed but records directory entries as
 * `path.join(dir, name)`, and its key comparison only lowercases — it does not
 * normalize separators. Hand it `d:/app/flow.ts` and its own scan files the
 * same module under `d:\app\flow.ts`, so no listener ever matches: edits go
 * unreported and every attach looks like a deletion instead.
 */
export interface WatchScope {
  /**
   * Exact files tracked for content and existence changes. These are the
   * modules the workflow build actually consumed.
   */
  files: string[];
  /**
   * Directory trees tracked recursively: the route roots, where a file becomes
   * an entrypoint by filename alone, and the directories the graph already
   * lives in, where a new module can appear under an import that is already
   * written.
   */
  directories: string[];
  /**
   * Paths that do not exist yet but would become entrypoints if they appeared.
   * Tracked through their parent directory, never as a watch of their own.
   */
  missing: string[];
}

export interface WatchScopeOptions {
  /** POSIX-normalized absolute path of the app directory being built. */
  workingDir: string;
  /**
   * POSIX-normalized absolute paths of every module the build reached from the
   * framework entrypoints (`inputFiles` plus everything discovery walked into).
   */
  relevantFiles: Iterable<string>;
  /** The project's resolved `pageExtensions`. */
  pageExtensions: readonly string[];
  /** Predicate from `createWatchIgnorePredicate`, plus the caller's dist dir. */
  isIgnored: (normalizedPath: string) => boolean;
  /** Existence check, injected by tests. Defaults to `existsSync`. */
  pathExists?: (normalizedPath: string) => boolean;
}

const toPosix = (pathname: string) => pathname.replace(/\\/g, '/');

/** POSIX in, platform-native out. A no-op everywhere except Windows. */
const toNative = (pathname: string) => normalize(pathname);

const stripTrailingSlash = (pathname: string) =>
  pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;

/** Whether `candidate` is `directory` itself or sits below it. */
const isAtOrBelow = (candidate: string, directory: string) =>
  candidate === directory || candidate.startsWith(`${directory}/`);

/**
 * Every path a root-level entrypoint could occupy, whether or not it exists.
 * Mirrors what `createNextEntrypointMatcher` accepts, so the watcher covers the
 * same filenames `getInputFiles` would pick up on the next discovery pass.
 */
function rootEntrypointCandidates({
  workingDir,
  pageExtensions,
  pathExists,
}: {
  workingDir: string;
  pageExtensions: readonly string[];
  pathExists: (normalizedPath: string) => boolean;
}): string[] {
  // A candidate under a directory that does not exist would make the watcher
  // attach to a missing parent, which only produces an error event.
  const directories = ROOT_ENTRYPOINT_DIRECTORIES.map((segment) =>
    segment ? posix.join(workingDir, segment) : workingDir
  ).filter((directory) => directory === workingDir || pathExists(directory));

  return directories.flatMap((directory) => [
    ...ROOT_ENTRYPOINT_NAMES.flatMap((name) =>
      pageExtensions.map((extension) =>
        posix.join(directory, `${name}.${extension}`)
      )
    ),
    ...ROOT_MODULE_NAMES.flatMap((name) =>
      ROOT_MODULE_EXTENSIONS.map((extension) =>
        posix.join(directory, `${name}.${extension}`)
      )
    ),
  ]);
}

/**
 * The directories the graph already occupies, which is where a module can
 * appear under an import that is already written — the `import './helpers'` a
 * developer types before creating `helpers.ts`. Discovery cannot resolve that
 * import, so the file is not in the graph and no later edit announces it; only
 * watching the directory catches its creation.
 *
 * The root-entrypoint directories are left out. A file directly in the project
 * root or in `src/` is reached through `files`/`missing` instead, because
 * following those recursively would pull in the whole source tree and undo the
 * scoping.
 */
function graphDirectories({
  files,
  root,
  routeRoots,
  isIgnored,
}: {
  files: readonly string[];
  root: string;
  routeRoots: readonly string[];
  isIgnored: (normalizedPath: string) => boolean;
}): string[] {
  const rootEntrypointDirectories = new Set(
    ROOT_ENTRYPOINT_DIRECTORIES.map((segment) =>
      segment ? posix.join(root, segment) : root
    )
  );

  return [
    ...new Set(
      files
        .map((file) => posix.dirname(file))
        .filter(
          (directory) =>
            !rootEntrypointDirectories.has(directory) &&
            // A directory above the app (a monorepo root reached through an
            // import) would recurse over everything beside the app too.
            !isAtOrBelow(root, directory) &&
            // Already followed recursively as a route root.
            !routeRoots.some((routeRoot) =>
              isAtOrBelow(directory, routeRoot)
            ) &&
            !isIgnored(directory)
        )
    ),
  ];
}

/**
 * Describe what the dev watcher should track.
 *
 * The workflow build only bundles what it can reach from the framework's
 * entrypoints, so watching the whole project tree buys nothing: an edit outside
 * that graph cannot change a bundle, and `classifyRebuild` discards it after
 * paying for the event. The scope is therefore the module graph, the
 * directories that graph lives in, and the places a file can become an
 * entrypoint by filename alone — below a {@link NEXT_ROUTE_ROOTS} directory, or
 * as a root-level entrypoint.
 *
 * Nothing here is a file to hand to an OS watch API. The caller feeds `files`
 * and `missing` to a watcher that derives file events from the parent
 * directory: on macOS, libuv routes a *directory* watch through FSEvents but
 * falls back to kqueue for a regular file, which holds a descriptor per watched
 * file for as long as the watch is open.
 */
export function createWatchScope({
  workingDir,
  relevantFiles,
  pageExtensions,
  isIgnored,
  pathExists = existsSync,
}: WatchScopeOptions): WatchScope {
  const root = stripTrailingSlash(toPosix(workingDir));

  const routeRoots = [
    ...new Set(
      NEXT_ROUTE_ROOTS.map((segment) => posix.join(root, segment)).filter(
        (directory) => !isIgnored(directory) && pathExists(directory)
      )
    ),
  ];

  const files = [
    ...new Set(
      [...relevantFiles].map(toPosix).filter((file) => !isIgnored(file))
    ),
  ].sort();

  const directories = [
    ...routeRoots,
    ...graphDirectories({ files, root, routeRoots, isIgnored }),
  ].sort();

  const watchedFiles = new Set(files);
  const missing = [
    ...new Set(
      rootEntrypointCandidates({
        workingDir: root,
        pageExtensions,
        pathExists,
      }).filter(
        (candidate) =>
          !isIgnored(candidate) &&
          !watchedFiles.has(candidate) &&
          !pathExists(candidate)
      )
    ),
  ].sort();

  return {
    files: files.map(toNative),
    directories: directories.map(toNative),
    missing: missing.map(toNative),
  };
}
