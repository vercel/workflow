import { cleanup, render, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock react-router hooks — must be before importing the component under test.
const useRouteErrorMock = vi.fn();
vi.mock('react-router', async () => {
  const actual =
    await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useRouteError: () => useRouteErrorMock(),
    useNavigate: () => vi.fn(),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  };
});

import { ErrorBoundary, shouldRevalidate } from './root';

function Wrapper({ children }: PropsWithChildren) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe('ErrorBoundary', () => {
  afterEach(cleanup);
  it('renders a 404 page for unmatched routes', () => {
    useRouteErrorMock.mockReturnValue({
      status: 404,
      statusText: 'Not Found',
      internal: true,
      data: 'Error: No route matches URL "/robots.txt"',
    });

    render(<ErrorBoundary />, { wrapper: Wrapper });

    expect(screen.getByText('404')).toBeDefined();
    expect(screen.getByText('This page does not exist.')).toBeDefined();
    expect(
      screen.getByRole('link', { name: /go to dashboard/i })
    ).toBeDefined();
  });

  it('renders a generic error page for non-404 errors', () => {
    useRouteErrorMock.mockReturnValue(new Error('Something broke'));

    render(<ErrorBoundary />, { wrapper: Wrapper });

    expect(screen.getByText('Error')).toBeDefined();
    expect(screen.getByText('Something went wrong.')).toBeDefined();
    expect(
      screen.getByRole('link', { name: /go to dashboard/i })
    ).toBeDefined();
  });

  it('renders a generic error page for 500 route errors', () => {
    useRouteErrorMock.mockReturnValue({
      status: 500,
      statusText: 'Internal Server Error',
      internal: true,
      data: 'Server error',
    });

    render(<ErrorBoundary />, { wrapper: Wrapper });

    expect(screen.getByText('Error')).toBeDefined();
    expect(screen.getByText('Something went wrong.')).toBeDefined();
  });

  it('links back to the dashboard root', () => {
    useRouteErrorMock.mockReturnValue({
      status: 404,
      statusText: 'Not Found',
      internal: true,
      data: '',
    });

    render(<ErrorBoundary />, { wrapper: Wrapper });

    const link = screen.getByRole('link', { name: /go to dashboard/i });
    expect(link.getAttribute('href')).toBe('/');
  });
});

describe('shouldRevalidate', () => {
  const base = 'http://localhost/';
  const args = (
    current: string,
    next: string,
    formMethod?: 'GET' | 'POST'
  ): Parameters<typeof shouldRevalidate>[0] =>
    ({
      currentUrl: new URL(current, base),
      nextUrl: new URL(next, base),
      currentParams: {},
      nextParams: {},
      formMethod,
      defaultShouldRevalidate: true,
    }) as Parameters<typeof shouldRevalidate>[0];

  it('skips the server round trip when only search params change', () => {
    expect(shouldRevalidate(args('/?tab=runs', '/?tab=hooks'))).toBe(false);
    expect(shouldRevalidate(args('/run/r1', '/run/r1?tab=events'))).toBe(false);
  });

  it('skips the server round trip on client-side page changes', () => {
    expect(shouldRevalidate(args('/?tab=runs', '/run/r1'))).toBe(false);
  });

  it('keeps the default after a mutation', () => {
    expect(shouldRevalidate(args('/', '/', 'POST'))).toBe(true);
  });

  it('keeps the default for explicit revalidation', () => {
    expect(shouldRevalidate(args('/run/r1', '/run/r1'))).toBe(true);
  });
});
