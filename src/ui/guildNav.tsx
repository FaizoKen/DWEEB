import type { ComponentType } from "react";
import type { GuildNavType } from "@/features/preview/markdown/parse";
import { CompassIcon, HashIcon, LinkIcon, SettingsIcon } from "@/ui/Icon";

/**
 * The handful of built-in "guild navigation" mentions Discord supports
 * (`<id:type>`). One definition feeds both the preview renderer and the
 * toolbar menu so the label and icon stay in lockstep across them.
 */
export interface GuildNavItem {
  type: GuildNavType;
  /** The exact token inserted into the message, e.g. `<id:browse>`. */
  snippet: string;
  /** How Discord labels the rendered pill. */
  label: string;
  /** Leading glyph, sized by the consumer. */
  Icon: ComponentType<{ size?: number; className?: string }>;
}

/** In the order Discord surfaces them. */
export const GUILD_NAV_ITEMS: readonly GuildNavItem[] = [
  { type: "browse", snippet: "<id:browse>", label: "Browse Channels", Icon: HashIcon },
  { type: "customize", snippet: "<id:customize>", label: "Channels & Roles", Icon: SettingsIcon },
  { type: "guide", snippet: "<id:guide>", label: "Server Guide", Icon: CompassIcon },
  {
    type: "linked-roles",
    snippet: "<id:linked-roles>",
    label: "Linked Roles",
    Icon: LinkIcon,
  },
];

export const GUILD_NAV_BY_TYPE: Record<GuildNavType, GuildNavItem> = Object.fromEntries(
  GUILD_NAV_ITEMS.map((item) => [item.type, item]),
) as Record<GuildNavType, GuildNavItem>;
