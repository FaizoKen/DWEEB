import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Engine = typeof import("./popupFlow");
type Flows = typeof import("./flows");

// Fresh modules per test: the engine keeps this tab's attempts in module state.
let cancelPopup: Engine["cancelPopup"];
let consumeReturn: Engine["consumeReturn"];
let openPopup: Engine["openPopup"];
let redirectFullPage: Engine["redirectFullPage"];
let relayPopupIfApplicable: Engine["relayPopupIfApplicable"];
let sendPopup: Engine["sendPopup"];
let startPopupFlow: Engine["startPopupFlow"];
let subscribePopupResult: Engine["subscribePopupResult"];
let botAddFlow: Flows["botAddFlow"];
let loginFlow: Flows["loginFlow"];
let webhookFlow: Flows["webhookFlow"];

/**
 * The engine runs against browser globals Vitest's node environment lacks, so
 * each test gets Map-backed storage and a minimal `window`. BroadcastChannel is
 * Node's own, which is what carries a popup's result between "tabs" here.
 */
let local: Map<string, string>;
let session: Map<string, string>;
let replaceState: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;

function storage(map: Map<string, string>): Storage {
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  } as unknown as Storage;
}

function stubBrowser(
  opts: {
    hash?: string;
    search?: string;
    opener?: unknown;
    name?: string;
    open?: (...args: unknown[]) => unknown;
  } = {},
) {
  replaceState = vi.fn();
  assign = vi.fn();
  const hash = opts.hash ?? "";
  const search = opts.search ?? "";
  vi.stubGlobal("localStorage", storage(local));
  vi.stubGlobal("sessionStorage", storage(session));
  vi.stubGlobal("window", {
    location: {
      hash,
      search,
      pathname: "/",
      href: `https://dweeb.test/${search}${hash}`,
      assign,
    },
    history: { replaceState },
    opener: opts.opener ?? null,
    name: opts.name ?? "",
    innerWidth: 1200,
    innerHeight: 800,
    open: opts.open ?? (() => ({ closed: false, location: {}, focus: () => {} })),
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    setTimeout: () => 0,
    close: () => {},
  });
  vi.stubGlobal("document", { body: { textContent: "" } });
}

const tick = () => new Promise((r) => setTimeout(r, 25));
const MINE = "https://discord.com/api/webhooks/222222222222222222/my-token";
const THEIRS = "https://discord.com/api/webhooks/111111111111111111/attacker-token";

/** What a returning popup broadcasts — `deliverResult`'s channel half. */
async function broadcast(kind: string, result: unknown): Promise<void> {
  const channel = new BroadcastChannel(`dweeb_${kind}`);
  channel.postMessage(result);
  await tick();
  channel.close();
}

