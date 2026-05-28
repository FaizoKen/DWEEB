/**
 * Local (in-browser) AI provider — WebGPU inference via @mlc-ai/web-llm.
 *
 * The engine runs inside a dedicated Web Worker (see `webllmWorker.ts`), driven
 * through `CreateWebWorkerMLCEngine`. This is how the official chat.webllm.ai
 * app runs WebLLM, and on a weak integrated GPU it is the difference between
 * "works" and "freezes then crashes":
 *
 *   • In-page inference pins both the main thread and the GPU queue. The tab
 *     locks up mid-reply and the iGPU eventually trips its watchdog (a Windows
 *     TDR / "device-removed"), which wedges Chrome's *shared* GPU process for
 *     every tab until a full restart. Off-main-thread inference keeps the UI
 *     responsive and isolates the GPU submission, so the watchdog isn't tripped.
 *
 * Beyond that we stay completely hands-off, exactly like chat.webllm.ai. We
 * deliberately do NOT:
 *
 *   • monkey-patch `navigator.gpu` / `requestAdapter`,
 *   • strip or add any GPU device features (e.g. `subgroups`),
 *   • force a `powerPreference`, or
 *   • auto-retry a failed load/generate by recreating the engine/device.
 *
 * That last point matters: when a TDR does reset the GPU, recreating the device
 * hammers Chrome's GPU process while it is still restarting, and after a few
 * such crashes Chrome blocklists the GPU browser-wide for the session. So we
 * make exactly one attempt, surface a clear message if it fails, and let the
 * user act (resend, smaller model, reload, cloud). On any failure we tear the
 * worker down so the *next* user send starts from a clean GPU context.
 *
 * The @mlc-ai/web-llm package is heavy, so the main-thread import is *dynamic* —
 * it only loads when the user picks the local provider and sends a message; the
 * worker is likewise only spawned at that point.
 */

import type {
  WebWorkerMLCEngine,
  InitProgressReport,
  ChatCompletionMessageParam,
} from "@mlc-ai/web-llm";
import type { AiSettings } from "./types";
import type { AiCallResult, AiTurn } from "./providers";

/** Surfaced to the UI while a model is downloading / compiling. */
export interface LocalLoadProgress {
  /** Human-readable status string from the runtime (e.g. "Loading shard 4/12"). */
  text: string;
  /** 0..1, monotonically increasing within a single load. */
  progress: number;
}

export interface LocalModelInfo {
  id: string;
  label: string;
  /** Approximate compressed download size in MB — shown in the picker. */
  sizeMB: number;
}

/**
 * Curated subset of WebLLM's prebuilt models, ordered from lightest to
 * heaviest. Anything in the prebuilt registry can be pasted in by hand, but
 * the dropdown stays short and decision-friendly.
 */
export const LOCAL_MODELS: LocalModelInfo[] = [
  {
    id: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
    label: "Llama 3.2 1B — recommended",
    sizeMB: 879,
  },
  {
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    label: "Qwen 2.5 0.5B — smallest, fastest",
    sizeMB: 314,
  },
  {
    id: "SmolLM2-360M-Instruct-q4f32_1-MLC",
    label: "SmolLM2 360M — tiniest",
    sizeMB: 290,
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    label: "Qwen 2.5 1.5B — more capable",
    sizeMB: 868,
  },
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    label: "Llama 3.2 3B — most capable",
    sizeMB: 1895,
  },
];

export const DEFAULT_LOCAL_MODEL: string = LOCAL_MODELS[0]!.id;

export const RETIRED_LOCAL_MODELS: Record<string, string> = {
  // Required shader-f16, broke on mobile GPUs — replaced with q4f32_1.
  "SmolLM2-360M-Instruct-q4f16_1-MLC": "SmolLM2-360M-Instruct-q4f32_1-MLC",
};

export function isLocalModelKnown(id: string): boolean {
  return LOCAL_MODELS.some((m) => m.id === id);
}

/** Cheap synchronous check — the user-facing form uses this to warn early. */
export function isWebGpuSupported(): boolean {
  if (typeof navigator === "undefined") return false;
  return Boolean((navigator as unknown as { gpu?: unknown }).gpu);
}

/**
 * Best-effort detection of mobile/tablet form factors. WebGPU on mobile browsers
 * exposes adapters with the spec's *minimum* buffer limits, which often isn't
 * enough to host these models reliably; combined with flaky cellular downloads
 * of hundreds of MB, local AI on mobile is impractical. We use this only as a
 * soft warning in settings — never as a hard block from inside the engine.
 */
