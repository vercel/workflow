---
"@workflow/world-local": minor
---

Store the Local World in one SQLite database (`<dataDir>/world.db`, opened with the built-in `node:sqlite` or `bun:sqlite`) instead of one JSON file per entity:

- Every `events.create` is one transaction: an event and every change it makes to its run, step, wait and hook commit together or not at all, so a process killed mid-write never leaves a run stuck behind a half-written change. This removes the lock files, claim files and crash-repair paths of earlier releases.
- The queue stays in memory, as before. Startup recovery re-enqueues active runs as before, and now also wakes each recovered run when each of its open waits is due (for a wait due within the queue's longest timer, about 24.8 days), as a backstop to the recovery delivery re-arming the run's wait timers.
- `close()` no longer aborts a message the app has not received yet, so a short-lived sender (`wf start`, a script calling `start()`) no longer loses the run it just started. It waits until the app has written to the message's run, up to 10 seconds (enough for a dev server compiling its routes on the first request), or up to 1 second for a message without a run.
- Reading a data directory that has no database yet (the CLI or web UI pointed at an app that has not run) reads it as empty, and creates nothing: the first write creates the directory and `world.db`.
- Stream chunks are numbered in the transaction that writes them, so readers always get them in order.

Requires Node.js 22.13 or later, or Bun. Local run data written by earlier releases is not migrated: it is left in place in the data directory, unread, and new runs start in an empty database. The first start after the upgrade says so once, naming the directories that can be deleted.
