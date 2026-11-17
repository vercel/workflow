import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import {
  CopyButton,
  TextWithCopyButton,
  ToastProvider,
} from '@workflow/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeText = vi.fn<(text: string) => Promise<void>>();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  toast.error.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderWithToast(ui: React.ReactElement) {
  return render(<ToastProvider toast={toast}>{ui}</ToastProvider>);
}

describe('CopyButton', () => {
  it('copies the text and announces it politely, then resets', async () => {
    vi.useFakeTimers();
    renderWithToast(<CopyButton text="wrun_123" label="Copy run ID" />);

    const button = screen.getByRole('button', { name: 'Copy run ID' });
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');

    await act(async () => {
      fireEvent.click(button);
    });

    expect(writeText).toHaveBeenCalledWith('wrun_123');
    expect(status.textContent).toBe('Copied');

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(status.textContent).toBe('');
  });

  it('reports a clipboard failure', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    renderWithToast(<CopyButton text="x" />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Copy to clipboard' })
      );
    });

    expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard');
    expect(screen.getByRole('status').textContent).toBe(
      'Failed to copy to clipboard'
    );
  });

  it('resolves lazy text on click', async () => {
    const resolve = vi.fn().mockResolvedValue('secret-token');
    renderWithToast(<CopyButton text={resolve} label="Copy token" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    });

    expect(resolve).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('secret-token');
  });

  it('does not propagate the click to a clickable row', async () => {
    const onRowClick = vi.fn();
    renderWithToast(
      // biome-ignore lint/a11y/useKeyWithClickEvents: test-only row
      // biome-ignore lint/a11y/noStaticElementInteractions: test-only row
      <div onClick={onRowClick}>
        <CopyButton text="x" />
      </div>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });

    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('TextWithCopyButton', () => {
  it('reveals the button on hover and on keyboard focus', () => {
    renderWithToast(
      <TextWithCopyButton text="wrun_123" label="Copy run ID">
        wrun_123
      </TextWithCopyButton>
    );

    const button = screen.getByRole('button', { name: 'Copy run ID' });
    expect(button.className).toContain('group-hover/copy:opacity-100');
    expect(button.className).toContain('group-focus-within/copy:opacity-100');
    expect(button.parentElement?.className).toContain('group/copy');
  });
});
