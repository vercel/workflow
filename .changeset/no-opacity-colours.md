---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Stop using opacity to set colours in the observability UI. Disabled, muted, hover, backdrop, and dimmed-node styles now use Geist colour tokens, so they render correctly on every surface and in both themes. A test in each package now fails on new opacity-derived colours.
