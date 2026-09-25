---
'@workflow/next': patch
---

Scope the Next dev watcher to the framework module graph and stop opening a file descriptor per source file, which fixes file watch limits being reached on large projects
