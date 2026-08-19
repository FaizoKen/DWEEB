import { createHash } from "node:crypto";

export const OG_ASSET_MANIFEST_VERSION = 1;

export interface OgAssetFingerprint {
  /** SHA-256 of the exact UTF-8 SVG string handed to Sharp. */
  sourceSvgSha256: string;
  /** SHA-256 of the committed PNG bytes emitted by Sharp. */
  pngSha256: string;
  width: number;
  height: number;
}

export interface OgAssetManifest {
  schemaVersion: typeof OG_ASSET_MANIFEST_VERSION;
  generator: string;
  assets: Record<string, OgAssetFingerprint>;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintOgAsset(
  sourceSvg: string,
  png: Uint8Array,
  width: number,
  height: number,
): OgAssetFingerprint {
  return {
    sourceSvgSha256: sha256(sourceSvg),
    pngSha256: sha256(png),
    width,
    height,
  };
}

/** Stable key order + no timestamps keeps committed manifests reproducible. */
export function serializeOgAssetManifest(
  generator: string,
  entries: Iterable<readonly [string, OgAssetFingerprint]>,
): string {
  // Code-unit order is runtime- and locale-independent; `localeCompare` is not.
  const assets = Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const manifest: OgAssetManifest = {
    schemaVersion: OG_ASSET_MANIFEST_VERSION,
    generator,
    assets,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Strict enough for the SEO audit to distinguish corruption from staleness. */
export function parseOgAssetManifest(raw: string): OgAssetManifest {
  const value = JSON.parse(raw) as Partial<OgAssetManifest>;
  if (
    value.schemaVersion !== OG_ASSET_MANIFEST_VERSION ||
    typeof value.generator !== "string" ||
    value.generator.length === 0 ||
    !value.assets ||
    typeof value.assets !== "object" ||
    Array.isArray(value.assets)
  ) {
    throw new Error("Invalid OG asset manifest header");
  }

  for (const [assetPath, entry] of Object.entries(value.assets)) {
    if (
      !assetPath.startsWith("/") ||
      !assetPath.endsWith(".png") ||
      !entry ||
      typeof entry !== "object" ||
      !SHA256.test(entry.sourceSvgSha256) ||
      !SHA256.test(entry.pngSha256) ||
      !Number.isInteger(entry.width) ||
      entry.width <= 0 ||
      !Number.isInteger(entry.height) ||
      entry.height <= 0
    ) {
      throw new Error(`Invalid OG asset manifest entry: ${assetPath}`);
    }
  }

  return value as OgAssetManifest;
}
