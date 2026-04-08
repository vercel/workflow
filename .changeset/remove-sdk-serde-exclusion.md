---
"@workflow/builders": major
"@workflow/next": major
"@workflow/rollup": major
---

Remove `isWorkflowSdkFile` serde exclusion — the SWC detect mode's AST-level manifest already correctly filters files without serde class definitions, so the broad SDK path exclusion is no longer needed and was preventing class definitions in SDK packages from being discovered
