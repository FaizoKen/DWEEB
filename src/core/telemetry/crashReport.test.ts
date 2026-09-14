import { describe, expect, it } from "vitest";

import foreignSpec from "../../../server/src/foreign-code-vectors.json";
import {
  backgroundFailureKind,
  buildCrashPayload,
  canBeForeign,
  chunkFailureKind,
  chunkProbeUrl,
  CRASH_KINDS,
  crashSignature,
  CrashThrottle,
  describeError,
  domDesyncMessage,
  EXTENSION_SCHEMES,
  frameOrigin,
  GECKO_MAIN_WORLD,
  isForeignCodeError,
  isNonCrashMessage,
  isStaleChunkMessage,
  KIND_MAX_LENGTH,
  buildMetaFromHtml,
  moduleEntryFromHtml,
  resolveCrashKind,
  shellProbeVerdict,
  topFrames,
  wireStack,
  type CrashInput,
  type FrameOrigin,
} from "./crashReport";

/** One case of `server/src/foreign-code-vectors.json` — the hand-written spec
 *  this suite and `telemetry.rs` both obey. */
interface ForeignCase {
  name: string;
  message: string;
  stack: string;
  frames: FrameOrigin;
  error: boolean;
  unhandledrejection: boolean;
}

/** A stack as the proxy reads it: `clamp_field` turns every control character
 *  (Unicode Cc: U+0000–U+001F and U+007F–U+009F) into a space. A loop rather
 *  than a control-character regex, which ESLint's no-control-regex refuses. */
function asProxyReadsIt(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out;
}

/** Whether `text` holds no lone surrogate — the half of a pair that
 *  `JSON.stringify` escapes and serde_json refuses. */
function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** An http(s) location, read as a whole scheme run the way `frameOrigin`
 *  reads one. */
const WEB_LOCATION = /(?:^|[^A-Za-z0-9+.-])https?:\/\//;

/** The 2026-09-14 page's one frame, and one of ours. */
const METAMASK_FRAME =
  "at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:7:84292)";
const OUR_FRAME = "at Ks (https://dweeb.faizo.net/assets/index-DcBtb6aN.js:41:9528)";

/** An Error whose stack is exactly `lines`, V8-style (4-space frame indent). */
function errorWithStack(message: string, lines: string[]): Error {
  const error = new Error(message);
  error.stack = lines.map((line, i) => (i === 0 ? line : `    ${line}`)).join("\n");
  return error;
}

describe("describeError", () => {
  it("pulls message and stack from an Error", () => {
    const err = new Error("boom");
    const out = describeError(err);
    expect(out.message).toBe("boom");
    expect(out.stack).toContain("boom"); // v8 stacks lead with the message
  });

  it("falls back to the error name when the message is empty", () => {
    const err = new TypeError("");
    expect(describeError(err).message).toBe("TypeError");
  });

  it("handles a bare string throw", () => {
    expect(describeError("just a string")).toEqual({ message: "just a string", stack: "" });
  });

  it("reads a message off an ErrorEvent-like object", () => {
    const evt = { message: "script error", stack: "at foo" };
    expect(describeError(evt)).toEqual({ message: "script error", stack: "at foo" });
  });

  it("never throws on exotic values", () => {
    expect(describeError(null).message).toBe("null");
    expect(describeError(undefined).message).toBe("undefined");
    expect(describeError(42).message).toBe("42");
    // A hostile toString must not blow up the reporter.
    const hostile = {
      get message() {
        return undefined;
      },
      toString() {
        throw new Error("nope");
      },
    };
    expect(() => describeError(hostile)).not.toThrow();
    expect(describeError(hostile).message).toContain("unstringifiable");
  });
});

describe("topFrames", () => {
  it("keeps only the top N non-empty, trimmed lines", () => {
    const stack = ["Error: x", "  at a (f.js:1)", "", "  at b (g.js:2)", "  at c (h.js:3)"].join(
      "\n",
    );
    expect(topFrames(stack, 2)).toBe("Error: x\nat a (f.js:1)");
  });

  it("returns empty for an empty stack", () => {
    expect(topFrames("")).toBe("");
  });
});

