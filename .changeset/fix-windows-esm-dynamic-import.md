---
"@workflow/web": patch
"@workflow/nest": patch
"@workflow/vitest": patch
---

Fix `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Windows by converting absolute file paths to `file://` URLs before passing them to dynamic `import()`
