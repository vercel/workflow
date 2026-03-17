# @workflow/world-local

Filesystem-based workflow backend for local development and testing.

Stores workflow data as JSON files on disk and provides in-memory queuing. Automatically detects development server port for queue transport.

The `limits` namespace is exposed as part of the shared world contract, but flow concurrency and rate limiting are not implemented in this package yet.

Used by default on `next dev` and `next start`.
