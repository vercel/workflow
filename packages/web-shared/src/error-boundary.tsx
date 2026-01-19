'use client';

import React, { type ReactNode } from 'react';
import { ErrorCard } from './components/ui/error-card';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional title for the error message */
  title?: string;
  /** Optional fallback component to render on error */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary component that catches errors in child components
 * and displays them without breaking the entire application.
 *
 * Errors are localized to this boundary, so other parts of the UI
 * remain functional.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error for debugging
    console.error('Error caught by boundary:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
    });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleReset);
      }

      // Default error UI
      const errorDetails = this.state.error.stack
        ? `${this.state.error.message}\n\n${this.state.error.stack}`
        : this.state.error.message;

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