export function isLikelyMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/android|iphone|ipad|ipod|mobile|tablet/i.test(ua)) return true;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const small = window.matchMedia("(max-width: 900px)").matches;
    if (coarse && small) return true;
  }
  return false;
}

/**
 * The "GPU was reset" signature: a removed/lost D3D12 device, a DXGI
 * device-removed code, or a failure creating the D3D12 command queue (the first
 * backend op, which fails instantly when the adapter is backed by an
 * already-dead device). On Windows this is almost always a TDR (Timeout
 * Detection & Recovery) reset of the GPU. We don't try to recover from it
 * in-page — once Chrome's shared GPU process is wedged, only restarting that
 * process (a full Chrome quit) brings it back — so we just explain it well.
 */
function isGpuResetError(message: string): boolean {
  return /device[_\s]?removed|device(?:\s+was)?\s+lost|dxgi_error|d3d12|create command queue/i.test(
    message,
  );
}

/**
 * Softer, genuinely transient GPU errors — a buffer unmapped mid-readback, an
 * object/tensor disposed by a racing teardown, or the follow-on "model not
 * loaded" once that teardown has dropped the model. These are NOT a wedged GPU
 * process (unlike `isGpuResetError`): the device is still alive. We don't
 * auto-retry them in-request — the teardown disposes the engine's model, so a
 * same-engine retry just hits "model not loaded" — but resending works because
 * `runOnce` resets the cached engine first, so the next send reloads cleanly.
 */
function isSoftGpuError(message: string): boolean {
  return /mapasync|buffer (?:was|is) unmapped|object has (?:already )?been disposed|tensor has already been disposed|model not loaded/i.test(
    message,
  );
}

/**
 * "Couldn't get a GPU adapter." On a machine that genuinely has WebGPU (the
 * page exposes `navigator.gpu`), a null adapter is usually a transient
 * GPU-process blip — the process is restarting after a crash, or is briefly
 * saturated. A plain page reload almost always clears it.
 */
function isNoAdapterError(message: string): boolean {
  return /unable to find a compatible gpu|find a compatible gpu|requestadapter.*null|no.*gpu adapter/i.test(
    message,
  );
}

/** The message shown when the GPU device was reset (Windows TDR / device-removed). */
function gpuResetMessage(modelId: string, raw: string): string {
  return (
    `Couldn't load the local model "${modelId}". The browser's GPU device was reset by its ` +
    `driver (a Windows TDR / "device-removed").\n\n` +
    "Once Chrome's shared GPU process is in this state, JavaScript on the page can't revive it, " +
    "and a plain tab reload usually isn't enough either. In order of what actually fixes it:\n" +
    "• Fully quit Chrome — close every window, check the tray/Task Manager — then reopen. That's what restarts the GPU process.\n" +
    "• Update your GPU driver (Intel/AMD/NVIDIA). On Windows an outdated driver is the most common cause of a device-removed loop.\n" +
    '• Try a smaller model — "Qwen 2.5 0.5B" or "SmolLM2 360M". They upload and compile far faster, so they\'re much less likely to trip the GPU\'s ~2-second watchdog while loading.\n' +
    "• Close other GPU-heavy apps/tabs (video calls, games, 3D, other AI tabs) before retrying.\n\n" +
    "Want to keep working right now? Switch to a free cloud model (Groq or OpenRouter) under AI settings — it runs server-side, so no local GPU is involved.\n\n" +
    `Underlying error: ${raw}`
  );
}

/**
 * A transient mid-generation GPU glitch (buffers torn down during readback,
 * leaving the model disposed). The device itself is fine, so resending almost
 * always works — `runOnce` resets the cached engine on this failure, so the
 * next send reloads from a clean state.
 */
function softGlitchMessage(modelId: string, raw: string): string {
  return (
    `The local model "${modelId}" hit a transient GPU glitch mid-reply — its buffers were ` +
    `torn down before the response finished.\n\n` +
    "The GPU itself is fine; the model just needs reloading. Usually this clears on its own:\n" +
    "• Send your message again — the model reloads and the reply normally goes through.\n" +
    '• If it keeps happening, try a smaller model ("Qwen 2.5 0.5B" or "SmolLM2 360M") — they\'re less likely to trip the GPU\'s watchdog.\n' +
    "• Or reload the page (Ctrl+Shift+R) to start the GPU process fresh.\n\n" +
    "Prefer not to fight it? Switch to a free cloud model (Groq or OpenRouter) under AI settings — no local GPU involved.\n\n" +
    `Underlying error: ${raw}`
  );
}

