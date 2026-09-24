import React from "react";
import { DiscordScale, UiScale } from "../../components/editor";
import { EDITOR_V } from "../contracts";
import { SURFACE_V } from "../templates/geometry";

/**
 * A layer exactly over the portrait editor's content box (inside its 1px
 * border), at the editor's zooms — for things that float above the whole
 * surface: the pick toast, the add menu. Children position themselves in
 * surface-local px, the same space the PortraitEditor lays out in.
 */
export const SurfaceOverlayV: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ position: "absolute", left: SURFACE_V.x, top: SURFACE_V.y, width: SURFACE_V.w, height: SURFACE_V.h }}>
    <UiScale k={EDITOR_V.k}>
      <DiscordScale k={EDITOR_V.dk}>{children}</DiscordScale>
    </UiScale>
  </div>
);
