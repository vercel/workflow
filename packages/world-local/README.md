# @workflow/world-local

Filesystem-based workflow backend for local development and testing.

Stores workflow data as JSON files on disk and provides in-memory queuing. Automatically detects development server port for queue transport.

Used by default on `next dev` and `next start`.

The queue-handler callback accepts generic return values. An `invoke: true`
message returns its value as response data rather than interpreting a
`timeoutSeconds` property as scheduling control. The local World does not yet
advertise the optional `invoke` sending capability.

## Programmatic configuration

```ts
import { createWorld } from '@workflow/world-local';

const world = createWorld({
  dataDir: './custom-workflow-data',
});
```
