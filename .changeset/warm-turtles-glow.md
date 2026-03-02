---
"@workflow/web-shared": patch
---

Replace JSON.stringify-based data rendering with `react-inspector` ObjectInspector for proper display of Map, Set, URLSearchParams, Date, Error, RegExp, typed arrays, and other non-plain-object types.
