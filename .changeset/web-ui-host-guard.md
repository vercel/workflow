---
"@workflow/web": patch
"@workflow/cli": patch
"@workflow/nitro": patch
---

The web UI (standalone and embedded at `/_workflow`) only accepts requests addressed to `localhost` or an IP address; if you reach it under another host name, such as behind a reverse proxy, allow it with `--webAllowedHosts`, `WORKFLOW_WEB_ALLOWED_HOSTS`, or Nitro's `dashboard.allowedHosts`.
