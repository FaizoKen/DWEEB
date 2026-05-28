/**
 * Local (in-browser) AI provider — WebGPU inference via @mlc-ai/web-llm.
 *
 * Everything runs on the user's machine: weights are downloaded once from
 * Hugging Face, cached by the browser, and inference happens on the GPU via
 * WebGPU. Nothing leaves the device, no API key is needed.
 *
 * The @mlc-ai/web-llm package is heavy (compiled tokenizer / runtime), so the
 * import is *dynamic* — it only pulls into the bundle when the user actually
 * picks the local provider and sends a message. The engine itself is held in a
 * module-level singleton: the first `callLocal()` downloads + compiles the
 * model, subsequent calls reuse it. Switching to a different local model
 * reloads weights on the same engine instance.
 */

import type { MLCEngine, InitProgressReport, ChatCompletionMessageParam } from "@mlc-ai/web-llm";
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
 *
 * Quantization choice: q4f32_1 for the smallest models, q4f16_1 for the
 * larger ones. The f16 variants require the WebGPU `shader-f16` feature and
 * fail on adapters without it; q4f32_1 loads on any WebGPU device (at the
 * cost of a slightly larger download). For models where both variants exist
 * we keep the smallest model on q4f32_1 to maximize device coverage.
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

/**
 * Model ids that the curated list previously offered but that fail on common
 * devices. `loadAiSettings()` migrates saved settings off these ids so users
 * don't get stuck with a model that can't load.
 */
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
 * Classify an engine error as a transient GPU/driver hiccup that a retry
 * with a fresh engine will likely recover from. Covers:
 *
 *   • `DXGI_ERROR_DEVICE_REMOVED` and friends — D3D12 / Vulkan / Metal can
 *     yank the GPU device out from under WebGPU. On Windows this commonly
 *     fires from `requestDevice()` itself when a prior device's destruction
 *     hasn't fully drained through the driver yet.
 *   • "Device lost" / "device was lost" — same class on other platforms.
 *   • "Buffer was unmapped" / mapAsync races — WebLLM's internal GPU state
 *     can desync when an interrupt or model swap collides with an in-flight
 *     buffer map. The cached engine is corrupted but a fresh one is fine.
 *   • "Object has already been disposed" — thrown by TVM when its internal
 *     handle is 0. WebLLM's `device.lost` handler auto-calls `unload()`
 *     behind our back when the GPU drops the device, leaving our cached
 *     engine as a zombie. The next call into it trips this. Cure: drop the
 *     cached engine and rebuild.
 *
 * We deliberately do NOT match "Failed to fetch" here — that's almost always
 * a real CORS/connectivity problem, not a transient driver issue, and
 * retrying immediately won't help.
 */
function isTransientGpuError(message: string): boolean {
  return /device[_\s]?removed|device lost|device was lost|dxgi_error|d3d12|mapasync|buffer was unmapped|buffer is unmapped|command queue|object has (?:already )?been disposed|tensor has already been disposed/i.test(
    message,
  );
}

/**
 * Translate a non-transient engine load failure into something the user can
 * act on. Transient driver hiccups are handled by the retry loop and never
 * reach this function.
 */
