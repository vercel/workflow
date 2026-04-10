---
"@workflow/utils": patch
---

Fix local workflow port detection for POST-only health endpoints

- Probe `/.well-known/workflow/v1/flow?__health` with `POST` when `HEAD` is not healthy
- Prevent lazy-discovery socket ports from being selected as workflow HTTP base URL
