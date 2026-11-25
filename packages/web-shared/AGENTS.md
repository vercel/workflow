# Observability UI styling rules

These rules apply to `packages/web-shared` and `packages/web` (which consumes it). For loading states, dialogs, and validation, read the [`web-guidelines`](../../.agents/skills/web-guidelines/SKILL.md) skill.

## Design tokens live in one place

The design tokens are defined once, in `src/styles.css`. Don't tweak individual values, and don't redeclare the tokens anywhere else, including for `prefers-color-scheme`. The tokens flip with the theme class, so don't add `dark:` overrides for colours that already do.

## How to apply styles

Not every host loads `styles.css`. Some only scan this package for class names and define the same tokens themselves, so styling must work from class names and co-located CSS alone.

- Use Tailwind classes with the tokens and typography utilities from `src/styles.css` for all static styling. Don't use arbitrary values where a token or standard utility exists, and don't use tokens that `styles.css` doesn't define.
- Put what classes can't express (keyframes, pseudo-element `content`, complex selectors) in a `*.module.css` next to the component that uses it. The build copies every `src/**/*.module.css` into `dist`.
- Use inline `style` only for values computed at runtime, such as positions, widths, transforms and per-item delays.
- Keep `styles.css` to the tokens, the theme and shared utilities. Don't add component styles to it.

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

Content inside the shared `Tooltip` renders on an `.invert-theme` pill: `background-100` with `gray-1000` text, both resolved in the inverted theme. Use the standard single tooltip: plain content in one colour, with no colour or text-size overrides.
