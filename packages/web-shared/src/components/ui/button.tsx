import { Slot } from '@radix-ui/react-slot';
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
 * same. The label's span holds 6px of the horizontal padding so the label
 * can truncate, which is why each size's own padding is 6px short.
 */
const buttonVariants = cva(
  [
    'group/trigger relative m-0 inline-flex max-w-full shrink-0 items-center justify-center',
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
    // A single focus shadow utility; a variant changes the ring through
    // --themed-focus-ring rather than a second, conflicting utility.
    'focus-visible:shadow-[var(--themed-focus-ring,_var(--ds-focus-ring))] focus-visible:transition-none',
    '[&_svg]:shrink-0',
    // Icons in the prefix and suffix slots use the decoration size. The
    // attribute keeps this rule more specific than each size's `[&_svg]` rule.
    '[&_[data-button-slot]_svg]:size-[var(--ds-control-decoration-size)]',
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
          // The focus ring keeps the 1px border inside it.
          '[--themed-focus-ring:_0_0_0_1px_var(--themed-border),0_0_0_2px_var(--ds-background-100),0_0_0_4px_var(--ds-focus-color)]',
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
      size: {
        small: 'h-8 rounded-md px-1.5 text-button-14 [&_svg]:size-4',
        medium: 'h-9 rounded-md px-2.5 text-button-14 [&_svg]:size-4',
        large: 'h-10 rounded-lg px-3.5 text-button-16 [&_svg]:size-4',
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

const SPINNER_SIZE: Record<Size, SpinnerSize> = {
  small: 'sm',
  medium: 'md',
  large: 'lg',
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

function ButtonContent({
  size,
  iconOnly,
  loading,
  prefix,
  suffix,
  children,
}: {
  size: Size;
  iconOnly: boolean;
  loading: boolean;
  prefix: React.ReactNode;
  suffix: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      {loading || prefix != null ? (
        <span
          data-button-slot="prefix"
          aria-hidden={loading || undefined}
          className="mr-[3px] flex min-w-5 shrink-0 items-center justify-center"
        >
          {loading ? <Spinner size={SPINNER_SIZE[size]} /> : prefix}
        </span>
      ) : null}
      <span
        className={cn(
          'px-1.5',
          iconOnly
            ? 'inline-flex shrink-0 items-center justify-center'
            : 'truncate'
        )}
      >
        {children}
      </span>
      {suffix != null ? (
        <span
          data-button-slot="suffix"
          className="mr-0.5 ml-1 flex shrink-0 items-center justify-center"
        >
          {suffix}
        </span>
      ) : null}
    </>
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
    const content = (label: React.ReactNode) => (
      <ButtonContent
        size={size ?? 'medium'}
        iconOnly={shape != null}
        loading={loading}
        prefix={prefix}
        suffix={suffix}
      >
        {label}
      </ButtonContent>
    );
    const shared = {
      ref,
      className: cn(buttonVariants({ variant, size, shape }), className),
      'aria-busy': loading || undefined,
      ...props,
    };

    // With `asChild`, the child element (a link, usually) becomes the button
    // and its own children go in the label slot.
    if (asChild) {
      const child = React.Children.only(children) as React.ReactElement<{
        children?: React.ReactNode;
      }>;
      return (
        <Slot {...shared} aria-disabled={disabled || loading || undefined}>
          {React.cloneElement(child, undefined, content(child.props.children))}
        </Slot>
      );
    }

    return (
      <button
        {...shared}
        type={type ?? 'button'}
        disabled={disabled || loading}
      >
        {content(children)}
      </button>
    );
  }
);
Button.displayName = 'Button';

export { buttonVariants };
