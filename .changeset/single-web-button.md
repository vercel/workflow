---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Use a single button everywhere in the observability UI. `@workflow/web-shared` now exports `Button`, `buttonVariants` and `ButtonProps`, and `@workflow/web` consumes them instead of its own shadcn copy. The shared button gains `default`/`secondary`/`tertiary` variants and `tiny`/`small`/`medium`/`large` sizes with an optional `square`/`circle` shape; its fill, text and border are painted from `--themed-*` custom properties, so `secondary` and `tertiary` are no longer rendered with the inverted button's gray-1000 fill. The dark-mode hover now also matches a `.dark` ancestor, and corner radii are literal so they don't move with a host app's `--radius-*` scale.
