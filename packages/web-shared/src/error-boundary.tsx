'use client';

import { AlertCircle } from 'lucide-react';
import React, { type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional title for the error message */
  title?: string;
  /** Optional description for the error message */
  description?: string;
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
      return (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              {this.props.title || 'Error'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>
                {this.props.description ||
                  'An unexpected error occurred in this section.'}
              </AlertDescription>
            </Alert>

            <div className="bg-muted p-3 rounded-md text-sm font-mono text-muted-foreground overflow-auto max-h-48">
              <div className="text-xs font-semibold mb-2">Error details:</div>
              <div className="whitespace-pre-wrap break-words text-xs">
                {this.state.error.message}
              </div>
              {this.state.error.stack && (
                <div className="mt-2 opacity-60 text-xs">
                  {this.state.error.stack}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      );
    }

    return this.props.children;
  }
}
