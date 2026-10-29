import { describe, expect, it } from "vitest";
import {
  AD_COOLDOWN_MS,
  AD_MIN_VIEWPORT_HEIGHT,
  readAdRecord,
  recordAdShown,
  recordSend,
  sendAdAllowed,
  type SendAdFacts,
} from "./eligibility";
import { adsTxt, parseAdsenseClient, parseAdsenseSlot } from "./adsenseIds";

const NOW = 1_800_000_000_000;

/** A receipt that may show an ad; each test flips one fact. */
const OK: SendAdFacts = {
  configured: true,
  activity: false,
  privacySignal: false,
  saveData: false,
  blocked: false,
  addressHoldsState: false,
  viewportHeight: 900,
  priorSends: 3,
  lastShownAt: null,
  now: NOW,
};

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

describe("sendAdAllowed", () => {
  it("allows a configured web receipt with nothing against it", () => {
    expect(sendAdAllowed(OK)).toBe(true);
  });

  it("never shows an ad in a build without ads or inside the Activity", () => {
    expect(sendAdAllowed({ ...OK, configured: false })).toBe(false);
    expect(sendAdAllowed({ ...OK, activity: true })).toBe(false);
  });

  it("respects privacy signals, data saving and an ad blocker", () => {
    expect(sendAdAllowed({ ...OK, privacySignal: true })).toBe(false);
    expect(sendAdAllowed({ ...OK, saveData: true })).toBe(false);
    expect(sendAdAllowed({ ...OK, blocked: true })).toBe(false);
  });

  it("never sends a URL that still carries app state (a share link's hash is the message)", () => {
    expect(sendAdAllowed({ ...OK, addressHoldsState: true })).toBe(false);
  });

  it("keeps the first successful send in a browser ad-free", () => {
    expect(sendAdAllowed({ ...OK, priorSends: 0 })).toBe(false);
    expect(sendAdAllowed({ ...OK, priorSends: 1 })).toBe(true);
  });

  it("skips a viewport too short to spare the room", () => {
    expect(sendAdAllowed({ ...OK, viewportHeight: AD_MIN_VIEWPORT_HEIGHT - 1 })).toBe(false);
    expect(sendAdAllowed({ ...OK, viewportHeight: AD_MIN_VIEWPORT_HEIGHT })).toBe(true);
  });

  it("shows at most one ad per cooldown window", () => {
    expect(sendAdAllowed({ ...OK, lastShownAt: NOW - 1_000 })).toBe(false);
    expect(sendAdAllowed({ ...OK, lastShownAt: NOW - AD_COOLDOWN_MS + 1 })).toBe(false);
    expect(sendAdAllowed({ ...OK, lastShownAt: NOW - AD_COOLDOWN_MS })).toBe(true);
  });

  it("isn't silenced by a clock that moved backwards", () => {
    expect(sendAdAllowed({ ...OK, lastShownAt: NOW + 60_000 })).toBe(true);
  });
});

describe("the ad record", () => {
  it("counts sends and remembers the last ad", () => {
    const storage = memoryStorage();
    expect(readAdRecord(storage)).toEqual({ sends: 0, lastShownAt: null });
    recordSend(storage);
    recordSend(storage);
    recordAdShown(NOW, storage);
    expect(readAdRecord(storage)).toEqual({ sends: 2, lastShownAt: NOW });
  });

  it("reads anything malformed as a fresh browser", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      '{"sends":"9","lastShownAt":"x"}',
      '{"sends":-4}',
    ]) {
      expect(readAdRecord(memoryStorage({ "dweeb.ads.receipt.v1": raw }))).toEqual({
        sends: 0,
        lastShownAt: null,
      });
    }
  });

  it("survives storage that throws (blocked site data)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    } as unknown as Storage;
    expect(readAdRecord(throwing)).toEqual({ sends: 0, lastShownAt: null });
    expect(() => recordSend(throwing)).not.toThrow();
    expect(() => recordAdShown(NOW, throwing)).not.toThrow();
  });
});

describe("AdSense ids", () => {
  it("accepts only a real-shaped publisher id", () => {
    expect(parseAdsenseClient(" ca-pub-1234567890123456 ")).toBe("ca-pub-1234567890123456");
    for (const bad of [
      "",
      "pub-1234567890123456",
      "ca-pub-123",
      "ca-pub-1234567890123456\n#",
      undefined,
    ]) {
      expect(parseAdsenseClient(bad)).toBe("");
    }
  });

  it("accepts only a numeric slot id", () => {
    expect(parseAdsenseSlot("1234567890")).toBe("1234567890");
    expect(parseAdsenseSlot("12a4567890")).toBe("");
    expect(parseAdsenseSlot("")).toBe("");
  });

  it("writes the ads.txt record Google expects, and nothing for a bad id", () => {
    expect(adsTxt("ca-pub-1234567890123456")).toBe(
      "google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n",
    );
    expect(adsTxt("")).toBe("");
    expect(adsTxt("ca-pub-1")).toBe("");
  });
});
