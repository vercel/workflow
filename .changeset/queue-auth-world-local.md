---
"@workflow/world-local": minor
---

Authenticate queue deliveries (`queueAuthMode: 'loopback'`) with a key in `queue-auth-key` in the data directory, written owner-only each time the app starts and read by the CLI and the web UI (`queueAuthKey: 'read'`). Retry a refused delivery at once when the key changed, give it up after 5 refusals, and write a `.gitignore` into a data directory that has none.
