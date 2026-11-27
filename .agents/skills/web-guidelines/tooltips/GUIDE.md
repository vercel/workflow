# Tooltips

## When to Use

Use when adding or changing hover text, hints, or explanations on any element in `packages/web` or `packages/web-shared`.

## Required Patterns

Never use the HTML `title` attribute as a tooltip. Hover text is always the shared `Tooltip` from `packages/web-shared/src/components/ui/tooltip.tsx`:

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <span>Delta</span>
  </TooltipTrigger>
  <TooltipContent side="top">Time since the previous event</TooltipContent>
</Tooltip>
```

This covers every reason for reaching for `title`: explaining a label, showing the full value of truncated text, and showing a secondary value.

Style the content as described in [`packages/web-shared/AGENTS.md`](../../../../packages/web-shared/AGENTS.md).

### Exceptions

- `title` on an `<iframe>`, where it is the frame's accessible name.
- A component prop that happens to be called `title`, such as a dialog's heading.

## Rationale

A `title` tooltip appears only after a long browser-controlled delay, so people hover, see nothing, and conclude there is no tooltip. It is unstyled and does not follow the theme, cannot be opened by keyboard or touch, and is announced inconsistently by screen readers. The shared `Tooltip` has none of these problems and looks the same everywhere.

## Related Guidance

- [Validation](../validation/GUIDE.md)
