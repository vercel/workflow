---
'@workflow/next': patch
---

Scope the Next dev watcher to the framework module graph and stop opening a file descriptor per source file.

The watcher pointed chokidar at the whole project. chokidar registers an `fs.watch` per *file* it walks into, and macOS only routes *directory* watches through FSEvents — a regular-file watch falls back to kqueue and holds a descriptor for as long as it is open. Large apps accumulated one descriptor per source file until they reached the per-process limit, after which unrelated `fork()` calls failed with `spawn EBADF`.

The watcher now tracks the modules the build actually reached, plus the `app`/`pages` roots where a new route can appear, and runs on Watchpack, which never watches a file directly. Descriptor cost is now proportional to watched directories rather than source files. A file the app never imports no longer triggers a rebuild, a newly created route entrypoint now does, and the watcher is released when Next re-evaluates `next.config` instead of accumulating.
