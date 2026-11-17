---
'@workflow/web-shared': minor
'@workflow/web': patch
---

Build `DecryptButton` and the app's loading buttons and spinners on `Button`, which gains `loading`, `prefix` and `suffix` props, and on `Spinner`, which takes named sizes from `sm` to `4xl` (default `lg`). `Button` drops `size="tiny"` (use `small`), `IconButton` drops its `muted` variant, and `LoadMoreButton` is removed in favour of a secondary `Button` with `loading`.
