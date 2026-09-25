---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Fix the `--ds-*` colour tokens in the web UI. `packages/web/app/globals.css` redefined about 27 of them with unrelated values that shadowed the ones it imports from `@workflow/web-shared`, so `text-pink-600` rendered a different palette than the `text-blue-600` next to it. Its `prefers-color-scheme: dark` rule also carried a stale palette on a selector that out-specified `.dark`, which meant a dark-mode browser got those values whatever theme the user had picked.
