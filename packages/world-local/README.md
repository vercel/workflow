# @workflow/world-local

Filesystem-based workflow backend for local development and testing.

Stores workflow data as JSON files on disk and provides in-memory queuing. Automatically detects development server port for queue transport.

The `limits` namespace implements the shared flow-limits contract for local development:

- keyed concurrency and rate limits
- FIFO waiter promotion per key
- cancelled workflow / failed step waiter pruning
- prompt wake-ups with delayed fallback retries

Limit state is persisted on disk, but queue delivery is still in-memory. That means local world matches the same live-process lock semantics as other implemented worlds, while crash-survival and durable backlog behavior remain a PostgreSQL-only advantage today.

Used by default on `next dev` and `next start`.
