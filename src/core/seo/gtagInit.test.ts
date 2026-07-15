import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const loaderSource = readFileSync(new URL("../../../public/gtag-init.js", import.meta.url), "utf8");

function runLoader(
  href: string,
  options: { canonical?: string; appShell?: boolean; referrer?: string } = {},
): { pageLocation: string; pageReferrer: string; delays: number[] } {
  const dataLayer: IArguments[] = [];
  const delays: number[] = [];
  const location = new URL(href);
  const windowMock = {
    location,
    dataLayer,
    doNotTrack: "0",
    addEventListener() {},
    removeEventListener() {},
  };
  const documentMock = {
    referrer: options.referrer ?? "",
    documentElement: {
      getAttribute: (name: string) => (name === "data-page-type" ? "landing" : null),
      hasAttribute: (name: string) => name === "data-app-shell" && !!options.appShell,
    },
    querySelector: () => (options.canonical ? { href: options.canonical } : null),
    addEventListener() {},
    createElement: () => ({}),
    head: { appendChild() {} },
  };

  runInNewContext(loaderSource, {
    window: windowMock,
    navigator: { doNotTrack: "0", globalPrivacyControl: false },
    document: documentMock,
    URL,
    Date,
    // Do not execute delayed network-loading callbacks in a unit test.
    setTimeout: (_callback: () => void, delay = 0) => {
      delays.push(delay);
      return 0;
    },
  });

  const config = dataLayer.map((args) => Array.from(args)).find((args) => args[0] === "config");
  return {
    pageLocation: (config?.[2] as { page_location?: string } | undefined)?.page_location ?? "",
    pageReferrer: (config?.[2] as { page_referrer?: string } | undefined)?.page_referrer ?? "",
    delays,
  };
}

function configuredPageLocation(href: string, canonical?: string): string {
  return runLoader(href, { canonical }).pageLocation;
}

describe("analytics page-location privacy", () => {
  it.each([
    ["https://dweeb.faizo.net/#s=compressed-private-draft", "https://dweeb.faizo.net/"],
    ["https://dweeb.faizo.net/?code=oauth-secret&state=csrf-secret", "https://dweeb.faizo.net/"],
    ["https://dweeb.faizo.net/?plans=123456789012345678", "https://dweeb.faizo.net/"],
    ["https://dweeb.faizo.net/s/AbC1234#s=another-secret", "https://dweeb.faizo.net/"],
    ["https://dweeb.faizo.net/api/webhooks/123456/super-secret-token", "https://dweeb.faizo.net/"],
  ])("redacts sensitive URL %s", (href, expected) => {
    expect(configuredPageLocation(href)).toBe(expected);
  });

  it("uses a controlled public canonical and drops its query and hash", () => {
    expect(
      configuredPageLocation(
        "https://dweeb.faizo.net/guides/arbitrary-private-slug/?guild=123#secret",
        "https://dweeb.faizo.net/guides/discord-components-v2/?campaign=ignored#ignored",
      ),
    ).toBe("https://dweeb.faizo.net/guides/discord-components-v2/");
  });

  it("keeps third-party analytics behind the app-shell paint window", () => {
    expect(runLoader("https://dweeb.faizo.net/", { appShell: true }).delays).toContain(8000);
  });

  it("keeps only the HTTP referrer's origin", () => {
    expect(
      runLoader("https://dweeb.faizo.net/", {
        referrer: "https://example.com/private/path?token=secret#fragment",
      }).pageReferrer,
    ).toBe("https://example.com/");
  });
});
