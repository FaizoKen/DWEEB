import React from "react";

export type IconName =
  | "bot"
  | "rocket"
  | "gift"
  | "notes"
  | "link"
  | "sparkle"
  | "check"
  | "search"
  | "blocks"
  | "lock"
  | "ticket"
  | "users"
  | "clock"
  | "shield"
  | "infinity"
  | "wand"
  | "plug"
  | "calendar"
  | "pencil"
  | "upload"
  | "download"
  | "save"
  | "bellOff"
  | "id"
  | "globe"
  | "refresh"
  | "hash"
  | "megaphone"
  | "plus"
  | "external"
  | "form"
  | "reply"
  | "gauge"
  | "history"
  | "send"
  | "smile"
  | "at"
  | "braces"
  | "eye";

/** Crisp, monochrome line icons so the film never relies on platform emoji. */
export const Icon: React.FC<{ name: IconName; size?: number; color?: string }> = ({
  name,
  size = 22,
  color = "currentColor",
}) => {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const soft = `${color}22`;

  switch (name) {
    case "bot":
      return (
        <svg {...common}>
          <rect x="4.5" y="7.5" width="15" height="11" rx="3.5" fill={soft} />
          <path d="M12 4V7.5" />
          <circle cx="12" cy="3.2" r="1.4" fill={color} stroke="none" />
          <circle cx="9.4" cy="12.8" r="1.4" fill={color} stroke="none" />
          <circle cx="14.6" cy="12.8" r="1.4" fill={color} stroke="none" />
          <path d="M9.6 16h4.8" />
        </svg>
      );
    case "rocket":
      return (
        <svg {...common}>
          <path d="M13.6 3.4c3 1.3 4.9 4.1 4.9 8l-2.2 2.5H11l-1.9-2.5c0-3.9 1.9-6.7 4.5-8Z" fill={soft} />
          <circle cx="14" cy="9" r="1.5" fill={color} stroke="none" />
          <path d="M10.6 16.3 8.4 20l3.3-1.8M16 16.3 18.2 20l-3.3-1.8" />
        </svg>
      );
    case "gift":
      return (
        <svg {...common}>
          <rect x="3.5" y="9" width="17" height="11" rx="2" fill={soft} />
          <path d="M3.5 13H20.5M12 9V20" />
          <path d="M12 9C9 9 7.6 4.8 10 4.1 12 3.6 12 9 12 9ZM12 9C15 9 16.4 4.8 14 4.1 12 3.6 12 9 12 9Z" fill={color} stroke="none" />
        </svg>
      );
    case "notes":
      return (
        <svg {...common}>
          <rect x="5" y="3.5" width="14" height="17" rx="2" fill={soft} />
          <path d="M8.5 8H15.5M8.5 12H15.5M8.5 16H13" />
        </svg>
      );
    case "link":
      return (
        <svg {...common}>
          <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l2.4-2.4a3.5 3.5 0 0 0-5-5L11.6 7.4" />
          <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0L6.1 12.9a3.5 3.5 0 0 0 5 5l1.3-1.3" />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...common}>
          <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" fill={color} stroke="none" />
          <path d="M18.6 3.4l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z" fill={color} stroke="none" opacity={0.7} />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" fill={soft} />
          <path d="M8 12.3l2.6 2.6L16 9.4" strokeWidth={2} />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4.4 4.4" />
        </svg>
      );
    case "blocks":
      return (
        <svg {...common}>
          {[
            [4, 4],
            [13, 4],
            [4, 13],
            [13, 13],
          ].map(([x, y], i) => (
            <rect key={i} x={x} y={y} width="7" height="7" rx="2.2" fill={i === 3 ? color : soft} />
          ))}
        </svg>
      );
    case "lock":
      return (
        <svg {...common}>
          <rect x="5" y="10.5" width="14" height="9" rx="2" fill={soft} />
          <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
          <circle cx="12" cy="15" r="1.4" fill={color} stroke="none" />
        </svg>
      );
    case "ticket":
      return (
        <svg {...common}>
          <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z" fill={soft} />
          <path d="M13.5 6v2M13.5 11v2M13.5 16v2" strokeDasharray="1.5 2.4" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8.5" r="3.2" fill={soft} />
          <path d="M3.6 19c.7-3 2.8-4.6 5.4-4.6s4.7 1.6 5.4 4.6" />
          <circle cx="16.6" cy="9.4" r="2.5" />
          <path d="M15.3 14.6c2.4-.2 4.4 1.2 5.1 3.8" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" fill={soft} />
          <path d="M12 7.5V12l3 2" strokeWidth={2} />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3l7 2.6v5.6c0 4.4-2.9 7.6-7 9.2-4.1-1.6-7-4.8-7-9.2V5.6z" fill={soft} />
          <path d="M9 11.8l2.2 2.2 3.8-4" strokeWidth={2} />
        </svg>
      );
    case "infinity":
      return (
        <svg {...common}>
          <path d="M9.2 9.2a3.6 3.6 0 1 0 0 5.6L14.8 9.2a3.6 3.6 0 1 1 0 5.6z" strokeWidth={2.1} />
        </svg>
      );
    case "wand":
      return (
        <svg {...common}>
          <path d="M5 19L15.5 8.5" strokeWidth={2.2} />
          <path d="M17.5 3.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" fill={color} stroke="none" />
          <path d="M11 4.5l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" fill={color} stroke="none" opacity={0.75} />
        </svg>
      );
    case "plug":
      return (
        <svg {...common}>
          <path d="M8.5 7.5V4M15.5 7.5V4" strokeWidth={2} />
          <path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z" fill={soft} />
          <path d="M12 16v4.5" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="4" y="5.5" width="16" height="14.5" rx="2.4" fill={soft} />
          <path d="M4 10h16M8.5 3.5v3.4M15.5 3.5v3.4" />
          <circle cx="12" cy="14.8" r="1.6" fill={color} stroke="none" />
        </svg>
      );
    case "pencil":
      return (
        <svg {...common}>
          <path d="M5 19l1-4L16.5 4.5a1.9 1.9 0 0 1 2.7 0l.3.3a1.9 1.9 0 0 1 0 2.7L9 18z" fill={soft} />
          <path d="M14.5 6.5l3 3" />
        </svg>
      );
    case "upload":
      return (
        <svg {...common}>
          <path d="M12 15V4.5M8 8l4-3.7L16 8" strokeWidth={2} />
          <path d="M4.5 15.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" />
        </svg>
      );
    case "download":
      return (
        <svg {...common}>
          <path d="M12 4.5V15M8 11.5l4 3.7 4-3.7" strokeWidth={2} />
          <path d="M4.5 15.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" />
        </svg>
      );
    case "save":
      return (
        <svg {...common}>
          <path d="M5 5a1.5 1.5 0 0 1 1.5-1.5H16L20.5 8v10.5A1.5 1.5 0 0 1 19 20H6.5A1.5 1.5 0 0 1 5 18.5z" fill={soft} />
          <path d="M8.5 20v-6h7v6M9 3.5V8h5.5" />
        </svg>
      );
    case "bellOff":
      return (
        <svg {...common}>
          <path d="M6.3 8.8A5.7 5.7 0 0 1 17.7 9c0 4.2 1.8 5.4 1.8 5.4H4.5s1.4-.9 1.7-3.8" fill={soft} />
          <path d="M10 18a2.2 2.2 0 0 0 4 0M4 4l16 16" strokeWidth={2} />
        </svg>
      );
    case "id":
      return (
        <svg {...common}>
          <rect x="3.5" y="5.5" width="17" height="13" rx="2.4" fill={soft} />
          <circle cx="9" cy="11" r="2.1" />
          <path d="M6.3 16c.5-1.5 1.5-2.3 2.7-2.3s2.2.8 2.7 2.3M14.5 9.5h3.8M14.5 13h3.8" />
        </svg>
      );
    case "globe":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" fill={soft} />
          <path d="M3.5 12h17M12 3.5c2.6 2.3 3.9 5.1 3.9 8.5S14.6 18.2 12 20.5C9.4 18.2 8.1 15.4 8.1 12S9.4 5.8 12 3.5z" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" strokeWidth={2} />
          <path d="M19.7 3.6v3.6h-3.6" strokeWidth={2} />
        </svg>
      );
    case "hash":
      return (
        <svg {...common}>
          <path d="M9.5 4L7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16" strokeWidth={2} />
        </svg>
      );
    case "megaphone":
      return (
        <svg {...common}>
          <path d="M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H8l7.5 4V5.5L8 9.5H5.5A1.5 1.5 0 0 0 4 11z" fill={soft} />
          <path d="M18.5 9.5a3.5 3.5 0 0 1 0 5M8.5 15.5l1 4.5" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" strokeWidth={2.2} />
        </svg>
      );
    case "external":
      return (
        <svg {...common}>
          <path d="M14 4.5h5.5V10M19.2 4.8L11 13" strokeWidth={2} />
          <path d="M19.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V6a1.5 1.5 0 0 1 1.5-1.5H10" />
        </svg>
      );
    case "form":
      return (
        <svg {...common}>
          <rect x="4.5" y="3.5" width="15" height="17" rx="2.2" fill={soft} />
          <rect x="7.5" y="7" width="9" height="2.6" rx="1.1" />
          <rect x="7.5" y="12" width="9" height="2.6" rx="1.1" />
          <path d="M7.5 17.8h5" />
        </svg>
      );
    case "reply":
      return (
        <svg {...common}>
          <path d="M9.5 5L4 10.2l5.5 5.2v-3.4c4.6 0 7.8 1.4 10.5 4.5-.9-5.6-4.6-9-10.5-9z" fill={soft} />
        </svg>
      );
    case "gauge":
      return (
        <svg {...common}>
          <path d="M4.5 15.5a8 8 0 1 1 15 0" fill={soft} />
          <path d="M12 15.5l3.6-4.8" strokeWidth={2} />
          <circle cx="12" cy="15.5" r="1.5" fill={color} stroke="none" />
        </svg>
      );
    case "history":
      return (
        <svg {...common}>
          <path d="M5 12a7.5 7.5 0 1 1 2.2 5.3" strokeWidth={2} />
          <path d="M4.8 20v-3.6h3.6" strokeWidth={2} />
          <path d="M12 8.5V12l2.4 1.6" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M4 11.5L20 4l-4.5 16-4-6.5z" fill={soft} />
          <path d="M11.5 13.5L20 4" />
        </svg>
      );
    case "smile":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" fill={soft} />
          <path d="M8.5 14c.9 1.4 2.1 2.1 3.5 2.1s2.6-.7 3.5-2.1" />
          <circle cx="9.2" cy="9.8" r="1.2" fill={color} stroke="none" />
          <circle cx="14.8" cy="9.8" r="1.2" fill={color} stroke="none" />
        </svg>
      );
    case "at":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M16 8v5a2.3 2.3 0 0 0 4.5-.6A8.5 8.5 0 1 0 17 18.4" />
        </svg>
      );
    case "braces":
      return (
        <svg {...common}>
          <path d="M8.5 4.5c-2 0-2.6 1-2.6 2.6v2.2c0 1.3-.6 2.1-1.9 2.7 1.3.6 1.9 1.4 1.9 2.7v2.2c0 1.6.6 2.6 2.6 2.6" />
          <path d="M15.5 4.5c2 0 2.6 1 2.6 2.6v2.2c0 1.3.6 2.1 1.9 2.7-1.3.6-1.9 1.4-1.9 2.7v2.2c0 1.6-.6 2.6-2.6 2.6" />
        </svg>
      );
    case "eye":
      return (
        <svg {...common}>
          <path d="M3.5 12S6.5 6 12 6s8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6z" fill={soft} />
          <circle cx="12" cy="12" r="2.6" />
        </svg>
      );
  }
};
