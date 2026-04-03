'use client';

import type { ReactNode } from 'react';
import { Component } from 'react';
import { ErrorCard } from './ui/error-card';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback UI to render on error. When omitted, a default ErrorCard is shown. */
  fallback?: ReactNode;
  /** Optional title for the default error card (used when no fallback is provided) */
  title?: string;
  /** Optional callback when an error is caught */
  onCatch?: (error: unknown, retry: () => void) => void;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, error };
  }

  retry(): void {
    this.setState({ hasError: false, error: null });
  }

  componentDidCatch(error: unknown, errorInfo: unknown): void {
    if (process.env.NODE_ENV === 'development') {
      console.error(error, errorInfo);
    }
    this.props.onCatch?.(error, () => this.retry());
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      const err = this.state.error instanceof Error ? this.state.error : null;
      const errorDetails = err?.stack
        ? `${err.message}\n\n${err.stack}`
        : (err?.message ?? 'Unknown error');

      return (
        <ErrorCard
          title={this.props.title || 'An error occurred'}
          details={errorDetails}
        />
      );
    }

    return this.props.children;
  }
}
