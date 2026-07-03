import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. Catches runtime errors from any feature pane so a
 * bad component patch doesn't blank the whole editor. The fallback offers a
 * "reset to default preset" escape hatch.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("[ErrorBoundary]", error);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          maxWidth: 520,
          margin: "10vh auto",
          padding: 24,
          background: "var(--app-bg-elevated)",
          border: "1px solid var(--app-border)",
          borderRadius: 12,
          color: "var(--app-text)",
          fontFamily: "var(--app-font-sans)",
        }}
      >
        <h1 style={{ marginTop: 0, fontSize: 18 }}>Something broke.</h1>
        <p style={{ color: "var(--app-text-muted)" }}>
          The builder hit an unexpected error and stopped. Reloading the page usually fixes it. If
          it doesn't, your share URL may be corrupt — open the page without the hash.
        </p>
        <pre
          style={{
            background: "var(--app-bg)",
            padding: 10,
            borderRadius: 6,
            color: "var(--app-text-muted)",
            fontSize: 12,
            overflow: "auto",
          }}
        >
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => {
            this.reset();
            window.location.assign("/");
          }}
          style={{
            background: "var(--app-accent)",
            color: "#fff",
            padding: "8px 14px",
            border: 0,
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Reload editor
        </button>
      </div>
    );
  }
}
