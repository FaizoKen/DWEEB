/**
 * Dismissible test-mode banner across the very top of the app.
 *
 * DWEEB is still in public testing: features change underneath users between
 * deploys, and both local drafts and server-side data (sent components,
 * permanent slots) may be reset without notice. This banner sets that
 * expectation up front, before anyone invests real work in a message.
 *
 * Dismissal is deliberately not persisted — closing the banner only hides it
 * for the current page view, and every refresh or revisit shows it again so
 * the warning stays in front of users for as long as the app is in testing.
 */

import { useState } from "react";
import { AlertTriangleIcon, CloseIcon } from "@/ui/Icon";

export function TestModeNotice() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="test-notice" role="status">
      <AlertTriangleIcon size={15} aria-hidden="true" />
      <p className="test-notice__text">
        <strong>Heads up — DWEEB is in test mode.</strong> Features are still being built and may
        change or break without warning, and saved data can be reset at any time. Please don&apos;t
        rely on it for anything important yet.
      </p>
      <button
        type="button"
        className="test-notice__dismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss the test-mode notice"
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}
