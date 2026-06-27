import React from "react";
import { JETBRAINS } from "../fonts";
import { COLORS } from "../theme";

const C = {
  key: "#7dd3fc",
  string: "#a6e3a1",
  number: "#f9b572",
  punct: "#8b93a7",
  bool: "#cba6f7",
};

// Tiny tokenizer good enough for a JSON payload — keys, strings, numbers, punct.
function tokenize(src: string): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = [];
  const re = /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?)|([{}\[\],:])|(\s+)|([^\s{}\[\],:"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) out.push({ text: m[1], color: C.key });
    else if (m[2]) out.push({ text: m[2], color: C.string });
    else if (m[3]) out.push({ text: m[3], color: C.bool });
    else if (m[4]) out.push({ text: m[4], color: C.number });
    else if (m[5]) out.push({ text: m[5], color: C.punct });
    else if (m[6]) out.push({ text: m[6], color: "inherit" });
    else out.push({ text: m[7], color: "#e6e6e6" });
  }
  return out;
}

export const JsonCode: React.FC<{
  src: string;
  chars?: number; // typed reveal length
  fontSize?: number;
  error?: boolean;
}> = ({ src, chars = src.length, fontSize = 22, error = false }) => {
  const visible = src.slice(0, Math.max(0, Math.floor(chars)));
  const tokens = tokenize(visible);
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: JETBRAINS,
        fontSize,
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: error ? COLORS.danger : "#e6e6e6",
        transition: "color 0.2s",
      }}
    >
      {tokens.map((t, i) => (
        <span key={i} style={{ color: error ? COLORS.danger : t.color }}>
          {t.text}
        </span>
      ))}
      <span style={{ opacity: chars < src.length ? 1 : 0, color: COLORS.green }}>▋</span>
    </pre>
  );
};
