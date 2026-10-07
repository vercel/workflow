# Disk-usage benchmark

Writes runs of 117 events (`run_created`, `run_started`, 38 steps of
`step_created` / `step_started` / `step_completed`, `run_completed`) with
deterministic, text-like step inputs and outputs through `events.create`, and
measures the store at each checkpoint.

```sh
pnpm build
node bench/disk-usage.mjs sqlite ./dist/index.js \
  --checkpoints 10000,50000 --out sqlite.json
node bench/disk-usage.mjs local ../world-local/dist/index.js \
  --checkpoints 10000,50000 --out local.json
```

The first argument is a label; one starting with `sqlite` adds the
SQLite-only measurements. The second is the module exporting `createWorld`.

Per checkpoint: `du` disk vs apparent size, file and directory count, bytes
per event and per run, payload bytes written, and bytes spent on duplicate
copies of step input/output. SQLite also gets the db / `-wal` / `-shm` split
before and after a checkpoint and a `dbstat` breakdown per table and index.
At the last checkpoint it deletes half the runs and reports the size after
the delete, after `VACUUM` and after `incremental_vacuum`, plus page-size and
per-record compression variants (deflate, brotli, zstd). `--keep` keeps the
data directory.
