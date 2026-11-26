import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider, TruncatedTooltip } from '@workflow/web-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

afterEach(cleanup);

function renderWithWidths(scrollWidth: number, clientWidth: number) {
  render(
    <TooltipProvider delayDuration={0}>
      <TruncatedTooltip content="wrun_01JQ full value">
        <button type="button">wrun_01JQ…</button>
      </TruncatedTooltip>
    </TooltipProvider>
  );
  const trigger = screen.getByRole('button');
  Object.defineProperty(trigger, 'scrollWidth', { value: scrollWidth });
  Object.defineProperty(trigger, 'clientWidth', { value: clientWidth });
  fireEvent.focus(trigger);
}

describe('TruncatedTooltip', () => {
  it('shows the full value when the text is cut off', async () => {
    renderWithWidths(200, 100);
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'wrun_01JQ full value'
    );
  });

  it('stays closed when the text fits', () => {
    renderWithWidths(100, 100);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
