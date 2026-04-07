---
"@workflow/core": patch
"@workflow/cli": patch
---

CLI `start` command probes deployment specVersion via health check before choosing queue transport. Health check always uses JSON transport for compatibility with old deployments.
