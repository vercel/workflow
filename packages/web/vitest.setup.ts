/**
 * jsdom does not implement ResizeObserver, which Radix uses to measure the
 * tooltip arrow. Provide a no-op stub so component tests can render tooltips.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
