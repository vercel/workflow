---
"@workflow/web": patch
"@workflow/cli": patch
---

The web UI only accepts requests addressed to `localhost` or an IP address unless more host names are allowed with `--webAllowedHosts` or `WORKFLOW_WEB_ALLOWED_HOSTS`.
