import { Component, type CSSProperties, type ReactNode } from "react";
import { reportBoundaryError } from "@/core/telemetry/reporter";
import { isStaleChunkMessage } from "@/core/telemetry/crashReport";
import { isActivityMode } from "@/core/activity/runtime";

interface State {
  error: Error | null;
}

// Inline styles on purpose: this is the one screen that must render whatever
// else failed to load.
const panel: CSSProperties = {
  maxWidth: 520,
  margin: "10vh auto",
  padding: 24,
  background: "var(--app-bg-elevated)",
  border: "1px solid var(--app-border)",
  borderRadius: 12,
  color: "var(--app-text)",
  fontFamily: "var(--app-font-sans)",
};

const primaryButton: CSSProperties = {
  background: "var(--app-accent)",
  color: "#fff",
  padding: "8px 14px",
  border: 0,
  borderRadius: 4,
  cursor: "pointer",
};

const secondaryButton: CSSProperties = {
  ...primaryButton,
  background: "transparent",
  color: "var(--app-text)",
  border: "1px solid var(--app-border-strong)",
};

/**
 * "Start a blank message" (see `app/blankStart.ts`). Reached through the App
 * chunk the boot already loads, so this entry chunk stays free of the store —
 * and a failed import still leaves the editor opening without the link.
 */
async function startBlankMessage(): Promise<void> {
  try {
    const { startBlankMessage: start } = await import("@/app/App");
    start();
  } catch {
    window.location.assign("/");
  }
}

/**
 * Top-level error boundary. Catches runtime errors from any feature pane so a
 * bad component patch doesn't blank the whole editor. The fallback reloads in
 * place — keeping the address, share link and all — and on the web also offers
 * a blank start for the crash that reloading only repeats.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("[ErrorBoundary]", error);
    // A boundary swallows the error before it reaches window.onerror, so report
    // it here or it goes uncounted. Best-effort and self-gating.
    reportBoundaryError(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    // Deploy skew that nothing recovered: the tab predates the latest deploy
    // and a chunk it needs is gone (boot recovery exhausted, or a lazy path no
    // ChunkErrorBoundary covers). Not a bug in the app — say so, and reload
    // preserving the full URL: the `#hash` share payload and the autosaved
    // draft both survive.
    if (isStaleChunkMessage(this.state.error.message)) {
      return (
        <div role="alert" style={panel}>
          <h1 style={{ marginTop: 0, fontSize: 18 }}>A new version of DWEEB is available.</h1>
          <p style={{ color: "var(--app-text-muted)" }}>
            This tab was loaded before the latest update, and a part it needs is no longer
            available. Refresh to load the current version — your draft is saved on this device.
          </p>
          <button type="button" onClick={() => window.location.reload()} style={primaryButton}>
            Refresh
          </button>
        </div>
      );
    }
    // The Activity reloads in place only: its query carries `frame_id`, and
    // leaving for `/` would boot the web surface inside Discord. Nor does it
    // get a blank start — its message is the whole room's shared draft.
    const web = !isActivityMode();
    return (
      <div role="alert" style={panel}>
        <h1 style={{ marginTop: 0, fontSize: 18 }}>Something broke.</h1>
        <p style={{ color: "var(--app-text-muted)" }}>
          The builder hit an unexpected error and stopped. Reloading usually fixes it.
          {web
            ? " If the same error comes back, start a blank message instead — Undo can bring back the one you were editing."
            : ""}
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
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" onClick={() => window.location.reload()} style={primaryButton}>
            Reload
          </button>
          {web ? (
            <button type="button" onClick={() => void startBlankMessage()} style={secondaryButton}>
              Start a blank message
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}
