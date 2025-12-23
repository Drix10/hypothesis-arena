/**
 * Error Boundary Component
 *
 * Catches React errors and displays a fallback UI
 * Prevents the entire app from crashing due to component errors
 */

import { Component, ErrorInfo, ReactNode } from "react";
import { logger } from "../../services/utils/logger";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log error details (sanitized - no sensitive data)
    logger.error("React Error Boundary caught an error:", {
      message: error.message,
      stack: error.stack?.slice(0, 500), // Truncate stack trace
      componentStack: errorInfo.componentStack?.slice(0, 500),
    });
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
    });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // Custom fallback UI
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI
      return (
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="max-w-md w-full glass-card rounded-2xl p-8 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bear/20 flex items-center justify-center">
              <span className="text-3xl">⚠️</span>
            </div>
            <h2 className="text-xl font-bold text-white mb-2">
              Something went wrong
            </h2>
            <p className="text-slate-400 mb-6">
              {this.state.error?.message || "An unexpected error occurred"}
            </p>
            <button
              onClick={this.handleReset}
              className="btn-primary px-6 py-2.5 rounded-lg font-medium"
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="ml-3 px-6 py-2.5 rounded-lg font-medium text-slate-400 hover:text-white transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
