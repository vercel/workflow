---
'@workflow/web-shared': patch
---

Remove duplication in the trace viewer's span details panel: the panel shell is its only scroll container, the details read the sidebar data context instead of taking it as props, the decrypt context is provided once and memoized, span names come from one helper, and resolving a hook reuses `useHookActions`.
