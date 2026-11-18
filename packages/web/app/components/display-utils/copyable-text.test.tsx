import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@workflow/web-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Table, TableBody, TableCell, TableRow } from '~/components/ui/table';
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

function pressCopy(text: string | (() => Promise<string>)) {
  const onRowClick = vi.fn();
  render(
    <ToastProvider toast={toast}>
      <TooltipProvider>
        <Table>
          <TableBody>
            <TableRow onClick={onRowClick}>
              <TableCell>
                <CopyableText text={text} overlay>
                  value
                </CopyableText>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
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
