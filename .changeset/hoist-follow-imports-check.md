---
'@workflow/builders': patch
---

Hoist the `shouldFollowImportsFromFile` check out of `processImportSpecifier` so it is computed once per file instead of once per import specifier.