function explainEngineLoadError(modelId: string, raw: string): string {
  const head = `Couldn't load the local model "${modelId}".`;

  if (/webgpu.*not.*available|gpu adapter|navigator\.gpu/i.test(raw)) {
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

// ── Engine singleton ────────────────────────────────────────────────────────
// One engine per page lifetime; reloading swaps models on the same instance.
let engine: MLCEngine | null = null;
let currentModelId: string | null = null;

/**
 * Serializes all engine usage — load, model swap, and chat completion all run
 * under this lock. Without it, two paths race against each other on the same
 * GPU-resident engine and tear its state:
 *
 *   • Cancelling a send flips `thinking: false` in the store immediately, so
 *     the user can fire a new send while the prior `chat.completions.create()`
 *     is still settling its interrupt. Two concurrent completions on one engine
 *     surface as "Model not loaded before trying to complete ChatCompletionRequest".
 *   • Changing the local model in settings triggers a `reload()` on the next
 *     send. Reload tears down the prior model's GPU buffers; if a prior
 *     completion's mapAsync hasn't resolved yet, that surfaces as
 *     "Buffer was unmapped before mapping was resolved".
 */
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

/**
 * Tear down the cached engine and release its GPU resources. Safe to call
 * when `engine` is already null. Errors during unload are swallowed — a
 * failed unload still leaves us better off than an orphaned reference.
 */
async function resetEngine(): Promise<void> {
  const e = engine;
  engine = null;
  currentModelId = null;
  if (e) {
    try {
      await e.unload();
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * Ensure an MLCEngine is loaded for `modelId`. Uses one process-wide engine
 * instance:
 *   • Same model already loaded → reuse, re-attach the progress callback.
 *   • Different model loaded   → call `engine.reload(modelId)` to swap.
 *   • No engine yet            → `CreateMLCEngine(modelId)`.
 *
 * Throws on any failure. Caller is responsible for retrying transient
 * driver errors (see `callLocal`).
 */
async function ensureEngine(
  modelId: string,
  onProgress?: (p: LocalLoadProgress) => void,
): Promise<MLCEngine> {
  const progressCb = (report: InitProgressReport) => {
    onProgress?.({ text: report.text, progress: report.progress });
  };

  // Already loaded — reuse without touching the GPU device.
  if (engine && currentModelId === modelId) {
    engine.setInitProgressCallback(progressCb);
    return engine;
  }

  const webllm = await import("@mlc-ai/web-llm");

  // Model swap: ask the existing engine to reload onto the new weights.
  // `reload()` internally unloads first, so it cleanly hands the device off
  // from one model to the next without leaving two pipelines resident.
  if (engine) {
    try {
      engine.setInitProgressCallback(progressCb);
      await engine.reload(modelId);
      currentModelId = modelId;
      return engine;
    } catch (e) {
      // Reload failed mid-swap. The existing engine is in an unknown state
      // (possibly with its device destroyed) so drop it before propagating —
      // the next attempt will create a fresh one.
      await resetEngine();
      throw e;
    }
  }

  // First load on this page.
  try {
    const created = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: progressCb,
    });
    engine = created;
    currentModelId = modelId;
    return created;
  } catch (e) {
    // CreateMLCEngine = `new MLCEngine().reload()`. If reload threw, the
    // engine var was never assigned — nothing to clean up — but make sure
    // module state is in sync.
    engine = null;
    currentModelId = null;
    throw e;
  }
}

/**
 * Backoff schedule for transient GPU errors. The first retry fires almost
 * immediately for the common "first attempt got unlucky" case; subsequent
 * delays give Windows D3D12 time to actually release a stuck device handle
 * (releases are asynchronous in the driver and can take 1–2 seconds to drain).
 */
const TRANSIENT_RETRY_DELAYS_MS = [400, 1500, 3000];

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Terminal message shown when every retry hit the same GPU-driver wall.
 * At this point the device handle is genuinely stuck — there is nothing
 * the engine can do from inside the page that the user hasn't already had
 * us try. A page reload (or, on Windows, a driver update) is the only
 * reliable cure.
 */
function gpuStuckMessage(modelId: string, raw: string): string {
  return (
    `Couldn't load the local model "${modelId}" — the browser's GPU device kept getting reset by the driver.\n\n` +
    "We retried automatically a few times and it didn't recover. Try one of these:\n" +
    "• Reload the page (Ctrl+Shift+R / Cmd+Shift+R) to reset Chrome's GPU process.\n" +
    "• Close other GPU-heavy tabs (video calls, games, 3D apps, other AI tabs) and reload.\n" +
    "• On Windows, an outdated GPU driver is the most common root cause — updating it usually fixes this for good.\n" +
    "• If it keeps happening, switch to a free cloud provider (Groq or OpenRouter) under AI settings.\n\n" +
    `Underlying error: ${raw}`
  );
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

  // Hold the lock across getEngine + chat.completions.create so a swap or a
  // second send can't race the in-flight GPU work. See engineLock for the why.
  const release = await acquireEngineLock();
  try {
    return await runWithRetry(modelId, system, turns, signal, onProgress, 0);
  } finally {
    release();
  }
}

/**
 * Run one load+generate cycle, with a single automatic retry when the failure
 * looks like a transient GPU driver hiccup. The retry path fully tears down
 * the cached engine and waits briefly for the driver to drain pending device
 * destructions before trying again.
 *
 * The official webllm.mlc.ai demo recovers from these errors by relying on
 * the user to refresh and try again; here we do that step for them so a
 * single bad device-create doesn't dead-end the conversation.
 */
async function runWithRetry(
  modelId: string,
  system: string,
  turns: AiTurn[],
  signal: AbortSignal | undefined,
  onProgress: ((p: LocalLoadProgress) => void) | undefined,
  attempt: number,
): Promise<AiCallResult> {
  if (signal?.aborted) return { ok: false, error: "Request cancelled." };

  let mlcEngine: MLCEngine;
  try {
    mlcEngine = await ensureEngine(modelId, onProgress);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (attempt < TRANSIENT_RETRY_DELAYS_MS.length && isTransientGpuError(message)) {
      await resetEngine();
      await delay(TRANSIENT_RETRY_DELAYS_MS[attempt]!);
      return runWithRetry(modelId, system, turns, signal, onProgress, attempt + 1);
    }
    // Out of retries on a transient error → the driver/device really is wedged
    // and only a page reload (or driver update) will clear it.
    if (isTransientGpuError(message)) {
      return { ok: false, error: gpuStuckMessage(modelId, message) };
    }
    return { ok: false, error: explainEngineLoadError(modelId, message) };
  }

  if (signal?.aborted) return { ok: false, error: "Request cancelled." };

  // Wire the abort signal up to the engine's interrupt API. The engine
  // resolves the in-flight promise with whatever it has so far on interrupt.
  const onAbort = () => {
    void mlcEngine.interruptGenerate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...turns.map((t) => ({ role: t.role, content: t.content })),
    ];
    const reply = await mlcEngine.chat.completions.create({
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
    if (attempt < TRANSIENT_RETRY_DELAYS_MS.length && isTransientGpuError(message)) {
      signal?.removeEventListener("abort", onAbort);
      await resetEngine();
      await delay(TRANSIENT_RETRY_DELAYS_MS[attempt]!);
      return runWithRetry(modelId, system, turns, signal, onProgress, attempt + 1);
    }
    if (isTransientGpuError(message)) {
      return { ok: false, error: gpuStuckMessage(modelId, message) };
    }
    return { ok: false, error: `Local model error: ${message}` };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
