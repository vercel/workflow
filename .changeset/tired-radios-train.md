---
"@workflow/world-local": patch
"@workflow/vitest": patch
---

Write workflow data for vitest to the same folder as other local world runs, allowing them to be visible in observability tooling. Use a suffix-based system to ensure clearing runs on test start only affects vitest-related data.
