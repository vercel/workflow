import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Watchpack from 'watchpack';
import { createWatchScope } from './watch-scope.js';

const toPosix = (pathname: string) => pathname.replace(/\\/g, '/');
/**
 * Compare paths the way the filesystem does. Watchpack builds event paths with
 * `path.join`, which on Windows mixes in backslashes and preserves whatever
 * casing the caller used, so raw string equality is not a path comparison
 * there.
 */
const canonical = (pathname: string) =>
  process.platform === 'win32'
    ? toPosix(pathname).toLowerCase()
    : toPosix(pathname);
const pageExtensions = ['tsx', 'ts', 'jsx', 'js'];

describe('createWatchScope', () => {
  let root: string;

  const p = (...segments: string[]) => canonical(join(root, ...segments));

  const write = (relPath: string, content = '') => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return canonical(abs);
  };

  const scope = ({
    relevantFiles = [] as string[],
    isIgnored = () => false,
  }: {
    relevantFiles?: string[];
    isIgnored?: (path: string) => boolean;
  } = {}) =>
    createWatchScope({
      workingDir: root,
      relevantFiles,
      pageExtensions,
      isIgnored,
    });

  beforeEach(() => {
    root = canonical(mkdtempSync(join(tmpdir(), 'wf-watch-scope-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('tracks every module the build reached, wherever it lives', () => {
    const page = write('app/page.tsx');
    const workflow = write('workflows/order.ts');
    const shared = write('../shared/src/step.ts');

    expect(scope({ relevantFiles: [page, workflow, shared] }).files).toEqual(
      [page, shared, workflow].sort()
    );
  });

  test('does not track a sibling directory the app never imports', () => {
    write('app/page.tsx');
    write('unimported/flow.ts', "'use workflow';");

    const { files, directories } = scope({
      relevantFiles: [p('app/page.tsx')],
    });

    expect(files).not.toContain(p('unimported/flow.ts'));
    expect(directories).not.toContain(p('unimported'));
  });

  test('follows only the route roots that exist', () => {
    mkdirSync(join(root, 'app'), { recursive: true });
    mkdirSync(join(root, 'src/pages'), { recursive: true });

    expect(scope().directories).toEqual([p('app'), p('src/pages')]);
  });

  test('drops ignored paths from every part of the scope', () => {
    mkdirSync(join(root, 'app'), { recursive: true });
    const page = write('app/page.tsx');
    const vendored = write('node_modules/pkg/index.js');

    const { files, directories, missing } = scope({
      relevantFiles: [page, vendored],
      isIgnored: (path) =>
        path.includes('/node_modules/') || path.endsWith('/middleware.ts'),
    });

    expect(files).toEqual([page]);
    expect(directories).toEqual([p('app')]);
    expect(missing).not.toContain(p('middleware.ts'));
  });

  test('waits for root entrypoints that do not exist yet', () => {
    const { missing } = scope();

    expect(missing).toContain(p('middleware.ts'));
    expect(missing).toContain(p('instrumentation.ts'));
    expect(missing).toContain(p('proxy.js'));
    expect(missing).toContain(p('mdx-components.tsx'));
    // `src` does not exist, so nothing should attach to a missing parent.
    expect(missing.some((file) => file.startsWith(p('src/')))).toBe(false);
  });

  test('covers src/ root entrypoints once the directory exists', () => {
    mkdirSync(join(root, 'src'), { recursive: true });

    expect(scope().missing).toContain(p('src/middleware.ts'));
  });

  test('never lists a root entrypoint as both tracked and missing', () => {
    const middleware = write('middleware.ts');

    const { files, missing } = scope({ relevantFiles: [middleware] });

    expect(files).toContain(middleware);
    expect(missing).not.toContain(middleware);
  });
});

/**
 * The scope is only half of the fix: it has to be handed to a watcher that
 * never opens an OS watch on a regular file. On macOS libuv routes a directory
 * watch through FSEvents but falls back to kqueue for a file, holding one
 * descriptor per watched file, which is what exhausted the per-process limit.
 */
// Watchpack is CommonJS and calls `require('fs').watch`, so the recording hook
// goes on the CJS module object rather than through `vi.spyOn`, which cannot
// redefine a property on an ESM namespace.
const nodeFs = createRequire(import.meta.url)('node:fs') as {
  watch: typeof import('node:fs').watch;
};

describe('watching a scope', () => {
  let root: string;
  let watcher: Watchpack | undefined;
  let restoreWatch: (() => void) | undefined;

  const recordWatchTargets = () => {
    const targets: string[] = [];
    const original = nodeFs.watch;
    nodeFs.watch = ((path: string, ...rest: unknown[]) => {
      targets.push(String(path));
      return (original as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof nodeFs.watch;
    restoreWatch = () => {
      nodeFs.watch = original;
    };
    return targets;
  };

  const p = (...segments: string[]) => canonical(join(root, ...segments));

  const write = (relPath: string, content = 'export const value = 1;\n') => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return canonical(abs);
  };

  beforeEach(() => {
    root = canonical(mkdtempSync(join(tmpdir(), 'wf-watch-scope-fs-')));
    changes.length = 0;
    removals.length = 0;
  });

  afterEach(() => {
    watcher?.close();
    watcher = undefined;
    restoreWatch?.();
    restoreWatch = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  const changes: string[] = [];
  const removals: string[] = [];

  const buildScope = (relevantFiles: string[]) =>
    createWatchScope({
      workingDir: root,
      relevantFiles,
      pageExtensions,
      isIgnored: (path) => path.includes('/node_modules/'),
    });

  const startWatching = (
    relevantFiles: string[],
    startTime: number = Date.now()
  ) => {
    const scope = buildScope(relevantFiles);

    if (!watcher) {
      watcher = new Watchpack({ followSymlinks: false });
      watcher.on('change', (file, mtime) => {
        (mtime === null ? removals : changes).push(canonical(file));
      });
      watcher.on('remove', (file) => removals.push(canonical(file)));
    }
    watcher.watch({ ...scope, startTime });

    return { changes, removals, scope };
  };

  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (predicate()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  test('watches directories only, never the files themselves', async () => {
    write('app/page.tsx');
    write('app/dashboard/page.tsx');
    write('workflows/order.ts');

    const targets = recordWatchTargets();
    startWatching([p('app/page.tsx'), p('workflows/order.ts')]);
    // Let the recursive scan of the route root attach its nested watches.
    await waitFor(() => targets.length >= 4);

    expect(targets.length).toBeGreaterThan(0);
    expect(
      targets.filter(
        (target) => !existsSync(target) || !statSync(target).isDirectory()
      )
    ).toEqual([]);
    // The route root, its nested directory, the project root (for the
    // root-entrypoint candidates) and the directory holding the tracked module.
    expect(new Set(targets.map(canonical))).toEqual(
      new Set([root, p('app'), p('app/dashboard'), p('workflows')])
    );
  });

  test('reports edits to a tracked module outside the route roots', async () => {
    const workflow = write('workflows/order.ts');
    write('app/page.tsx');

    const { changes } = startWatching([workflow, p('app/page.tsx')]);
    write('workflows/order.ts', 'export const value = 2;\n');

    expect(await waitFor(() => changes.includes(workflow))).toBe(true);
  });

  test('reports a route created below a route root', async () => {
    write('app/page.tsx');
    const { changes } = startWatching([p('app/page.tsx')]);

    const created = write('app/reports/page.tsx');

    expect(await waitFor(() => changes.includes(created))).toBe(true);
  });

  test('stays silent for an unimported neighbour of a tracked module', async () => {
    const workflow = write('workflows/order.ts');
    write('workflows/unimported.ts');
    write('app/page.tsx');

    const { changes } = startWatching([workflow, p('app/page.tsx')]);

    write('workflows/unimported.ts', 'export const value = 2;\n');
    write('workflows/order.ts', 'export const value = 2;\n');

    // The tracked edit landed second, so once it is reported the unimported
    // one has had at least as long to arrive.
    expect(await waitFor(() => changes.includes(workflow))).toBe(true);
    expect(changes).not.toContain(p('workflows/unimported.ts'));
  });

  /**
   * A file only joins the scope once discovery has found it, which is after the
   * build that read it — so an edit can land while nothing is watching. The
   * `startTime` the scope attaches with is what decides whether that edit is
   * recovered, which is why the builder passes the time the build began rather
   * than the time the scope was computed.
   */
  const writeEditedDuringBuild = () => {
    write('app/page.tsx');
    const late = write('workflows/late.ts');
    const editedAt = Date.now();
    utimesSync(
      join(root, 'workflows/late.ts'),
      editedAt / 1000,
      editedAt / 1000
    );
    return { late, editedAt };
  };

  test('replays an edit that landed before the file joined the scope', async () => {
    const { late, editedAt } = writeEditedDuringBuild();
    const buildStartedAt = editedAt - 10_000;

    // Nothing watches `workflows/` while the build runs.
    startWatching([p('app/page.tsx')], buildStartedAt);
    expect(changes).not.toContain(late);

    // Discovery found it, so the scope widens — reaching back over the build.
    startWatching([p('app/page.tsx'), late], buildStartedAt);

    expect(await waitFor(() => changes.includes(late))).toBe(true);
  });

  test('does not replay an edit that predates the attach', async () => {
    const { late, editedAt } = writeEditedDuringBuild();

    startWatching([p('app/page.tsx'), late], editedAt + 10_000);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(changes).not.toContain(late);
  });

  test('reports a deleted module as a removal', async () => {
    const workflow = write('workflows/order.ts');
    const nested = write('app/reports/page.tsx');
    write('app/page.tsx');

    const { removals } = startWatching([workflow, p('app/page.tsx'), nested]);

    rmSync(join(root, 'workflows/order.ts'));
    rmSync(join(root, 'app/reports/page.tsx'));

    expect(await waitFor(() => removals.includes(workflow))).toBe(true);
    expect(await waitFor(() => removals.includes(nested))).toBe(true);
  });

  test('reports a root entrypoint that appears later', async () => {
    write('app/page.tsx');
    const { changes, scope } = startWatching([p('app/page.tsx')]);
    expect(scope.missing).toContain(p('middleware.ts'));

    const created = write('middleware.ts');

    expect(await waitFor(() => changes.includes(created))).toBe(true);
  });
});
