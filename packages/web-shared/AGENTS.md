# Observability UI styling rules

These rules apply to `packages/web-shared` and `packages/web` (which consumes it). For loading states, dialogs, and validation, read the [`web-guidelines`](../../.agents/skills/web-guidelines/SKILL.md) skill.

## Design tokens live in one place

The design tokens are defined once, in `src/styles.css`. Don't tweak individual values, and don't redeclare the tokens anywhere else, including for `prefers-color-scheme`. The tokens flip with the theme class, so don't add `dark:` overrides for colours that already do.

## Never use opacity to set a text colour

Text colour always comes from a design token or the surface's inherited foreground. Don't make text lighter by fading it:

- no `opacity-*` on an element to mute its text (`<span className="opacity-60">`)
- no text-colour alpha modifiers (`text-muted-foreground/70`, `text-foreground/50`)
- no inline or CSS `color` with alpha (`rgba(…, 0.8)`)

A faded text colour depends on whatever is underneath it, so it becomes unreadable on another surface: the inverted tooltip pill, dark mode, or a coloured row. The tokens are defined for both themes.

Opacity is fine for anything else, such as disabled controls, overlays, fades and animations, or dimming a whole row.

### Follow the dashboard's patterns

Use the same tokens as the Vercel dashboard:

| Need | Use |
| --- | --- |
| Primary text | `text-gray-1000` (or inherit) |
| Secondary text, labels | `text-gray-900`, e.g. `text-gray-900 text-label-13` for a field label |
| Tertiary text, hints, metadata, muted icons | `text-gray-700` |
| Muted text that brightens on hover | `text-gray-900 hover:text-gray-1000` |
| Status text | the `-800` step of the scale: `text-red-800`, `text-amber-800`, `text-green-800` |
| Text on an inverted surface (tooltip, selection bar) | inherit the surface's foreground. Don't add `text-foreground` / `text-muted-foreground`, which are meant for the light surface |

Content inside the shared `Tooltip` renders on a `gray-1000` pill with `background-100` text. Use the standard single tooltip: plain content in one colour, with no colour or text-size overrides.

## Reuse the shared primitives

Build controls from the components in `src/components/ui/` instead of restyling raw elements:

- Buttons use `Button` or `IconButton`. Copying uses `CopyButton`, decryption uses `DecryptButton`, and pending states use `Spinner`.
- Overlays use the Radix primitives this package already depends on (dialog, dropdown menu, tooltip), so focus trapping, keyboard support and focus return come for free.
- Don't inject a `<style>` tag per component instance. Put utilities in class names. If a component must ship its own keyframes for hosts that don't load `styles.css`, use React's deduped `<style href="…" precedence="default">`.
- Use the type-scale utilities (`text-label-*`, `text-copy-*`, `text-heading-*`), not `text-xs`/`text-sm` or arbitrary pixel sizes, and nothing below 12px outside the dense timeline.
- Use a `Tooltip` rather than a native `title` for explanations, such as why a control is disabled.

Copy follows the dashboard: Title Case for buttons, labels, tabs and titles; sentence case for descriptions, errors, toasts and tooltips; `…` rather than `...`. Errors start with "Couldn’t…" for user-fixable problems and "Failed to…" for system failures, and avoid "Unable to" and "An error occurred".
