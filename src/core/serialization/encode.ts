/**
 * Encode/decode for share URLs and JSON import/export.
 *
 * Share-URL pipeline:
 *   editor message → strip editor ids → JSON → LZ-String compress (URL-safe)
 *                  → `v{N}.{compressed}` token → URL hash
 *
 * Inverse:
 *   URL hash → split version + body → LZ-String decompress → JSON.parse
 *            → migrate to current version → attach fresh editor ids
 *
 * LZ-String's URL-safe encoding stays inside `[A-Za-z0-9+-$]` so the hash
 * survives copy-paste without percent-encoding.
 */

import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";

import type { WebhookMessage } from "@/core/schema/types";
import { CURRENT_VERSION, migrate } from "./version";
import { attachEditorFields, stripEditorFields, stripSessionAttachments } from "./normalize";

const SEPARATOR = ".";

/** Encode a message for inclusion in a URL hash. */
export function encodeShare(message: WebhookMessage): string {
  const wire = stripSessionAttachments(stripEditorFields(message));
  const json = JSON.stringify(wire);
  const compressed = compressToEncodedURIComponent(json);
  return `${CURRENT_VERSION}${SEPARATOR}${compressed}`;
}

export interface DecodeOk {
  ok: true;
  message: WebhookMessage;
  /** Raw token version, in case the UI wants to surface a migration notice. */
  version: number;
}
export interface DecodeErr {
  ok: false;
  error: string;
}
export type DecodeResult = DecodeOk | DecodeErr;

/** Decode a share token. Never throws — failures come back as DecodeErr. */
export function decodeShare(token: string): DecodeResult {
  const sepIdx = token.indexOf(SEPARATOR);
  if (sepIdx <= 0) {
    return { ok: false, error: "Share token is missing its version prefix." };
  }
  const versionStr = token.slice(0, sepIdx);
  const body = token.slice(sepIdx + 1);
  const version = Number.parseInt(versionStr, 10);
  if (Number.isNaN(version)) {
    return { ok: false, error: "Share token has a non-numeric version." };
  }
  const json = decompressFromEncodedURIComponent(body);
  if (!json) {
    return { ok: false, error: "Share token body could not be decompressed." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return {
      ok: false,
      error: `Share token body is not valid JSON: ${(e as Error).message}`,
    };
  }
  try {
    const migrated = migrate(version, parsed);
    return { ok: true, version, message: attachEditorFields(migrated) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** JSON-encode for download/clipboard. Indented for human review. */
export function encodeJson(message: WebhookMessage): string {
  return JSON.stringify(stripSessionAttachments(stripEditorFields(message)), null, 2);
}

/** Parse a JSON string (as produced by `encodeJson` or pasted from Discord). */
export function decodeJson(input: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  try {
    return { ok: true, version: CURRENT_VERSION, message: attachEditorFields(parsed) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
