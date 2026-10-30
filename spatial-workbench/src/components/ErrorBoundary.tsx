import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(this.props.label || "Workbench", error, info.componentStack);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <section className="app-error" role="alert">
        <div>
          <h2>{this.props.label || "Workbench"} failed to render</h2>
          <p>{this.state.error.message}</p>
        </div>
        <button className="btn secondary" type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </section>
    );
  }
}