---
"@workflow/world-local": minor
---

Store the Local World in one SQLite database (`<dataDir>/world.db`, opened with the built-in `node:sqlite` or `bun:sqlite`) instead of one JSON file per entity:

- Every `events.create` is one transaction: an event and every change it makes to its run, step, wait and hook commit together or not at all, so a process killed mid-write never leaves a run stuck behind a half-written change. This removes the lock files, claim files and crash-repair paths of earlier releases.
- The queue is stored in the database too. Delayed deliveries, wait timers and retries survive a restart, a delivery whose process died is delivered again once its lease lapses, and a single-orchestrator (spec 9) run's orchestrator deliveries go one at a time across every process on the data directory. A process that cannot reach the app only enqueues; the app's process delivers.
- Stream chunks are numbered in the transaction that writes them, so readers always get them in order.

Requires Node.js 22.13 or later, or Bun. Local run data written by earlier releases is not migrated: it is left in place in the data directory, unread, and new runs start in an empty database.