describe("crashSignature", () => {
  it("is stable for the same error thrown repeatedly (loop dedup)", () => {
    const a = crashSignature("error", "boom", "at render (App.js:10:5)\nat x");
    const b = crashSignature("error", "boom", "at render (App.js:10:5)\nat y");
    expect(a).toBe(b); // differing lower frames don't change the signature
  });

  it("distinguishes different errors", () => {
    const a = crashSignature("error", "boom", "at a");
    const b = crashSignature("error", "bang", "at a");
    const c = crashSignature("boundary", "boom", "at a");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("buildCrashPayload", () => {
  const base: CrashInput = {
    kind: "error",
    error: new Error("boom"),
    path: "/",
    surface: "web",
    version: "0.10.0",
    build: "a1b2c3d4e5",
  };

  it("assembles a content-free payload", () => {
    const p = buildCrashPayload(base);
    expect(p).toMatchObject({
      kind: "error",
      message: "boom",
      surface: "web",
      version: "0.10.0",
      path: "/",
    });
    expect(typeof p.stack).toBe("string");
  });

  it("carries the build id alongside the release version", () => {
    // The semver has read 1.0.0 across every deploy, so it alone can't say
    // whether a beacon comes from a bundle that already has the fix. Clients
    // ship from an SW cache and keep reporting from old builds for weeks.
    const p = buildCrashPayload(base);
    expect(p.build).toBe("a1b2c3d4e5");
    expect(p.build).not.toBe(p.version);
  });

  it("clamps an oversized message to 300 chars", () => {
    const p = buildCrashPayload({ ...base, error: new Error("x".repeat(1000)) });
    expect(p.message.length).toBe(300);
  });

  it("caps the stack to the top frames and 800 chars", () => {
    const deep = Array.from({ length: 50 }, (_, i) => `  at frame${i} (file.js:${i}:1)`).join("\n");
    const err = new Error("deep");
    err.stack = deep;
    const p = buildCrashPayload({ ...base, error: err });
    expect(p.stack.split("\n").length).toBeLessThanOrEqual(6);
    expect(p.stack.length).toBeLessThanOrEqual(800);
  });

  it("never splits a surrogate pair when it clamps", () => {
    // A cut between the halves of an emoji leaves a lone surrogate, which
    // serializes as an escape serde_json refuses — the proxy would reject the
    // whole beacon (pinned in telemetry.rs). Both caps back off one unit.
    // Unit 300 of the message, and unit 800 of the stack, is a high surrogate.
    const err = new Error(`${"x".repeat(299)}🦊 and more`);
    err.stack = `${"y".repeat(799)}🦊\n    at f (f.js:1:1)`;
    const p = buildCrashPayload({ ...base, error: err });
    expect(p.message).toBe("x".repeat(299));
    expect(p.stack).toBe("y".repeat(799));
    expect(JSON.stringify(p)).not.toMatch(/\\ud[89ab]/i);
  });

  it("carries only the path it is handed (never a hash)", () => {
    // The builder is pure: it trusts the caller to pass pathname only. This
    // documents that contract — a hash would only appear if the glue leaked one.
    const p = buildCrashPayload({ ...base, path: "/templates" });
    expect(p.path).toBe("/templates");
    expect(p.path).not.toContain("#");
  });
});

describe("isNonCrashMessage", () => {
  it("drops the ResizeObserver loop notice in both spellings", () => {
    // Not a crash: the browser reports an undelivered resize notification, which
    // settles on the next frame. Reporting it pages us for a non-event.
    expect(isNonCrashMessage("ResizeObserver loop completed with undelivered notifications")).toBe(
      true,
    );
    expect(isNonCrashMessage("ResizeObserver loop limit exceeded")).toBe(true);
  });

  it("still drops it when the browser wraps the message", () => {
    expect(isNonCrashMessage("Uncaught ResizeObserver loop limit exceeded")).toBe(true);
  });

  it("keeps real errors, including ones that merely mention ResizeObserver", () => {
    expect(isNonCrashMessage("Cannot read properties of undefined (reading 'id')")).toBe(false);
    expect(isNonCrashMessage("ResizeObserver is not defined")).toBe(false);
    expect(isNonCrashMessage("")).toBe(false);
  });
});

describe("isStaleChunkMessage", () => {
  it("matches every engine's failed dynamic-import wording, with the URL attached", () => {
    // Chromium — the exact shape the prod crash alerts carried.
    expect(
      isStaleChunkMessage(
        "Failed to fetch dynamically imported module: https://dweeb.faizo.net/assets/flows-CUcFDGpr.js",
      ),
    ).toBe(true);
    // Firefox.
    expect(
      isStaleChunkMessage("error loading dynamically imported module: https://x/assets/a.js"),
    ).toBe(true);
    // Safari.
    expect(isStaleChunkMessage("Importing a module script failed.")).toBe(true);
    // Vite's preload helper, for a chunk's CSS dependency.
    expect(isStaleChunkMessage("Unable to preload CSS for /assets/App-abc123.css")).toBe(true);
  });

  it("still matches when the browser wraps the message", () => {
    expect(
      isStaleChunkMessage(
        "Uncaught (in promise) TypeError: Failed to fetch dynamically imported module: https://x/a.js",
      ),
    ).toBe(true);
  });

  it("keeps unrelated errors, including other fetch failures", () => {
    expect(isStaleChunkMessage("Failed to fetch")).toBe(false); // a plain network error
    expect(isStaleChunkMessage("Cannot read properties of undefined (reading 'id')")).toBe(false);
    expect(isStaleChunkMessage("")).toBe(false);
  });
});

describe("resolveCrashKind", () => {
  const STALE = "Failed to fetch dynamically imported module: https://x/assets/Gallery-abc.js";

  it("passes non-stale reports through untouched", () => {
    expect(resolveCrashKind("error", "boom", false)).toBe("error");
    expect(resolveCrashKind("boundary", "boom", false)).toBe("boundary");
    // Reload state is irrelevant when the message isn't a chunk failure.
    expect(resolveCrashKind("error", "boom", true)).toBe("error");
  });

  it("drops a stale chunk the boot recovery is already reloading past", () => {
    expect(resolveCrashKind("unhandledrejection", STALE, true)).toBe(null);
    expect(resolveCrashKind("boundary", STALE, true)).toBe(null);
    expect(resolveCrashKind("stale-chunk", STALE, true)).toBe(null);
  });

  it("keeps a handled post-boot failure as stale-chunk (logged below paging level)", () => {
    expect(resolveCrashKind("stale-chunk", STALE, false)).toBe("stale-chunk");
  });

  it("escalates an unhandled stale chunk to stale-chunk-fatal (the page-worthy shape)", () => {
    // The top boundary catching it means the app actually went down — recovery
    // exhausted, or a lazy path no ChunkErrorBoundary covers. Provisional:
    // `chunkFailureKind` decides whether our deploy is why.
    expect(resolveCrashKind("boundary", STALE, false)).toBe("stale-chunk-fatal");
    expect(resolveCrashKind("error", STALE, false)).toBe("stale-chunk-fatal");
    expect(resolveCrashKind("unhandledrejection", STALE, false)).toBe("stale-chunk-fatal");
    // The entry's own trap takes the same road: provisional, then probed.
    expect(resolveCrashKind("boot", STALE, false)).toBe("stale-chunk-fatal");
  });

  it("passes a boot failure that is not a chunk load through as itself", () => {
    // A bug in the boot path pages as a plain crash — the entry never reaches
    // the ErrorBoundary, so `boot` is its only trap.
    expect(resolveCrashKind("boot", "Cannot destructure property 'App' of undefined", false)).toBe(
      "boot",
    );
  });
});

describe("chunkFailureKind", () => {
  it("pages only when the chunk is gone AND the live shell is this very build", () => {
    // Both probes agree: the shell people receive right now names a chunk our
    // host doesn't serve. That is a broken deploy.
    expect(chunkFailureKind("missing", "same")).toBe("stale-chunk-fatal");
  });

  it("counts a gone chunk under a shell that has moved on as a stale client, never a page", () => {
    // The 2026-09-11 page verbatim: build e699a38eec booted 42 hours after it
    // was replaced, its `flows-*.js` long purged, the recovery reload unable to
    // get past the cached shell. The live deploy was fine the whole time.
    expect(chunkFailureKind("missing", "different")).toBe("stale-shell");
  });

  it("sends an unreadable live shell as its own non-paging kind", () => {
    // A timed-out or blocked shell read is the visitor's link; the one cause
    // that would be ours (the parser no longer matching the shell) is caught by
    // the post-build audit gate. Distinct from `stale-shell` so a regression in
    // the probe is a count in the log, not silence.
    expect(chunkFailureKind("missing", "unknown")).toBe("shell-unverified");
  });

  it("blames the connection, not the deploy, when the chunk is still served", () => {
    // The 2026-07-28 page verbatim: `acquisition-*.js` and `useBarWidth-*.css`
    // were both being served, from the build the live index.html pointed at.
    // Whatever the shell said is irrelevant — the chunk was there.
    expect(chunkFailureKind("served", "same")).toBe("chunk-unreachable");
    expect(chunkFailureKind("served", "unknown")).toBe("chunk-unreachable");
  });

  it("treats an unreachable probe as the visitor's network", () => {
    expect(chunkFailureKind("unreachable", "unknown")).toBe("chunk-unreachable");
    expect(chunkFailureKind("unreachable", "same")).toBe("chunk-unreachable");
  });

  it("errs away from paging when there is nothing to check", () => {
    // Safari's "Importing a module script failed." carries no URL; a real
    // broken deploy still pages through every engine that does name one.
    expect(chunkFailureKind("unknown", "unknown")).toBe("chunk-unreachable");
  });
});

describe("moduleEntryFromHtml", () => {
  // The shell exactly as Vite emits it: `crossorigin` sits between `type` and
  // `src`, classic and JSON-LD scripts precede it, an inline module has no src.
  const SHELL = `<!doctype html>
<html lang="en"><head>
<script>(function(){try{if(new URLSearchParams(location.search).has("frame_id")){document.documentElement.dataset.surface="activity"}}catch(e){}})();</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebApplication"}</script>
<script type="module">console.log("inline")</script>
<script defer src="/gtag-init.js"></script>
<script type="module" crossorigin src="/assets/index-DcBtb6aN.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-DLC0YOu0.css">
</head><body><div id="root"><main class="seo-boot" data-seo-boot aria-busy="true"></main></div></body></html>`;

  it("finds the module entry the shell actually carries", () => {
    expect(moduleEntryFromHtml(SHELL)).toBe("/assets/index-DcBtb6aN.js");
  });

  it("does not care about attribute order or quoting", () => {
    expect(moduleEntryFromHtml(`<script src="/a.js" type="module"></script>`)).toBe("/a.js");
    expect(moduleEntryFromHtml(`<script src='/b.js' type='module'></script>`)).toBe("/b.js");
    expect(moduleEntryFromHtml(`<script type=module src=/c.js></script>`)).toBe("/c.js");
    expect(moduleEntryFromHtml(`<SCRIPT TYPE="module" SRC="/d.js"></SCRIPT>`)).toBe("/d.js");
    expect(
      moduleEntryFromHtml(`<script\n  type="module"\n  crossorigin\n  src="/e.js"\n></script>`),
    ).toBe("/e.js");
  });

  it("skips scripts that are not module entries", () => {
    expect(moduleEntryFromHtml(`<script src="/classic.js"></script>`)).toBe(null);
    expect(moduleEntryFromHtml(`<script type="module">inline()</script>`)).toBe(null);
    expect(moduleEntryFromHtml(`<script type="modules" src="/x.js"></script>`)).toBe(null);
    expect(moduleEntryFromHtml(`<script type="text/javascript" src="/x.js"></script>`)).toBe(null);
    expect(moduleEntryFromHtml("")).toBe(null);
    expect(moduleEntryFromHtml("<html><body>Not a shell at all</body></html>")).toBe(null);
  });

  it("returns the first module entry when there are several", () => {
    expect(
      moduleEntryFromHtml(
        `<script type="module" src="/first.js"></script><script type="module" src="/second.js"></script>`,
      ),
    ).toBe("/first.js");
  });
});

describe("buildMetaFromHtml", () => {
  // The head exactly as `index.html` carries it after `stampBuildMeta` has run,
  // with the neighbours that must not be mistaken for it.
  const SHELL = `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="color-scheme" content="dark" />
<meta name="dweeb-build" content="619d058a00" />
<meta property="og:updated_time" content="2026-08-20T00:00:00Z" />
</head><body></body></html>`;

  it("reads the build the shell declares", () => {
    expect(buildMetaFromHtml(SHELL)).toBe("619d058a00");
  });

  it("does not care about attribute order or quoting", () => {
    expect(buildMetaFromHtml(`<meta content="a1" name="dweeb-build">`)).toBe("a1");
    expect(buildMetaFromHtml(`<meta name='dweeb-build' content='b2'>`)).toBe("b2");
    expect(buildMetaFromHtml(`<meta name=dweeb-build content=c3>`)).toBe("c3");
    expect(buildMetaFromHtml(`<META NAME="dweeb-build" CONTENT="d4" />`)).toBe("d4");
    expect(buildMetaFromHtml(`<meta\n  name="dweeb-build"\n  content="e5"\n/>`)).toBe("e5");
  });

  it("carries a local build's -dirty marker through verbatim", () => {
    // A hand-deployed shell must compare equal to the beacons from the bundle
    // it shipped, `-dirty` and all — they come from the same `BUILD_ID`.
    expect(buildMetaFromHtml(`<meta name="dweeb-build" content="619d058a00-dirty">`)).toBe(
      "619d058a00-dirty",
    );
  });

  it("matches the name exactly, and tolerates a shell that has none", () => {
    expect(buildMetaFromHtml(`<meta name="dweeb-build-id" content="x">`)).toBe(null);
    expect(buildMetaFromHtml(`<meta name="dweeb" content="x">`)).toBe(null);
    expect(buildMetaFromHtml(`<meta property="dweeb-build" content="x">`)).toBe(null);
    expect(buildMetaFromHtml(`<meta name="dweeb-build">`)).toBe(null);
    expect(buildMetaFromHtml(`<meta name="dweeb-build" content="">`)).toBe(null);
    expect(buildMetaFromHtml("")).toBe(null);
    expect(buildMetaFromHtml("<html><body>Not a shell at all</body></html>")).toBe(null);
  });

  it("reads an attribute name whole — `data-name=` is not `name=`", () => {
    // A JS word boundary matches after a hyphen, so the obvious `\bname=` reads
    // `data-name=` as the marker. The Rust twin (`server/src/live_build.rs`)
    // requires the same preceding character, and only this side is gated by the
    // post-build audit, so a divergence here would go unnoticed.
    expect(buildMetaFromHtml(`<meta data-name="dweeb-build" content="stolen">`)).toBe(null);
    expect(buildMetaFromHtml(`<meta name="dweeb-build" data-content="stolen">`)).toBe(null);
  });

  it("refuses anything not shaped like a build id", () => {
    // The marker is the one input a hijacked origin controls, and the proxy
    // compares *and logs* it — a newline would forge a whole log line there.
    // Refusing reads as absent, which is the fail-open-to-paging path.
    for (const hostile of [
      "a\n2026-09-13T10:00:00.000000Z ERROR forged: on fire",
      "a\r\nERROR forged",
      "has spaces",
      "0123456789012345678901234567890123456789",
      "a;b",
    ]) {
      expect(buildMetaFromHtml(`<meta name="dweeb-build" content="${hostile}">`)).toBe(null);
    }
    // …while everything vite.config.ts's buildId() can produce still reads.
    for (const real of ["619d058a00", "619d058a00-dirty", "tm1k2j3h", "a_b.c-d"]) {
      expect(buildMetaFromHtml(`<meta name="dweeb-build" content="${real}">`)).toBe(real);
    }
  });
});

describe("shellProbeVerdict", () => {
  const ORIGIN = "https://dweeb.faizo.net";
  const OWN = "https://dweeb.faizo.net/assets/index-CVox9PLO.js";

  it("recognises its own build in the live shell", () => {
    expect(shellProbeVerdict(OWN, "/assets/index-CVox9PLO.js", ORIGIN)).toBe("same");
    expect(shellProbeVerdict(OWN, "https://dweeb.faizo.net/assets/index-CVox9PLO.js", ORIGIN)).toBe(
      "same",
    );
  });

  it("recognises another build — 'different', not 'newer': the client cannot order builds", () => {
    expect(shellProbeVerdict(OWN, "/assets/index-DcBtb6aN.js", ORIGIN)).toBe("different");
  });

  it("is unknown when either side is missing or unparseable", () => {
    expect(shellProbeVerdict(null, "/assets/index-DcBtb6aN.js", ORIGIN)).toBe("unknown");
    expect(shellProbeVerdict(OWN, null, ORIGIN)).toBe("unknown");
    expect(shellProbeVerdict("", "/assets/x.js", ORIGIN)).toBe("unknown");
    expect(shellProbeVerdict(OWN, "/assets/x.js", "not a base")).toBe("unknown");
  });
});

describe("CRASH_KINDS", () => {
  it("all fit the proxy's kind clamp, and only one is the fatal string", () => {
    // `telemetry.rs` clamps `kind` to KIND_MAX by silent truncation and pages
    // on the exact string `stale-chunk-fatal`: a longer kind would land as
    // something else, and one merely starting with the fatal string would be
    // demoted to routine by the truncation alone.
    for (const kind of CRASH_KINDS) {
      expect(kind.length).toBeLessThanOrEqual(KIND_MAX_LENGTH);
      expect(kind.startsWith("stale-chunk-fatal")).toBe(kind === "stale-chunk-fatal");
    }
    expect(new Set(CRASH_KINDS).size).toBe(CRASH_KINDS.length);
  });
});

describe("chunkProbeUrl", () => {
  const ORIGIN = "https://dweeb.faizo.net";

  it("reads the absolute URL Chromium and Firefox append", () => {
    expect(
      chunkProbeUrl(
        "Failed to fetch dynamically imported module: https://dweeb.faizo.net/assets/acquisition-rapBslg9.js",
        ORIGIN,
      ),
    ).toBe("https://dweeb.faizo.net/assets/acquisition-rapBslg9.js");
    expect(
      chunkProbeUrl(
        "error loading dynamically imported module: https://dweeb.faizo.net/assets/App-abc.js",
        ORIGIN,
      ),
    ).toBe("https://dweeb.faizo.net/assets/App-abc.js");
  });

  it("resolves the root-relative path Vite's CSS preload wording carries", () => {
    expect(
      chunkProbeUrl("Unable to preload CSS for /assets/useBarWidth-CLpGG8DF.css", ORIGIN),
    ).toBe("https://dweeb.faizo.net/assets/useBarWidth-CLpGG8DF.css");
  });

  it("refuses a cross-origin URL — the probe asks our host about our asset", () => {
    expect(
      chunkProbeUrl(
        "Failed to fetch dynamically imported module: https://evil.example/assets/x.js",
        ORIGIN,
      ),
    ).toBe(null);
  });

  it("returns null when the message names no chunk", () => {
    expect(chunkProbeUrl("Importing a module script failed.", ORIGIN)).toBe(null);
    expect(chunkProbeUrl("", ORIGIN)).toBe(null);
  });
});

describe("backgroundFailureKind", () => {
  it("reports a background chunk failure as handled, not fatal", () => {
    // The 2026-07-27 page verbatim: the post-paint service-worker registration
    // import, 404'd because the tab outlived a deploy. Handing this to
    // `resolveCrashKind` as `stale-chunk` keeps it below paging level — the
    // editor was running fine and only the offline cache was missed.
    const message =
      "Failed to fetch dynamically imported module: " +
      "https://dweeb.faizo.net/assets/virtual_pwa-register-BgZHO7yx.js";
    expect(backgroundFailureKind(message)).toBe("stale-chunk");
    expect(resolveCrashKind(backgroundFailureKind(message), message, false)).toBe("stale-chunk");
  });

  it("keeps an unexpected fault page-worthy, background or not", () => {
    // Not deploy skew — a real bug in code we shipped. It reports exactly as the
    // unhandled rejection it would otherwise have been.
    expect(backgroundFailureKind("Cannot read properties of undefined (reading 'id')")).toBe(
      "unhandledrejection",
    );
    expect(backgroundFailureKind("")).toBe("unhandledrejection");
  });
});

describe("isForeignCodeError", () => {
  it("classifies an unattributed stack from the window trap as foreign", () => {
    // The 2026-07-24 page verbatim: a Safari user's eval'd/injected script
    // overflowed its own stack. JSC prints bare `fn@` frames (no source URL)
    // for code that has no script URL — nothing we served looks like that.
    expect(
      isForeignCodeError("error", "Maximum call stack size exceeded.", "@\n@\n@\nPk@\nNk@\nPk@"),
    ).toBe(true);
    // V8's wording for eval'd code is equally unattributed.
    expect(
      isForeignCodeError(
        "error",
        "Maximum call stack size exceeded",
        "at Pk (<anonymous>)\nat Nk (<anonymous>)",
      ),
    ).toBe(true);
  });

  it("classifies the muted cross-origin 'Script error.' shape as foreign", () => {
    expect(isForeignCodeError("error", "Script error.", "")).toBe(true);
    // Only with the empty stack the mute implies.
    expect(
      isForeignCodeError("error", "Script error.", "x@https://dweeb.faizo.net/assets/a.js:1:2"),
    ).toBe(false);
  });

  it("keeps any stack that carries a script URL of ours", () => {
    expect(
      isForeignCodeError(
        "error",
        "Maximum call stack size exceeded.",
        "Pk@https://dweeb.faizo.net/assets/useBarWidth-abc.js:41:9528",
      ),
    ).toBe(false);
    // …even beneath an extension's frame: a page-world wrapper sits on top of
    // our own call, and that misuse of ours must page. Every location counts,
    // never just the top frame.
    const wrapped = [
      "DataCloneError: Failed to execute 'pushState' on 'History': f() {} could not be cloned.",
      "at History.pushState (chrome-extension://abcdefghijklmnopabcdefghijklmnop/hook.js:5:66)",
      "at ourPush (https://dweeb.faizo.net/assets/index-DcBtb6aN.js:4:49)",
    ].join("\n");
    expect(isForeignCodeError("error", "boom", wrapped)).toBe(false);
    expect(isForeignCodeError("unhandledrejection", "boom", wrapped)).toBe(false);
  });

  it("classifies a stack naming only an extension's code as foreign, on both window traps", () => {
    // The 2026-09-14 page: MetaMask's page-world inpage.js dropping its own
    // promise, built through the real payload path.
    const error = errorWithStack("Failed to connect to MetaMask", [
      "i: Failed to connect to MetaMask",
      METAMASK_FRAME,
    ]);
    error.name = "i";
    const p = buildCrashPayload({
      kind: "unhandledrejection",
      error,
      path: "/",
      surface: "web",
      version: "1.1.0",
      build: "e699a38eec",
    });
    expect(p.stack).toBe(`i: Failed to connect to MetaMask\n${METAMASK_FRAME}`);
    expect(isForeignCodeError("unhandledrejection", p.message, p.stack)).toBe(true);
    expect(isForeignCodeError("error", p.message, p.stack)).toBe(true);
    // One frame of ours anywhere in it, and it is ours to hear about.
    const ours = `${p.stack}\n${OUR_FRAME}`;
    expect(isForeignCodeError("unhandledrejection", p.message, ours)).toBe(false);
  });

  it("keeps an empty stack with an ordinary message (our code can throw strings)", () => {
    expect(isForeignCodeError("error", "invalid share token", "")).toBe(false);
  });

  it("never classifies a boundary report, or a rejection that names no location, as foreign", () => {
    // A boundary crash took the app down, whatever its stack. A rejection that
    // names no location may be ours: our own failed fetch rejects with a
    // header-only TypeError, so the location-less shapes stay window-error only.
    expect(isForeignCodeError("boundary", "boom", "@\n@\nPk@")).toBe(false);
    expect(isForeignCodeError("boundary", "boom", `i: boom\n${METAMASK_FRAME}`)).toBe(false);
    expect(isForeignCodeError("unhandledrejection", "boom", "@\n@\nPk@")).toBe(false);
    expect(
      isForeignCodeError("unhandledrejection", "Failed to fetch", "TypeError: Failed to fetch"),
    ).toBe(false);
    expect(isForeignCodeError("boundary", "Script error.", "")).toBe(false);
    expect(isForeignCodeError("unhandledrejection", "Script error.", "")).toBe(false);
  });
});

describe("foreign-code spec (shared with telemetry.rs)", () => {
  const cases = foreignSpec.cases as ForeignCase[];

  it("lists exactly the extension evidence the spec does", () => {
    expect([...EXTENSION_SCHEMES].sort()).toEqual([...foreignSpec.extensionSchemes].sort());
    expect(GECKO_MAIN_WORLD).toBe(foreignSpec.geckoMainWorld);
  });

  // Each case as written (the client's newline-joined stack) and as the proxy
  // reads it (newlines turned into spaces); telemetry.rs runs the same file.
  it.each(cases)("$name", (c) => {
    for (const stack of [c.stack, asProxyReadsIt(c.stack)]) {
      expect(frameOrigin(stack)).toBe(c.frames);
      expect(isForeignCodeError("error", c.message, stack)).toBe(c.error);
      expect(isForeignCodeError("unhandledrejection", c.message, stack)).toBe(c.unhandledrejection);
    }
  });

  it("never lets any other kind be foreign, whatever the stack", () => {
    for (const kind of CRASH_KINDS) {
      expect(canBeForeign(kind)).toBe(kind === "error" || kind === "unhandledrejection");
      if (canBeForeign(kind)) continue;
      for (const c of cases) {
        expect(isForeignCodeError(kind, c.message, c.stack), `${kind}: ${c.name}`).toBe(false);
      }
    }
  });
});

describe("wireStack", () => {
  const extensionFrame = (i: number) =>
    `at hook${i} (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:11:${i})`;

  /** What the proxy does with a wire stack: judge it, flattened. */
  const proxyDemotes = (wire: string) =>
    isForeignCodeError("error", "m", asProxyReadsIt(wire)) ||
    isForeignCodeError("unhandledrejection", "m", asProxyReadsIt(wire));

  const expectBounded = (wire: string) => {
    expect(wire.split("\n").length).toBeLessThanOrEqual(6);
    expect(wire.length).toBeLessThanOrEqual(800);
    expect(isWellFormed(wire)).toBe(true);
  };

  it("leaves a window that already names a frame of ours exactly as it was", () => {
    const stack = ["TypeError: x", extensionFrame(1), OUR_FRAME, extensionFrame(2)].join("\n");
    expect(wireStack(stack)).toBe(topFrames(stack));
  });

  it("leaves an extension-only or location-less stack as the plain window", () => {
    const extensionOnly = ["i: x", ...Array.from({ length: 9 }, (_, i) => extensionFrame(i))];
    expect(wireStack(extensionOnly.join("\n"))).toBe(topFrames(extensionOnly.join("\n")));
    const nowhere = "@\n@\n@\nPk@\nNk@\nPk@\nQk@\nRk@";
    expect(wireStack(nowhere)).toBe(topFrames(nowhere));
  });

  it("promotes our frame from under five extension frames", () => {
    // Before promotion the proxy saw the header and five extension frames, and
    // demoted a crash whose throwing call was ours.
    const stack = [
      "DataCloneError: x",
      ...Array.from({ length: 7 }, (_, i) => extensionFrame(i)),
      OUR_FRAME,
    ];
    const wire = wireStack(stack.join("\n"));
    expectBounded(wire);
    expect(wire.split("\n")).toEqual([
      "DataCloneError: x",
      extensionFrame(0),
      extensionFrame(1),
      extensionFrame(2),
      "... 4 lines skipped ...",
      OUR_FRAME,
    ]);
    expect(proxyDemotes(topFrames(stack.join("\n")))).toBe(true);
    expect(proxyDemotes(wire)).toBe(false);
  });

  it("promotes our frame past a message that filled the window", () => {
    // V8 spends line 1 on `Name: message`, so a multi-line message pushed every
    // frame out of the window and the unattributed rule silenced our crash.
    const zod = [
      "ZodError: [",
      ...Array.from({ length: 12 }, (_, i) => `"issue${i}": "invalid_type",`),
      "]",
      OUR_FRAME,
    ].join("\n");
    const fromZod = wireStack(zod);
    expectBounded(fromZod);
    expect(fromZod.split("\n")[0]).toBe("ZodError: [");
    expect(fromZod.split("\n").at(-1)).toBe(OUR_FRAME);
    expect(isForeignCodeError("error", "m", asProxyReadsIt(topFrames(zod)))).toBe(true);
    expect(proxyDemotes(fromZod)).toBe(false);
    // A DataCloneError quotes the offending function's source: one line longer
    // than the whole budget. It is cut; our frame is not.
    const clone = [`DataCloneError: ${"s".repeat(1000)} could not be cloned.`, OUR_FRAME].join(
      "\n",
    );
    const fromClone = wireStack(clone);
    expectBounded(fromClone);
    expect(fromClone.startsWith("DataCloneError: sss")).toBe(true);
    expect(fromClone.endsWith(`\n${OUR_FRAME}`)).toBe(true);
    expect(proxyDemotes(fromClone)).toBe(false);
  });

  it("rescues our frame when the plain clamp would cut it before its '://'", () => {
    // Four long extension lines put our frame on line 6, where 800 units end
    // just before its "://" — the plain window names no location of ours.
    const stack = [
      "E: m",
      ...Array.from({ length: 4 }, (_, i) => `${extensionFrame(i)}${"x".repeat(110)}`),
      OUR_FRAME,
    ].join("\n");
    expect(topFrames(stack).slice(0, 800).endsWith("\nat Ks (http")).toBe(true);
    expect(WEB_LOCATION.test(topFrames(stack).slice(0, 800))).toBe(false);
    const wire = wireStack(stack);
    expectBounded(wire);
    expect(wire.endsWith(OUR_FRAME)).toBe(true);
    expect(proxyDemotes(wire)).toBe(false);
  });

  it("keeps an oversized frame of ours from its URL on", () => {
    const giant = `at Xk (eval at f (${"q".repeat(400)} https://dweeb.faizo.net/assets/index-a.js:1:2), <anonymous>:1:1)`;
    const stack = ["E: m", ...Array.from({ length: 6 }, (_, i) => extensionFrame(i)), giant].join(
      "\n",
    );
    const wire = wireStack(stack);
    expectBounded(wire);
    expect(
      wire.split("\n").at(-1)?.startsWith("https://dweeb.faizo.net/assets/index-a.js:1:2)"),
    ).toBe(true);
    expect(proxyDemotes(wire)).toBe(false);
  });

  it("prefers an http(s) frame to an earlier location of another scheme", () => {
    // A future scheme added to the extension list can never demote http(s).
    const stack = [
      "E: m",
      ...Array.from({ length: 5 }, (_, i) => extensionFrame(i)),
      "at w (webpack-internal:///./src/a.js:1:1)",
      OUR_FRAME,
    ].join("\n");
    expect(wireStack(stack).split("\n").at(-1)).toBe(OUR_FRAME);
    // …and within one oversized line it keeps the http(s) location too, not
    // the first non-extension one, which would leave the clamp to cut it off.
    const giant = `at Xk (eval at w (webpack-internal:///./src/a.js:1:1) ${"q".repeat(300)} https://dweeb.faizo.net/assets/index-a.js:1:2)`;
    const inLine = wireStack(
      ["E: m", ...Array.from({ length: 5 }, (_, i) => extensionFrame(i)), giant].join("\n"),
    );
    expect(inLine.split("\n").at(-1)?.startsWith("https://dweeb.faizo.net/")).toBe(true);
  });

  it("keeps the header leading, and promotes a frame, when the header's own URL lies past the window", () => {
    // A long message holding a URL past unit 800 — a DataCloneError quoting
    // source that mentions one — used to send that URL's tail alone: no header,
    // no frame of ours, and crashSignature keyed on the fragment.
    const header = `Error: Discord rejected the payload: ${"d".repeat(820)} (see https://discord.com/developers/docs)`;
    const withFrames = wireStack([header, OUR_FRAME, extensionFrame(1)].join("\n"));
    expectBounded(withFrames);
    expect(withFrames.startsWith("Error: Discord rejected the payload: ddd")).toBe(true);
    expect(withFrames.split("\n").at(-1)).toBe(OUR_FRAME);
    // With no frame to promote, the header still leads and its URL follows it.
    const alone = wireStack(header);
    expectBounded(alone);
    expect(alone.startsWith("Error: Discord rejected the payload: ddd")).toBe(true);
    expect(alone.split("\n").at(-1)).toBe("https://discord.com/developers/docs)");
  });

  it("never lets the clamp take a promoted location's '://' with it", () => {
    // With no http(s) anywhere, any location that isn't an extension's is
    // promoted — even a malformed run too long to keep whole. Dropping the run
    // keeps its '://', an empty run, which reads as ours on both sides; trimming
    // the run's front instead could have left an extension scheme.
    const longRun = `at y (${"a".repeat(300)}chrome-extension://abc/y.js:1:2)`;
    const stack = [
      "Error: x",
      ...Array.from({ length: 6 }, (_, i) => extensionFrame(i)),
      longRun,
    ].join("\n");
    expect(isForeignCodeError("unhandledrejection", "x", topFrames(stack, Infinity))).toBe(false);
    const wire = wireStack(stack);
    expectBounded(wire);
    expect(wire.split("\n").at(-1)).toBe("://abc/y.js:1:2)");
    expect(proxyDemotes(wire)).toBe(false);
  });

  it("never splits a surrogate pair at either cut promotion adds", () => {
    // A lone surrogate costs the whole beacon (serde refuses it). Beyond the
    // plain window's cut, promotion cuts the promoted line and line 1.
    const url = "https://dweeb.faizo.net/assets/index-a.js:1:2) ";
    const oversized = `at Xk (${url}${"q".repeat(239 - url.length)}${"🦊".repeat(10)}`;
    const promotedCut = wireStack(
      ["E: m", ...Array.from({ length: 5 }, (_, i) => extensionFrame(i)), oversized].join("\n"),
    );
    expectBounded(promotedCut);
    expect(promotedCut.split("\n").at(-1)?.startsWith("https://dweeb.faizo.net/")).toBe(true);
    // Line 1 exactly one unit longer than the head's budget, ending in an emoji.
    const header = `Err: ${"m".repeat(800 - OUR_FRAME.length - 34 - 6)}🦊`;
    const headCut = wireStack(
      [header, ...Array.from({ length: 5 }, (_, i) => extensionFrame(i)), OUR_FRAME].join("\n"),
    );
    expectBounded(headCut);
    expect(headCut.startsWith("Err: mmm")).toBe(true);
    expect(headCut.split("\n").at(-1)).toBe(OUR_FRAME);
  });

  it("never lets the proxy demote what the full stack showed to be ours", () => {
    // Random stacks from every piece the three engine families print, under
    // headers of up to 900 units that may carry a URL past the window, seeded
    // so a failure reproduces.
    const pieces = [
      OUR_FRAME,
      "at e (https://1511769679096447016.discordsays.com/.proxy/assets/A-X.js:1:2)",
      METAMASK_FRAME,
      "w@<anonymous code>:1:1",
      "y@webkit-masked-url://hidden/:2:2930760",
      "at w (webpack://x/./a.js:1:1)",
      "at z (wasm://wasm/0012abcd:wasm-function[1]:0x5)",
      "at d (data:text/javascript,foo:1:1)",
      "at b (://y:1:2)",
      `at y (${"a".repeat(300)}chrome-extension://abc/y.js:1:2)`,
      "at Array.map (<anonymous>)",
      "at async Promise.all (index 0)",
      // Adjacent, these two spell the Gecko token across a newline.
      "tail <anonymous",
      "code> head",
      '  "issue": "invalid_type",',
      "x".repeat(300),
      "🦊".repeat(120),
    ];
    const headerTails = [
      "",
      "🦊",
      " (see https://discord.com/developers/docs)",
      " at chrome-extension://abc/h.js:1:1",
    ];
    let seed = 7;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const pick = <T>(from: readonly T[]): T => from[next(from.length)] as T;
    const failures: string[] = [];
    for (let run = 0; run < 20_000 && failures.length === 0; run++) {
      const header = `Err: ${"m".repeat(next(900))}${pick(headerTails)}`;
      const lines = [header];
      for (let k = next(14); k > 0; k--) lines.push(pick(pieces));
      const full = lines.join("\n");
      const wire = wireStack(full);
      const judged = topFrames(full, Infinity);
      for (const kind of ["error", "unhandledrejection"] as const) {
        if (
          !isForeignCodeError(kind, "m", judged) &&
          isForeignCodeError(kind, "m", asProxyReadsIt(wire))
        ) {
          failures.push(`${kind} demoted: ${JSON.stringify(full)}`);
        }
      }
      if (WEB_LOCATION.test(full) && !WEB_LOCATION.test(wire)) {
        failures.push(`http(s) lost: ${JSON.stringify(full)}`);
      }
      if (wire.length > 800 || wire.split("\n").length > 6 || !isWellFormed(wire)) {
        failures.push(`out of bounds: ${JSON.stringify(full)}`);
      }
      const first = wire.split("\n")[0] ?? "";
      if (first.length === 0 || !header.trim().startsWith(first)) {
        failures.push(`line 1 lost: ${JSON.stringify(full)}`);
      }
    }
    expect(failures).toEqual([]);
    // ~1-3 s locally; a cold, busy runner has come within reach of Vitest's
    // 5 s default, and a flaky guard is one nobody trusts.
  }, 30_000);
});

describe("domDesyncMessage", () => {
  it("names the wrapper and the translator, which is the whole diagnosis", () => {
    // `FONT` + a translator marker: a browser rewrote the page, the guard
    // repaired it, nothing to do.
    expect(domDesyncMessage({ api: "insertBefore", actualParent: "FONT" }, "google")).toBe(
      "dom desync repaired: insertBefore reference under FONT (translator=google)",
    );
  });

  it("reads as a bug of ours when no translator is involved", () => {
    // The shape worth investigating: nothing rewrote the page, so the guard is
    // masking something we did.
    expect(domDesyncMessage({ api: "removeChild", actualParent: "DIV" }, "none")).toBe(
      "dom desync repaired: removeChild reference under DIV (translator=none)",
    );
  });

  it("stays well inside the beacon's message cap", () => {
    const message = domDesyncMessage({ api: "insertBefore", actualParent: "FONT" }, "microsoft");
    expect(message.length).toBeLessThan(300);
  });
});

describe("CrashThrottle", () => {
  it("sends a signature once, then suppresses repeats", () => {
    const t = new CrashThrottle(5);
    expect(t.shouldSend("sig-a")).toBe(true);
    expect(t.shouldSend("sig-a")).toBe(false);
    expect(t.shouldSend("sig-a")).toBe(false);
  });

  it("enforces a hard cap across distinct signatures", () => {
    const t = new CrashThrottle(2);
    expect(t.shouldSend("a")).toBe(true);
    expect(t.shouldSend("b")).toBe(true);
    expect(t.shouldSend("c")).toBe(false); // over the cap even though it's new
  });

  it("counts a suppressed duplicate against neither the cap nor twice", () => {
    const t = new CrashThrottle(2);
    expect(t.shouldSend("a")).toBe(true);
    expect(t.shouldSend("a")).toBe(false); // dup, not counted
    expect(t.shouldSend("b")).toBe(true); // still room for the second distinct one
  });
});
