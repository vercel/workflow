'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { type ComponentProps, useRef } from 'react';
import { cn } from '../../lib/cn';

const Modal = DialogPrimitive.Root;

function ModalContent({
  className,
  children,
  onKeyDown,
  onFocusCapture,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  const openerRef = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--ds-z-modal)] bg-[var(--ds-overlay-backdrop-color)] opacity-[var(--ds-overlay-backdrop-opacity)] transition-opacity duration-[var(--ds-motion-overlay-duration)] ease-[var(--ds-motion-overlay-timing)] starting:opacity-0 motion-reduce:transition-none" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          'fixed top-1/2 left-1/2 z-[var(--ds-z-modal)] flex max-h-[min(800px,80vh)] w-[540px] max-w-full -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-xl bg-background-100 text-gray-1000 shadow-[var(--ds-shadow-modal-elevated)] outline-none max-[540px]:max-w-[calc(100vw-20px)] sm:overflow-clip',
          'transition-[opacity,scale] duration-[var(--ds-motion-overlay-duration)] ease-[var(--ds-motion-overlay-timing)] starting:scale-[var(--ds-motion-overlay-scale)] starting:opacity-0 motion-reduce:transition-none',
          className
        )}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          e.stopPropagation();
        }}
        onFocusCapture={(e) => {
          if (
            !openerRef.current &&
            !e.currentTarget.contains(e.relatedTarget)
          ) {
            openerRef.current =
              e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
          }
          onFocusCapture?.(e);
        }}
        onOpenAutoFocus={(e) => {
          const opener = document.activeElement;
          openerRef.current ??= opener instanceof HTMLElement ? opener : null;
          onOpenAutoFocus?.(e);
        }}
        onCloseAutoFocus={(e) => {
          const opener = openerRef.current;
          openerRef.current = null;
          onCloseAutoFocus?.(e);
          if (e.defaultPrevented) return;
          e.preventDefault();
          opener?.focus();
        }}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function ModalHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      className={cn('mb-5 text-gray-1000 last:mb-0', className)}
      {...props}
    />
  );
}

function ModalTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-heading-20 text-gray-1000', className)}
      {...props}
    />
  );
}

function ModalBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'relative overflow-x-hidden p-5 text-copy-14 text-gray-900 sm:overflow-y-auto dark:bg-background-200',
        className
      )}
      {...props}
    />
  );
}

function ModalActions({ className, ...props }: ComponentProps<'footer'>) {
  return (
    <footer
      className={cn(
        'sticky bottom-0 flex shrink-0 justify-between bg-background-200 p-3 shadow-[0_-1px_0_0_var(--ds-gray-alpha-400)]',
        className
      )}
      {...props}
    />
  );
}

export {
  Modal,
  ModalActions,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalTitle,
};