/**
 * Translate an engine load failure into something the user can act on.
 */
function explainEngineLoadError(modelId: string, raw: string): string {
  const head = `Couldn't load the local model "${modelId}".`;

  if (isGpuResetError(raw)) {
    return gpuResetMessage(modelId, raw);
  }
  if (isNoAdapterError(raw)) {
    return (
      `${head}\n\n` +
      "The browser exposes WebGPU but didn't hand back a GPU adapter. " +
      "On a machine that can run WebGPU at all, this is almost always a temporary GPU-process hiccup or a system-graphics setting — not a missing GPU.\n\n" +
      "Try these, in order:\n" +
      "• Reload the page (Ctrl+Shift+R / Cmd+Shift+R). This restarts the browser's GPU process and clears most adapter hiccups.\n" +
      "• Close other GPU-heavy tabs (video calls, games, 3D apps, other AI tabs) and reload.\n" +
      '• Make sure hardware acceleration is on: chrome://settings/system → "Use graphics acceleration when available", then restart Chrome.\n' +
      "• Update your GPU driver (Intel/AMD/NVIDIA) — an outdated driver is the most common root cause on Windows.\n" +
      "• Sanity-check at https://webgpureport.org/ and https://webllm.mlc.ai — if those show a GPU and load a model, reloading this page will usually work too.\n\n" +
      "Note: leave chrome://flags/#enable-unsafe-webgpu at its Default. On many systems forcing it on switches WebGPU to a backend that fails to load models — it makes this worse, not better.\n\n" +
      "Still stuck? Switch to a free cloud provider (Groq or OpenRouter) under AI settings — they run server-side, no GPU needed."
    );
  }
  if (/webgpu.*not.*available|navigator\.gpu/i.test(raw)) {
    return (
      `${head}\n\n` +
      "Your browser doesn't expose WebGPU. Try the latest Chrome or Edge (desktop), or Safari 17.4+. " +
      "On Firefox you may need to enable WebGPU under about:config (dom.webgpu.enabled)."
    );
  }
  if (/shader-?f16/i.test(raw)) {
    return (
      `${head}\n\n` +
      "This model needs the WebGPU \"shader-f16\" extension, which this device's GPU doesn't expose. " +
      "Pick a different model from the list — Llama 3.2 1B or SmolLM2 360M work on more devices."
    );
  }
  if (/failed to fetch|networkerror|load failed|err_network/i.test(raw)) {
    return (
      `${head}\n\n` +
      "The browser couldn't download the model files. Common causes:\n" +
      "• A network or extension is blocking huggingface.co or its CDN.\n" +
      "• You're offline.\n" +
      "• A previous download was cached as corrupted — clear site data and retry.\n\n" +
      `Underlying error: ${raw}`
    );
  }
  if (/out of memory|oom|allocation|cannot initialize runtime/i.test(raw)) {
    return (
      `${head}\n\n` +
      "Your device ran out of memory loading this model. Try a smaller option — SmolLM2 360M or Qwen 2.5 0.5B — or switch to a free cloud provider (Groq, OpenRouter) under AI settings."
    );
  }
  return `${head}\n\n${raw}`;
}

// ── Engine singleton ─────────────────────────────────────────────────────────
let engine: WebWorkerMLCEngine | null = null;
let worker: Worker | null = null;
let currentModelId: string | null = null;

let engineLock: Promise<void> = Promise.resolve();

