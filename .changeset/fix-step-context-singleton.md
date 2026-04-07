---
"@workflow/core": patch
---

Fix step `contextStorage` global _potentially_ seeing dual-instance issues when bundlers create multiple copies of the module.
