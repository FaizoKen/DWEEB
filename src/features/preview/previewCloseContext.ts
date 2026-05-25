/**
 * Lets nested preview renderers ask the surrounding pane to close itself.
 *
 * Only meaningful on mobile, where the preview is a slide-over: tapping a
 * component to inspect it should reveal the editor underneath. On desktop
 * both panes are always visible, so the close call is a no-op for UX (it
 * just resets the previewOpen flag in App state).
 */

import { createContext, useContext } from "react";

export const PreviewCloseContext = createContext<(() => void) | null>(null);

export const usePreviewClose = () => useContext(PreviewCloseContext);
