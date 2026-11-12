# Observability UI styling rules

These rules apply to `packages/web-shared` and `packages/web` (which consumes it).

## Never use opacity to set a colour

Every text, icon, border, and surface colour comes from a Geist token: `gray-100`…`gray-1000`, `gray-alpha-100`…`gray-alpha-1000`, `background-100` / `background-200`, or a named colour scale (`blue-*`, `red-*`, `amber-*`, …). Do not fade an element or a colour to get a lighter shade. That means none of:

- `opacity-*` utilities used to dim text, icons, or surfaces (`opacity-50`, `opacity-70`, `disabled:opacity-50`, `hover:opacity-90`, …)
- Tailwind colour alpha modifiers (`text-foreground/70`, `bg-muted/50`, `border-primary-foreground/20`, `bg-black/50`, …)
- inline or CSS `opacity`, `fillOpacity` / `strokeOpacity`
- colour literals with alpha (`rgba()`, `hsla()`, `oklch(… / 0.5)`, 8-digit hex, `color-mix()`)

Why: an opacity-derived colour depends on whatever sits underneath it. It looks fine on one surface and breaks on the next: on the inverted tooltip pill, in dark mode, or over a coloured row. A token is defined for both themes.

What to use instead:

| Need | Use |
| --- | --- |
| Secondary or muted text | `text-gray-900`, then `text-gray-700` for tertiary |
| Disabled control | `bg-gray-100 text-gray-700` with a `gray-400` border (see `ui/button.tsx`); a borderless control just gets `text-gray-700` |
| Hover or selected fill on a neutral surface | `bg-gray-alpha-100` / `bg-gray-alpha-200` (alpha tokens flip with the theme) |
| Subtle panel or code background | `bg-background-200` |
| Inverted surface (tooltip, selection bar) | content inherits the surface's foreground; don't add `text-foreground` / `text-muted-foreground`, which are for the light surface. Use `Button variant="default"` for actions on it |
| Modal or sheet backdrop | `backdrop-brightness-50` (darkens what's beneath without a translucent colour) |
| Tint over a canvas or chart | a token fill with `mix-blend-multiply` (and `mix-blend-screen` in dark mode), as in `trace-viewer/components/minimap.tsx` |

Content inside the shared `Tooltip` renders on a `gray-1000` pill with `background-100` text. Use the standard single tooltip: plain content in one colour, no colour or text-size overrides.

### Still allowed

- `opacity-0` / `opacity-100` for show/hide and fade transitions.
- `opacity` inside `@keyframes` (fade and pulse animations).
- Colour literals in the theme files (`src/styles.css`, `packages/web/app/globals.css`), where tokens such as the shadow scale are defined.
- Anything else needs an `opacity-allowed: <reason>` comment on the same line or the line above, so the exception gets reviewed. Today that covers only fading a whole multi-colour composite (a search non-match row, an unrelated event row), where no single token can be swapped in.

### Enforcement

`test/no-opacity-colours.test.ts` (this package) and `packages/web/app/no-opacity-colours.test.ts` scan every source file with the rules in `test/opacity-colour-rules.ts` and fail on violations. If a new case really needs opacity, add the `opacity-allowed:` comment with a reason; don't loosen the patterns.
