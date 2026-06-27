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
  | "lock";

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
  }
};
