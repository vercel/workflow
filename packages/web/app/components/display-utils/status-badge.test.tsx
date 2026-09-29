import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@workflow/web-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBadge } from './status-badge';

// The tooltip arrow measures itself with ResizeObserver, which jsdom does not
// implement. A no-op stub is enough for these assertions.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

afterEach(cleanup);

describe('StatusBadge', () => {
  it('shows the cancellation reason from the canceled status', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <StatusBadge
          status="cancelled"
          context={{ cancelReason: 'stopped by operator' }}
        />
      </TooltipProvider>
    );

    fireEvent.focus(screen.getByRole('button'));

    expect(await screen.findAllByText('stopped by operator')).not.toHaveLength(
      0
    );
  });

  it('does not make a canceled status interactive without a reason', () => {
    render(<StatusBadge status="cancelled" />);

    expect(screen.queryByRole('button')).toBeNull();
  });
});