beforeEach(async () => {
  local = new Map();
  session = new Map();
  stubBrowser();
  vi.resetModules();
  ({
    cancelPopup,
    consumeReturn,
    openPopup,
    redirectFullPage,
    relayPopupIfApplicable,
    sendPopup,
    startPopupFlow,
    subscribePopupResult,
  } = await import("./popupFlow"));
  ({ botAddFlow, loginFlow, webhookFlow } = await import("./flows"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("popup results are acted on only by the tab that asked", () => {
  it("ignores a webhook result this tab never opened a popup for, and leaves it for the opener", async () => {
    // Another tab's (or a stranger's) handoff, already sitting in storage.
    local.set("dweeb_webhook_result", JSON.stringify({ at: Date.now(), result: { url: THEIRS } }));
    const seen: unknown[] = [];
    const stop = subscribePopupResult(webhookFlow, (r) => seen.push(r));
    try {
      await broadcast("webhook", { url: THEIRS });
      expect(seen).toEqual([]);
      // Not ours to drop: the tab that owns the handoff may be about to read it.
      expect(local.has("dweeb_webhook_result")).toBe(true);
    } finally {
      stop();
    }
  });

  it("acts on its own result once, however many channels bring it", async () => {
    expect(openPopup(webhookFlow)).not.toBeNull();
    const seen: unknown[] = [];
    const stop = subscribePopupResult(webhookFlow, (r) => seen.push(r));
    try {
      await broadcast("webhook", { url: MINE });
      await broadcast("webhook", { url: MINE }); // the popup's relay after the handle poll
      expect(seen).toEqual([{ url: MINE }]);
    } finally {
      stop();
    }
  });

  it("delivers a second run of the flow — re-adding the bot to the same server", async () => {
    const seen: unknown[] = [];
    const stop = subscribePopupResult(botAddFlow, (r) => seen.push(r));
    try {
      openPopup(botAddFlow);
      await broadcast("botadd", { guildId: "123456789012345678" });
      openPopup(botAddFlow);
      await broadcast("botadd", { guildId: "123456789012345678" });
      expect(seen).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it("never answers a new attempt with an earlier run's leftover handoff", () => {
    openPopup(webhookFlow);
    const startedAt = Number(session.get("dweeb_webhook_attempt"));
    local.set(
      "dweeb_webhook_result",
      JSON.stringify({ at: startedAt - 1000, result: { url: THEIRS } }),
    );
    const seen: unknown[] = [];
    const stop = subscribePopupResult(webhookFlow, (r) => seen.push(r));
    stop();
    expect(seen).toEqual([]);
    expect(local.has("dweeb_webhook_result")).toBe(false);
  });

  it("still accepts its result after the opener reloaded mid-flow", () => {
    // The attempt survives in this tab's sessionStorage, not just in memory.
    session.set("dweeb_webhook_attempt", String(Date.now() - 1000));
    local.set("dweeb_webhook_result", JSON.stringify({ at: Date.now(), result: { url: MINE } }));
    const seen: unknown[] = [];
    subscribePopupResult(webhookFlow, (r) => seen.push(r))();
    expect(seen).toEqual([{ url: MINE }]);
  });
});

describe("the login flow's 'finished' signal reaches every tab", () => {
  it("is acted on without an attempt, counts once per delivery, and again for a later sign-in", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const seen: unknown[] = [];
    const stop = subscribePopupResult(loginFlow, (r) => seen.push(r));
    try {
      await broadcast("login", { ok: true });
      await broadcast("login", { ok: true }); // same delivery, second channel
      expect(seen).toHaveLength(1);
      now += 60_000; // signed out, then signed in again a minute later
      await broadcast("login", { ok: true });
      expect(seen).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it("delivers a second sign-in in the tab that opened both popups, however soon", async () => {
    const seen: unknown[] = [];
    const stop = subscribePopupResult(loginFlow, (r) => seen.push(r));
    try {
      openPopup(loginFlow);
      await broadcast("login", { ok: true });
      openPopup(loginFlow);
      await broadcast("login", { ok: true });
      expect(seen).toHaveLength(2);
    } finally {
      stop();
    }
  });
});

describe("a returning popup is recognised only by its pending mark", () => {
  const RETURN = `#dweeb_webhook=${encodeURIComponent(THEIRS)}&channel=x`;

  it("treats a window some page opened — opener and name chosen by it — as no popup", () => {
    stubBrowser({ hash: RETURN, opener: { cross: "origin" }, name: "dweeb_webhook" });
    expect(relayPopupIfApplicable(webhookFlow)).toBe(false);
    expect(local.has("dweeb_webhook_result")).toBe(false);
  });

  it("relays when a DWEEB tab marked the popup pending", () => {
    stubBrowser({ hash: RETURN });
    local.set("dweeb_webhook_pending", String(Date.now()));
    expect(relayPopupIfApplicable(webhookFlow)).toBe(true);
    expect(local.has("dweeb_webhook_result")).toBe(true);
  });
});

describe("a full-page return is applied only by the tab that redirected itself", () => {
  const RETURN = `#dweeb_webhook=${encodeURIComponent(MINE)}&channel=general`;

  it("strips and ignores a return this tab never started", () => {
    stubBrowser({ hash: `${RETURN}&s=keep` });
    expect(consumeReturn(webhookFlow)).toBeNull();
    // The markers still leave the address bar; unrelated state stays.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/#s=keep");
  });

  it("applies the return of a tab that sent itself into the flow", () => {
    redirectFullPage(webhookFlow, "https://discord.test/oauth");
    stubBrowser({ hash: RETURN });
    // main.tsx's relay check runs first and spends the mark…
    expect(relayPopupIfApplicable(webhookFlow)).toBe(false);
    // …which `consumeReturn` still honours.
    expect(consumeReturn(webhookFlow)).toEqual({ url: MINE, channelName: "general" });
    // One use: a reload of the same URL isn't a second return.
    expect(consumeReturn(webhookFlow)).toBeNull();
  });
});

describe("a flow always gets somewhere, whatever the browser does with the popup", () => {
  const LOGIN = "https://api.dweeb.test/auth/login";

  /** A popup like the one Safari handed back on 2026-11-13: real enough to
   *  hold, but sending it on from outside throws. */
  function unnavigablePopup() {
    const popup = { closed: false, focus: vi.fn(), close: vi.fn(), location: {} };
    Object.defineProperty(popup.location, "href", {
      get: () => "about:blank",
      set: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    return popup;
  }

  it("opens a click's known URL in the popup itself, never navigating it from outside", () => {
    const popup = unnavigablePopup();
    const open = vi.fn(() => popup);
    stubBrowser({ open });
    // The incident: this threw out of the Sign in click, every time.
    expect(() => startPopupFlow(loginFlow, LOGIN)).not.toThrow();
    expect(open).toHaveBeenCalledWith(LOGIN, "dweeb_login", expect.stringContaining("popup=yes"));
    expect(local.has("dweeb_login_pending")).toBe(true);
    expect(session.has("dweeb_login_attempt")).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });

  it("leaves the page when the popup is blocked, holding no popup attempt", () => {
    stubBrowser({ open: () => null });
    startPopupFlow(webhookFlow, LOGIN);
    expect(assign).toHaveBeenCalledWith(LOGIN);
    expect(session.get("dweeb_webhook_self_redirect")).toBe("1");
    expect(local.has("dweeb_webhook_pending")).toBe(false);
    expect(session.has("dweeb_webhook_attempt")).toBe(false);
  });

  it("reads a window.open that throws as a blocked popup", () => {
    stubBrowser({
      open: () => {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(() => startPopupFlow(botAddFlow, LOGIN)).not.toThrow();
    expect(assign).toHaveBeenCalledWith(LOGIN);
  });

  it("closes a popup the browser won't navigate and leaves the page instead", () => {
    const popup = unnavigablePopup();
    stubBrowser({ open: () => popup });
    const opened = openPopup(webhookFlow);
    expect(opened).toBe(popup);
    // …the authorize URL arrives after an await…
    expect(() => sendPopup(webhookFlow, opened, LOGIN)).not.toThrow();
    expect(popup.close).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith(LOGIN);
    expect(session.get("dweeb_webhook_self_redirect")).toBe("1");
    // No popup is in flight, so this tab no longer waits on a popup's result.
    expect(session.has("dweeb_webhook_attempt")).toBe(false);
    expect(local.has("dweeb_webhook_pending")).toBe(false);
  });

  it("sends a navigable popup on and stays on the page", () => {
    const popup = { closed: false, focus: vi.fn(), close: vi.fn(), location: { href: "" } };
    stubBrowser({ open: () => popup });
    sendPopup(webhookFlow, openPopup(webhookFlow), LOGIN);
    expect(popup.location.href).toBe(LOGIN);
    expect(popup.close).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("forgets an abandoned popup, so its kind of result is no longer awaited", async () => {
    const popup = { closed: false, focus: vi.fn(), close: vi.fn(), location: {} };
    stubBrowser({ open: () => popup });
    cancelPopup(webhookFlow, openPopup(webhookFlow));
    expect(popup.close).toHaveBeenCalled();
    expect(local.has("dweeb_webhook_pending")).toBe(false);
    const seen: unknown[] = [];
    const stop = subscribePopupResult(webhookFlow, (r) => seen.push(r));
    try {
      await broadcast("webhook", { url: THEIRS });
      expect(seen).toEqual([]);
    } finally {
      stop();
    }
  });
});
