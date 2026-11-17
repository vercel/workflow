---
'@workflow/web-shared': minor
'@workflow/web': patch
---

Build `LoadMoreButton`, `DecryptButton` and the app's loading spinners on `Button` and `Spinner`. `Button` gains `loading`, `prefix` and `suffix` props, `Spinner` accepts named sizes (`sm` to `4xl`) and paints with `currentColor`, and its keyframes move from render into `styles.css`. `IconButton` drops its `muted` variant, which was identical to `tertiary` (the default), so pass no variant instead.
