---
'@workflow/web-shared': minor
'@workflow/web': patch
---

Build `LoadMoreButton`, `DecryptButton` and the app's loading spinners on `Button`, which gains `loading`, `prefix` and `suffix` props, and on `Spinner`, which takes named sizes from `sm` to `4xl` (default `lg`) and paints with `currentColor`. `IconButton` drops its `muted` variant, which was identical to the default `tertiary`.
