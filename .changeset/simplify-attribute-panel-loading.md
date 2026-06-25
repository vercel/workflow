---
'@workflow/web-shared': patch
---

Simplify the trace detail panel's Input/Output loading placeholders: render them from a single explicit list in `AttributePanel` instead of an array-mutation in `resolvedAttributes` plus a hidden `isLoading` branch in `AttributeBlock`. No behavior change.
