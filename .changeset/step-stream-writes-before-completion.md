---
'@workflow/core': patch
---

Wait for a step's stream writes to reach the server before writing its terminal event, so a webhook response sent from a step is not lost when the run completes right after.
