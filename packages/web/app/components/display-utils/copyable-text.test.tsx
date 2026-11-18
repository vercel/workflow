import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@workflow/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyableText } from './copyable-text';

const writeText = vi.fn<(text: string) => Promise<void>>();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  toast.error.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(cleanup);

/**
 * Renders the text inside a clickable row, as the tables do, and presses copy.
 * The button is also a tooltip trigger, so this covers the click reaching it.
 */
function pressCopy(text: string | (() => Promise<string>)) {
  const onRowClick = vi.fn();
  render(
    <ToastProvider toast={toast}>
      <TooltipProvider>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: stands in for a clickable table row */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: stands in for a clickable table row */}
        <div onClick={onRowClick}>
          <CopyableText text={text}>value</CopyableText>
        </div>
      </TooltipProvider>
    </ToastProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
  return { onRowClick };
}

describe('CopyableText', () => {
  it('copies the text without clicking the row', async () => {
    const { onRowClick } = pressCopy('wrun_123');

    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('wrun_123');
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('copies text that is fetched on press', async () => {
    pressCopy(async () => 'secret-token');

    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('secret-token');
  });

  it('shows an error toast when the copy fails', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    pressCopy('wrun_123');

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard')
    );
    expect(screen.queryByText('Copied')).toBeNull();
  });
});
