'use client';

import React, { ReactNode, ReactElement } from 'react';
import { Card } from './Card';
import { Button } from './Button';
import { spacing, typography } from '@/lib/design-tokens';

interface Props {
  children: ReactNode;
  fallback?: ReactElement;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorCount: number;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorCount: 0,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorCount: 1,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState(prev => ({
      errorCount: prev.errorCount + 1,
    }));
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorCount: 0,
    });
  };

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div
            className="flex items-center justify-center min-h-screen"
            style={{ backgroundColor: '#f9fafb' }}
          >
            <Card variant="glass" className="max-w-md">
              <div className="text-center">
                <div
                  className="text-6xl mb-4"
                  style={{ fontSize: '3rem', lineHeight: '1' }}
                >
                  ⚠️
                </div>
                <h1
                  className="text-2xl font-bold text-gray-900 mb-2"
                  style={{
                    fontSize: typography.fontSize['2xl'].size,
                    fontWeight: typography.fontWeight.bold,
                  }}
                >
                  Oops! Something went wrong
                </h1>
                <p
                  className="text-gray-600 mb-4"
                  style={{
                    fontSize: typography.fontSize.sm.size,
                  }}
                >
                  {this.state.error?.message || 'An unexpected error occurred'}
                </p>

                {process.env.NODE_ENV === 'development' && (
                  <div
                    className="bg-gray-100 p-3 rounded-lg mb-4 text-left text-xs text-gray-700 overflow-auto max-h-40"
                    style={{
                      fontSize: typography.fontSize.xs.size,
                    }}
                  >
                    <pre className="whitespace-pre-wrap break-words">
                      {this.state.error?.stack}
                    </pre>
                  </div>
                )}

                <div className="flex gap-3 justify-center">
                  <Button
                    variant="primary"
                    onClick={this.handleReset}
                  >
                    Try Again
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => (window.location.href = '/')}
                  >
                    Go Home
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        )
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
