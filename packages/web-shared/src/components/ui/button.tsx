import { Slot, Slottable } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../../lib/cn';
import { Spinner, type SpinnerSize } from './spinner';

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
 * The focus ring is an arbitrary box-shadow, because bare `outline` and
 * arbitrary-colour utilities differ between Tailwind v3 and v4.
 */
const buttonVariants = cva(
  [
    'group/trigger relative m-0 inline-flex max-w-full shrink-0 items-center justify-center gap-2',
    'cursor-pointer select-none whitespace-nowrap border-0 align-baseline font-sans font-medium no-underline outline-none',
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
    'transition-all duration-150 ease-in-out',
    // The ring replaces the border: a 2px gap in the page colour, then 2px of
    // the focus colour. It appears at once rather than fading in.
    'focus-visible:shadow-[0_0_0_2px_var(--ds-background-100),0_0_0_4px_var(--ds-focus-color)] focus-visible:transition-none',
    '[&_svg]:shrink-0',
    // Icons in the prefix and suffix slots are a step smaller than an
    // icon-only button's. The attribute keeps this rule more specific than
    // each size's `[&_svg]` rule.
    '[&_[data-button-slot]_svg]:size-3.5',
    // Disabled buttons flatten to the gray-100 fill with a gray-400 border.
    'disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-700 disabled:[--themed-border:_var(--ds-gray-400)] disabled:hover:bg-gray-100',
    'aria-disabled:cursor-not-allowed aria-disabled:bg-gray-100 aria-disabled:text-gray-700 aria-disabled:[--themed-border:_var(--ds-gray-400)] aria-disabled:hover:bg-gray-100',
  ],
  {
    variants: {
      variant: {
        // Literal hover fills for the inverted default type: no `--ds-*`
        // token sits one step off gray-1000.
        default: [
          '[--themed-hover-bg:_hsl(0,_0%,_22%)]',
          'dark:[--themed-hover-bg:_hsl(0,_0%,_80%)]',
        ],
        secondary: [
          '[--themed-bg:_var(--ds-background-100)]',
          '[--themed-fg:_var(--ds-gray-1000)]',
          '[--themed-border:_var(--ds-gray-400)]',
          '[--themed-hover-bg:_var(--ds-gray-100)]',
          'dark:[--themed-hover-bg:_var(--ds-gray-200)]',
        ],
        // Tertiary is the one variant allowed to go borderless when disabled;
        // it keeps its text colour and drops to 50% opacity instead.
        tertiary: [
          '[--themed-bg:_transparent]',
          '[--themed-fg:_var(--ds-gray-1000)]',
          '[--themed-border:_transparent]',
          // The alpha token already flips with the theme.
          '[--themed-hover-bg:_var(--ds-gray-alpha-200)]',
          'disabled:bg-transparent disabled:text-gray-1000 disabled:opacity-50 disabled:shadow-none disabled:hover:bg-transparent',
          'aria-disabled:bg-transparent aria-disabled:text-gray-1000 aria-disabled:opacity-50 aria-disabled:shadow-none aria-disabled:hover:bg-transparent',
        ],
      },
      // Labels are set at 1.5x line height.
      size: {
        tiny: 'h-6 gap-1 rounded-sm px-1.5 text-button-12 [&_svg]:size-3 [&_[data-button-slot]_svg]:size-3',
        small: 'h-8 rounded-md px-3 text-[14px] leading-normal [&_svg]:size-4',
        medium: 'h-9 rounded-md px-4 text-[14px] leading-normal [&_svg]:size-4',
        large: 'h-10 rounded-lg px-5 text-[16px] leading-normal [&_svg]:size-4',
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

type Size = NonNullable<VariantProps<typeof buttonVariants>['size']>;

/**
 * Slot geometry per size. The label sits 6px in from whatever is beside it,
 * so a side with a slot gives up those 6px of padding and the slot adds them
 * back after the 8px gap: a 20px prefix slot with 1px of margin, and a suffix
 * slot 2px further out with 2px of margin on its far side. Tiny keeps its own
 * compact layout, with 12px slots and no extra spacing.
 */
const SLOTS: Record<
  Size,
  {
    prefix: string;
    suffix: string;
    padStart: string;
    padEnd: string;
    spinner: SpinnerSize;
  }
> = {
  tiny: {
    prefix: 'min-w-3',
    suffix: '',
    padStart: '',
    padEnd: '',
    spinner: 'sm',
  },
  small: {
    prefix: 'min-w-5 mr-px',
    suffix: 'mx-0.5',
    padStart: 'pl-1.5',
    padEnd: 'pr-1.5',
    spinner: 'sm',
  },
  medium: {
    prefix: 'min-w-5 mr-px',
    suffix: 'mx-0.5',
    padStart: 'pl-2.5',
    padEnd: 'pr-2.5',
    spinner: 'md',
  },
  large: {
    prefix: 'min-w-5 mr-px',
    suffix: 'mx-0.5',
    padStart: 'pl-3.5',
    padEnd: 'pr-3.5',
    spinner: 'lg',
  },
};

export type ButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'prefix'
> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a `<button>`, keeping the styles. */
    asChild?: boolean;
    /**
     * Show a spinner in place of `prefix`, disable the button and set
     * `aria-busy`. The label stays, and with a `prefix` the width does not
     * change, because the spinner takes the prefix's slot.
     */
    loading?: boolean;
    /** Element before the label, usually an icon. */
    prefix?: React.ReactNode;
    /** Element after the label, usually an icon. */
    suffix?: React.ReactNode;
  };

/** The padding a side gives up to the slot beside the label. */
function slotPadding(
  size: Size,
  shape: ButtonProps['shape'],
  hasPrefix: boolean,
  hasSuffix: boolean
) {
  if (shape) return undefined;
  return cn(hasPrefix && SLOTS[size].padStart, hasSuffix && SLOTS[size].padEnd);
}

/**
 * The prefix or suffix slot. The prefix is a fixed width, so swapping it for
 * the spinner doesn't move the label.
 */
function ButtonSlot({
  side,
  size,
  loading,
  children,
}: {
  side: 'prefix' | 'suffix';
  size: Size;
  loading?: boolean;
  children: React.ReactNode;
}) {
  const slots = SLOTS[size];
  return (
    <span
      data-button-slot={side}
      aria-hidden={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center',
        slots[side]
      )}
    >
      {loading ? <Spinner size={slots.spinner} /> : children}
    </span>
  );
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      shape,
      asChild = false,
      loading = false,
      prefix,
      suffix,
      disabled,
      type,
      children,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button';
    const hasPrefix = loading || prefix != null;
    const hasSuffix = suffix != null;
    const slotSize = size ?? 'medium';
    const shared = {
      ref,
      // `type` only means anything on a real <button>; forwarding it to the
      // anchor (or whatever else) an `asChild` call site renders would be
      // invalid HTML.
      type: asChild ? type : (type ?? 'button'),
      className: cn(
        buttonVariants({ variant, size, shape }),
        slotPadding(slotSize, shape, hasPrefix, hasSuffix),
        className
      ),
      disabled: asChild ? disabled : disabled || loading,
      'aria-busy': loading || undefined,
      'aria-disabled': asChild && loading ? true : undefined,
      ...props,
    };

    // Without a prefix or suffix the children go through untouched, which
    // `asChild` needs: Slot only accepts a single child element.
    if (!hasPrefix && !hasSuffix) {
      return <Comp {...shared}>{children}</Comp>;
    }

    return (
      <Comp {...shared}>
        {hasPrefix ? (
          <ButtonSlot side="prefix" size={slotSize} loading={loading}>
            {prefix}
          </ButtonSlot>
        ) : null}
        {asChild ? <Slottable>{children}</Slottable> : children}
        {hasSuffix ? (
          <ButtonSlot side="suffix" size={slotSize}>
            {suffix}
          </ButtonSlot>
        ) : null}
      </Comp>
    );
  }
);
Button.displayName = 'Button';

export { buttonVariants };
