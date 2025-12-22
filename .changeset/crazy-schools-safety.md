---
"@workflow/cli": patch
"@workflow/web": patch
"@workflow/web-shared": patch
---

Allow starting up web when workflow data directory is not present and auto-detect workflow data directory in web UI after a workflow is run

- Web UI now automatically detects data directories on load and on refresh
- CLI passes searchDir to web UI for proper directory resolution
- Improved error handling: missing data directory is now a warning instead of an error
