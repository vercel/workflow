---
'@workflow/web': patch
---

Fix context card / timestamp tooltip styling in the observability UI: register the `dark-theme`/`light-theme` custom variants and the missing Geist color tokens (`background-100`, `background-200`, `gray-1000`, `gray-alpha-400`) in the web app's global stylesheet so utilities like `bg-background-100` and `text-gray-1000` and the dark-mode arrow stroke resolve correctly.
