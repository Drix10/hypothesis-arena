/**
 * Error Boundary - Catches React errors and displays fallback UI
 *
 * Prevents entire app from crashing when a component throws an error.
 */

import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log full error details for developers (before rendering sanitized UI)
    console.error("ErrorBoundary caught an error:", error.message, error.stack);
    console.error("Component stack:", errorInfo.componentStack);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Only show actual error message in development, sanitize for production
      const isDev = process.env.NODE_ENV === "development";
      const displayMessage =
        isDev && this.state.error?.message
          ? this.state.error.message
          : "An unexpected error occurred. Please try again.";

      return (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <div className="text-6xl mb-4">⚠️</div>
          <h2 className="text-xl font-bold text-white mb-2">
            Something went wrong
          </h2>
          <p className="text-slate-400 mb-4 max-w-md">{displayMessage}</p>
          <button
            onClick={this.handleRetry}
            className="px-6 py-3 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 transition-all font-semibold"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
