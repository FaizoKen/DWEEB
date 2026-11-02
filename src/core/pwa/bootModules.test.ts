import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hollowChunkUrl,
  isHollowChunkMessage,
  missingExportName,
} from "@/core/telemetry/crashReport";
import { fetchedChunkUrl, requireBootExports } from "./bootModules";

const ORIGIN = "https://dweeb.faizo.net";

/** Resource Timing as the live build's boot leaves it (Firefox 150, under a
 *  service worker): every module the document requested, by URL. */
function stubResources(names: string[]): void {
  vi.stubGlobal("location", { origin: ORIGIN });
  vi.stubGlobal("performance", {
    getEntriesByType: (type: string) =>
      type === "resource" ? names.map((name) => ({ name })) : [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requireBootExports", () => {
  it("hands back a namespace that carries every export", () => {
    const flows = { webhookFlow: {}, loginFlow: {}, botAddFlow: {} };
    expect(requireBootExports(flows, "flows", ["webhookFlow", "loginFlow", "botAddFlow"])).toBe(
      flows,
    );
  });

  it("turns the 2026-11-03 empty flows chunk into a hollow-chunk error naming its URL", () => {
    stubResources([
      `${ORIGIN}/assets/index-apw0fEe8.js`,
      `${ORIGIN}/assets/flows-Cs_Dwe0Q.js`,
      `${ORIGIN}/assets/popupFlow-DJYmbuLF.js`,
    ]);
    // What an empty module's namespace looks like: no exports at all.
    const empty = {} as { webhookFlow?: object; loginFlow?: object };
    let message = "";
    try {
      requireBootExports(empty, "flows", ["webhookFlow", "loginFlow"]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(isHollowChunkMessage(message)).toBe(true);
    expect(missingExportName(message)).toBe("webhookFlow");
    expect(hollowChunkUrl(message, ORIGIN)).toBe(`${ORIGIN}/assets/flows-Cs_Dwe0Q.js`);
  });

  it("covers a merged module read off a namespace the hollow chunk never had", () => {
    // `import("@/app/App")` compiles to `import("./App-….js").then(e => e.A)`.
    stubResources([`${ORIGIN}/assets/App-BzRrZEHI.js`, `${ORIGIN}/assets/App-B26UWfb1.css`]);
    expect(() =>
      requireBootExports(undefined as { App?: unknown } | undefined, "App", ["App"]),
    ).toThrow(
      `Boot chunk "App" loaded without its export 'App' (${ORIGIN}/assets/App-BzRrZEHI.js)`,
    );
  });
});

describe("fetchedChunkUrl", () => {
  it("names nothing it can't pin to exactly one file of ours", () => {
    stubResources([
      `${ORIGIN}/assets/flows-Cs_Dwe0Q.js`,
      `${ORIGIN}/assets/flows-Zz9yXx8w.js`,
      `https://cdn.example/assets/App-x1.js`,
      `${ORIGIN}/assets/App-B26UWfb1.css`,
      `${ORIGIN}/assets/AppShell-x1.js`,
    ]);
    expect(fetchedChunkUrl("flows")).toBe(null); // two candidates
    expect(fetchedChunkUrl("App")).toBe(null); // cross-origin, CSS, another name
    expect(fetchedChunkUrl("acquisition")).toBe(null);
  });

  it("is null wherever Resource Timing or a location is missing", () => {
    expect(fetchedChunkUrl("flows")).toBe(null);
  });
});