async function acquireEngineLock(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prior = engineLock;
  engineLock = next;
  await prior.catch(() => {});
  return release;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Tear down the cached engine and its worker. `engine.unload()` releases the
 * WebGPU device and model weights; we *await* it (capped) before terminating
 * the worker so the device is freed cleanly. Terminating the worker disposes
 * the whole GPU context, so the next `ensureEngine` spawns a fresh worker with
 * a brand-new device — the cleanest possible recovery after a GPU reset, and
 * something an in-page engine can't do. This runs on a model switch and after a
 * failed load/generate (so a dead or half-initialized engine is never cached),
 * never as part of an automatic retry loop.
 */
async function resetEngine(): Promise<void> {
  const e = engine;
  const w = worker;
  engine = null;
  worker = null;
  currentModelId = null;
  if (e) {
    const done = e.unload().catch(() => {});
    await Promise.race([done, delay(2000)]);
  }
  if (w) {
    try {
      w.terminate();
    } catch {
      // Already gone; nothing to clean up.
    }
  }
}

async function ensureEngine(
  modelId: string,
  onProgress?: (p: LocalLoadProgress) => void,
): Promise<WebWorkerMLCEngine> {
  const progressCb = (report: InitProgressReport) => {
    onProgress?.({ text: report.text, progress: report.progress });
  };

  if (engine && currentModelId === modelId) {
    engine.setInitProgressCallback(progressCb);
    return engine;
  }

  await resetEngine();

  const webllm = await import("@mlc-ai/web-llm");

  const w = new Worker(new URL("./webllmWorker.ts", import.meta.url), { type: "module" });
  try {
    const created = await webllm.CreateWebWorkerMLCEngine(w, modelId, {
      initProgressCallback: progressCb,
    });
    worker = w;
    engine = created;
    currentModelId = modelId;
    return created;
  } catch (e) {
    // The engine never came up; don't leak the worker we just spawned.
    try {
      w.terminate();
    } catch {
      // ignore
    }
    throw e;
  }
}

export async function callLocal(
  settings: AiSettings,
  system: string,
  turns: AiTurn[],
  signal?: AbortSignal,
  onProgress?: (p: LocalLoadProgress) => void,
): Promise<AiCallResult> {
  const modelId = settings.model.trim() || DEFAULT_LOCAL_MODEL;

  if (!isWebGpuSupported()) {
    return {
      ok: false,
      error:
        "Your browser doesn't support WebGPU, which is required to run AI locally. " +
        "Try the latest Chrome or Edge (desktop), or Safari 17.4+. " +
        "On Firefox you may need to enable WebGPU under about:config (dom.webgpu.enabled).",
    };
  }

  const release = await acquireEngineLock();
  try {
    return await runOnce(modelId, system, turns, signal, onProgress);
  } finally {
    release();
  }
}

/**
 * Load the model (if needed) and generate one reply. A single attempt — there
 * is no automatic retry. If the GPU was reset, recreating the device here would
 * only hammer Chrome's restarting GPU process and risk a browser-wide GPU
 * blocklist; instead we surface a clear message and let the user act.
 *
 * On any failure we drop the cached engine: a load failure may leave a
 * half-initialized engine, and a generate failure on a GPU reset leaves the
 * engine's device dead. Either way the next user attempt must start fresh.
 */
async function runOnce(
  modelId: string,
  system: string,
  turns: AiTurn[],
  signal: AbortSignal | undefined,
  onProgress: ((p: LocalLoadProgress) => void) | undefined,
): Promise<AiCallResult> {
  if (signal?.aborted) return { ok: false, error: "Request cancelled." };

  let activeEngine: WebWorkerMLCEngine;
  try {
    activeEngine = await ensureEngine(modelId, onProgress);
  } catch (e) {
    await resetEngine();
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: explainEngineLoadError(modelId, message) };
  }

  if (signal?.aborted) return { ok: false, error: "Request cancelled." };

  const onAbort = () => {
    try {
      // On the worker engine this is fire-and-forget (it posts an interrupt
      // message to the worker and returns void).
      activeEngine.interruptGenerate();
    } catch {
      // The engine may already be gone; nothing to interrupt.
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...turns.map((t) => ({ role: t.role, content: t.content })),
    ];
    const reply = await activeEngine.chat.completions.create({
      messages,
      temperature: 0.4,
      max_tokens: 2048,
    });
    if (signal?.aborted) return { ok: false, error: "Request cancelled." };

    const text = reply.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.length === 0) {
      return { ok: false, error: "The local model returned an empty response." };
    }
    return { ok: true, text };
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: "Request cancelled." };
    const message = e instanceof Error ? e.message : String(e);
    // The engine's WebGPU device may be dead (GPU reset) or its model disposed
    // by a soft teardown; either way drop the cached engine so the next send
    // starts from a clean reload. No in-request retry — recreating the engine
    // here is exactly what could hammer a restarting GPU process.
    await resetEngine();
    if (isGpuResetError(message)) {
      return { ok: false, error: gpuResetMessage(modelId, message) };
    }
    if (isSoftGpuError(message)) {
      return { ok: false, error: softGlitchMessage(modelId, message) };
    }
    return { ok: false, error: `Local model error: ${message}` };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
