---
---

Add SurrealDB to `worlds-manifest.json` as a community world, and add optional `args` support to the community-world CI's generic `docker` service runner so a manifest service can pass command arguments to its container image (SurrealDB's image entrypoint needs the `start` subcommand). The E2E job remains gated by the existing `if: false` on `e2e-community`.
