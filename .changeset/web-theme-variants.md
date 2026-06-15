---
'@workflow/web': patch
---

Fix context card / timestamp tooltip styling in the observability UI: register the `dark-theme`/`light-theme` custom variants and map the Geist `background` and `gray` (incl. `gray-alpha`) color scales to Tailwind tokens in the web app's global stylesheet. This makes `bg-background-100`, the theme-aware `gray` utilities (e.g. `text-gray-900`/`text-gray-1000`), and the dark-mode arrow stroke resolve correctly instead of falling back to Tailwind's non-theme-aware defaults (or emitting no rule).
