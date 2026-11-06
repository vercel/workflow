import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * The button for the observability UI.
 *
 * Fill, text and border are painted from four custom properties —
 * `--themed-bg`, `--themed-fg`, `--themed-border` and `--themed-hover-bg` — so
 * a variant only redeclares the tokens it changes and the base rules stay the
 * same. Geometry follows the `--ds-*` control scale: 24/32/36/40px tall for
 * tiny/small/medium/large, a 6px radius (4px at tiny, 8px at large), and 16px
 * of horizontal padding at medium.
 *
 * The styles have to resolve in whichever app consumes
 * `@workflow/web-shared`, so:
 *   - dark mode is matched with ancestor selectors rather than a `dark-theme:`
 *     variant, which only exists once our `styles.css` is imported;
 *   - the focus ring is written as arbitrary properties, because bare
 *     `outline` and arbitrary-colour utilities differ between Tailwind v3
 *     and v4.
 */
const buttonVariants = cva(
  [
    'group/trigger relative m-0 inline-flex max-w-full shrink-0 items-center justify-center gap-2',
    'cursor-pointer select-none whitespace-nowrap border-0 align-baseline font-medium no-underline outline-none',
    'transform translate-z-0',
    // Fill, text and border all come from --themed-*; the fallbacks below are
    // the inverted `default` variant, so it declares no colour tokens at all.
    'text-[var(--themed-fg,_var(--ds-background-100))]',
    'bg-[var(--themed-bg,_var(--ds-gray-1000))]',
    'shadow-[0_0_0_1px_var(--themed-border,_transparent)]',
    // Every variant declares --themed-hover-bg, so there is a single
    // `hover:bg-*` utility on the element and a call site that needs its own
    // hover fill replaces it in both themes at once.
    'hover:bg-[var(--themed-hover-bg)]',
    'transition-[border-color,background,color,transform,box-shadow] duration-150 ease-in-out',
    'focus-visible:[outline:2px_solid_var(--ds-focus-color)] focus-visible:[outline-offset:2px]',
    '[&_svg]:shrink-0',
    // Disabled buttons flatten to the gray-100 fill with a gray-400 border.
    'disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-700 disabled:[--themed-border:_var(--ds-gray-400)] disabled:hover:bg-gray-100',
    'aria-disabled:cursor-not-allowed aria-disabled:bg-gray-100 aria-disabled:text-gray-700 aria-disabled:[--themed-border:_var(--ds-gray-400)] aria-disabled:hover:bg-gray-100',
  ],
  {
    variants: {
      variant: {
        // No `--ds-*` token sits one step lighter/darker than the inverted
        // fill, so its hover colours are literal — and they have to flip with
        // the theme, because the fill itself does.
        default: [
          '[--themed-hover-bg:_hsl(0,_0%,_22%)]',
          '[.dark_&]:[--themed-hover-bg:_hsl(0,_0%,_80%)]',
          '[.dark-theme_&]:[--themed-hover-bg:_hsl(0,_0%,_80%)]',
          '[[data-theme=dark]_&]:[--themed-hover-bg:_hsl(0,_0%,_80%)]',
        ],
        secondary: [
          '[--themed-bg:_var(--ds-background-100)]',
          '[--themed-fg:_var(--ds-gray-1000)]',
          '[--themed-border:_var(--ds-gray-400)]',
          '[--themed-hover-bg:_var(--ds-gray-100)]',
          '[.dark_&]:[--themed-hover-bg:_var(--ds-gray-200)]',
          '[.dark-theme_&]:[--themed-hover-bg:_var(--ds-gray-200)]',
          '[[data-theme=dark]_&]:[--themed-hover-bg:_var(--ds-gray-200)]',
        ],
        // Tertiary is the one variant allowed to go borderless when disabled;
        // it drops to 50% opacity instead.
        tertiary: [
          '[--themed-bg:_transparent]',
          '[--themed-fg:_var(--ds-gray-1000)]',
          '[--themed-border:_transparent]',
          // The alpha token already flips with the theme.
          '[--themed-hover-bg:_var(--ds-gray-alpha-200)]',
          'disabled:bg-transparent disabled:opacity-50 disabled:shadow-none disabled:hover:bg-transparent',
          'aria-disabled:bg-transparent aria-disabled:opacity-50 aria-disabled:shadow-none aria-disabled:hover:bg-transparent',
        ],
      },
      // Radii are literal rather than `rounded-md`/`rounded-lg`: apps that
      // still carry a shadcn theme redefine the `--radius-*` scale, and these
      // corners should not move with it.
      size: {
        tiny: 'h-6 gap-1 rounded-[4px] px-1.5 text-button-12 [&_svg]:size-3',
        small: 'h-8 rounded-[6px] px-3 text-button-14 [&_svg]:size-4',
        medium: 'h-9 rounded-[6px] px-4 text-button-14 [&_svg]:size-4',
        large: 'h-10 rounded-[8px] px-5 text-button-16 [&_svg]:size-4',
      },
      // Icon-only buttons: square keeps the size's radius, circle is a pill.
      shape: {
        square: 'aspect-square px-0',
        circle: 'aspect-square rounded-full px-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'medium',
    },
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a `<button>`, keeping the styles. */
    asChild?: boolean;
  };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, shape, asChild = false, type, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button';

    return (
      <Comp
        ref={ref}
        // `type` only means anything on a real <button>; forwarding it to the
        // anchor (or whatever else) an `asChild` call site renders would be
        // invalid HTML.
        type={asChild ? type : (type ?? 'button')}
        className={cn(buttonVariants({ variant, size, shape, className }))}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { buttonVariants };
