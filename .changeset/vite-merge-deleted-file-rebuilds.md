---
'@workflow/builders': patch
'@workflow/vite': patch
---

Stop `vite dev` from running one full workflow build per deleted file. Deleting a file now rebuilds only when the last discovery found it as a workflow, step, or serde file, and builds requested while another build runs are merged into one follow-up build.
