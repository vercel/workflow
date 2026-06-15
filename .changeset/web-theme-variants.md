---
'@workflow/web': patch
---

Fix context card / timestamp tooltip styling in the observability UI:

- Register the `dark-theme`/`light-theme` custom variants and map the Geist `background` and `gray` (incl. `gray-alpha`) color scales to Tailwind tokens so utilities like `bg-background-100`, `text-gray-900`, `text-gray-1000`, and the dark-mode arrow stroke resolve correctly instead of falling back to Tailwind's non-theme-aware defaults (or emitting no rule).
- Correct the `--ds-*` neutral palette values, which had drifted to a Tailwind-neutral-style scale (e.g. dark `background-100` was pure black and dark `gray-900` was near-white). They now match the canonical Geist scale, so the card background and gray text render with the correct contrast in both themes.
