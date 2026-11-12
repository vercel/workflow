---
"@workflow/world-local": patch
---

`start()` now resolves only once the World's queue auth key is written to the data directory, so the CLI, the web UI and the app's other processes can read it as soon as the app has started.
