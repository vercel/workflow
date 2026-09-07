# `@workflow/world-sqlite`

Experimental, opt-in native SQLite World for the Phase 1 Rust portability
walking skeleton. It implements durable run, step, and event storage plus a
single-worker loopback HTTP queue. Hooks, waits, streams, recovery, and the full
Workflow end-to-end contract are planned for Phase 2.

```ts
import { createWorld } from '@workflow/world-sqlite';

const world = createWorld({ databaseDir: '.workflow-database' });
await world.migrate(); // Schema changes are always explicit.
await world.start();
```

Construction does not create files or migrate a database. `migrate()` is the
only package operation that advances the schema. When queue consumption is
needed, pass both the exact `queueNames` and either a full loopback `flowUrl` or
a `baseUrl`; the package does not discover ports or queue names.

Configuration precedence for the database directory is:

1. `createWorld({ databaseDir })`
2. `WORKFLOW_LOCAL_DATABASE_DIR`
3. `.workflow-database` relative to the current project directory

`WORKFLOW_LOCAL_BASE_URL` may provide the base URL when neither `flowUrl` nor
`baseUrl` is passed. It is converted to the standard Workflow flow route. The
legacy `WORKFLOW_LOCAL_DATA_DIR` continues to belong only to the filesystem
World and is not treated as an alias.

The Phase 1 source build requires Rust 1.88 and Node.js 22 or 24. The addon uses
Node-API 8 and bundled SQLite 3.53.2. Prebuilt, clean-install artifacts and a
public support commitment are Phase 2 work.
