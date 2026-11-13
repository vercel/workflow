import { act, cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { useOptimisticSearchParams } from './url-state';

function TabProbe() {
  const [searchParams, updateSearchParams] = useOptimisticSearchParams();
  const location = useLocation();
  return (
    <div>
      <span data-testid="tab">{searchParams.get('tab') ?? 'runs'}</span>
      <span data-testid="search">{location.search}</span>
      <button
        type="button"
        onClick={() => updateSearchParams({ tab: 'hooks', streamId: null })}
      >
        hooks
      </button>
    </div>
  );
}

describe('useOptimisticSearchParams', () => {
  afterEach(cleanup);

  it('shows the new value before a slow navigation commits, then the URL', async () => {
    let releaseLoader: () => void = () => {};
    let loaderCalls = 0;
    const router = createMemoryRouter(
      [
        {
          path: '/',
          // The first call resolves (initial load); later calls stay pending
          // until released, standing in for a slow server round trip.
          loader: () => {
            loaderCalls += 1;
            if (loaderCalls === 1) return null;
            return new Promise<null>((resolve) => {
              releaseLoader = () => resolve(null);
            });
          },
          Component: TabProbe,
        },
      ],
      { initialEntries: ['/?tab=runs&streamId=abc'] }
    );

    render(<RouterProvider router={router} />);
    await screen.findByText('hooks');
    expect(screen.getByTestId('tab').textContent).toBe('runs');

    act(() => {
      screen.getByText('hooks').click();
    });

    // Optimistic: the tab flips on the click while the navigation is pending.
    expect(screen.getByTestId('tab').textContent).toBe('hooks');
    expect(screen.getByTestId('search').textContent).toBe(
      '?tab=runs&streamId=abc'
    );

    await act(async () => {
      releaseLoader();
    });

    expect(screen.getByTestId('search').textContent).toBe('?tab=hooks');
    expect(screen.getByTestId('tab').textContent).toBe('hooks');
  });
});
