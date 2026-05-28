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
 * unloads the old one before loading the new.
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
  /**
   * Some WebLLM prebuilts (q*f16 variants of certain models) declare
   * `required_features: ["shader-f16"]`. On adapters that lack the f16 shader
   * extension — common on mobile GPUs — the load fails with an opaque
   * "Failed to fetch". We probe the adapter for this feature before loading.
   */
  requiresShaderF16?: boolean;
}

/**
 * Curated subset of WebLLM's prebuilt models, ordered from lightest to
 * heaviest. Anything in the prebuilt registry can be pasted in by hand, but
 * the dropdown stays short and decision-friendly.
 *
 * The SmolLM2 360M entry uses the q4f32_1 variant (not q4f16_1), because the
 * f16 variant is gated on the WebGPU `shader-f16` feature that mobile GPUs
 * often lack. q4f32_1 is ~70 MB larger but loads on any WebGPU device.
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

/**
 * WebGPU types aren't in the default DOM lib and we don't want to pull in
 * `@webgpu/types` just to probe one feature. Narrow shape of what we touch.
 */
interface WebGpuAdapterLike {
  features: { has(name: string): boolean };
  limits: {
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
  };
}
interface WebGpuLike {
  requestAdapter(): Promise<WebGpuAdapterLike | null>;
}
function getWebGpu(): WebGpuLike | null {
  if (typeof navigator === "undefined") return null;
  const gpu = (navigator as unknown as { gpu?: WebGpuLike }).gpu;
  return gpu ?? null;
}

/** Cheap synchronous check — the user-facing form uses this to warn early. */
export function isWebGpuSupported(): boolean {
  return getWebGpu() !== null;
}

/**
 * Best-effort detection of mobile/tablet form factors. WebGPU on mobile browsers
 * exposes adapters with the spec's *minimum* buffer limits (256 MiB), which
 * isn't enough to host any of the curated models — WebLLM's allocation failure
 * is surfaced as "Failed to fetch", which is misleading. Combining UA hints
 * with coarse-pointer + small-viewport gives us a reliable signal without a
 * dependency.
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

// Every model in the curated list needs activation/parameter buffers larger
// than the WebGPU spec's 256 MiB floor. A 1 GiB ceiling on the adapter's
// `maxBufferSize` cleanly separates mobile GPUs (which sit at the floor) from
// desktop GPUs (which expose 2 GiB+). The 512 MiB storage-binding threshold
// catches the same class of device on the secondary limit.
const MIN_MAX_BUFFER_SIZE = 1024 * 1024 * 1024; // 1 GiB
const MIN_STORAGE_BINDING_SIZE = 512 * 1024 * 1024; // 512 MiB

/**
 * Probe the WebGPU adapter for the features and limits needed to load
 * `modelId`. Returns `null` on success, or a user-facing error string when the
 * adapter is unavailable, missing a required feature, or too constrained to
 * host any of the curated models. The probe is best-effort: an outright
 * adapter-request *exception* is treated as "unknown — let the engine try", so
 * we never block a load on a flaky preflight. A successful request that
 * returns `null` or an adapter with too-small limits *does* block — that's the
 * exact case mobile WebGPU hits today, and letting it through means burning
 * hundreds of MB of bandwidth before the inevitable failure.
 */
export async function probeWebGpuFor(modelId: string): Promise<string | null> {
  // Mobile is a non-starter for any of the curated WebLLM models: even when a
  // mobile adapter advertises adequate limits, the actual fetch / compile path
  // falls over on cellular/WiFi-throttled connections. Reject up front so the
  // user sees a clear message instead of a half-finished download that ends in
  // "Failed to fetch" — and so the heavy webllm bundle never loads.
  if (isLikelyMobile()) {
    return (
      "Local AI is desktop-only in practice — mobile browsers either can't allocate the buffers WebLLM needs " +
      "or can't reliably download the model files. " +
      "Open AI settings and switch to a free cloud provider — Groq and OpenRouter both have free tiers and work on mobile."
    );
  }

  const gpu = getWebGpu();
  if (!gpu) {
    return (
      "Your browser doesn't support WebGPU, which is required to run AI locally. " +
      "Try the latest Chrome or Edge (desktop), or Safari 17.4+. " +
      "On Firefox you may need to enable WebGPU under about:config (dom.webgpu.enabled)."
    );
  }

  let adapter: WebGpuAdapterLike | null;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    return null;
  }
  if (!adapter) {
    return (
      "Your browser exposes WebGPU but no GPU adapter is available. " +
      "This usually means the GPU driver doesn't support WebGPU yet — " +
      "switch to a free cloud provider (Groq or OpenRouter) under AI settings."
    );
  }

  const info = LOCAL_MODELS.find((m) => m.id === modelId);
  if (info?.requiresShaderF16 && !adapter.features.has("shader-f16")) {
    return (
      `The "${modelId}" model needs the WebGPU "shader-f16" extension, which this device's GPU doesn't expose. ` +
      "Pick a different model from the list — Llama 3.2 1B or SmolLM2 360M work on more devices."
    );
  }

  const maxBuffer = adapter.limits.maxBufferSize ?? 0;
  const maxBinding = adapter.limits.maxStorageBufferBindingSize ?? 0;
  if (maxBuffer < MIN_MAX_BUFFER_SIZE || maxBinding < MIN_STORAGE_BINDING_SIZE) {
    const mobile = isLikelyMobile();
    return (
      `This device's GPU is too constrained to run a local model in the browser ` +
      `(maxBufferSize ${formatBytes(maxBuffer)}, ${formatBytes(maxBinding)} per binding — ` +
      `at least ${formatBytes(MIN_MAX_BUFFER_SIZE)} / ${formatBytes(MIN_STORAGE_BINDING_SIZE)} needed). ` +
      (mobile
        ? "Local AI is desktop-only in practice — mobile WebGPU drivers cap buffer sizes well below what these models need. "
        : "") +
      "Open AI settings and switch to a free cloud provider — Groq and OpenRouter both have free tiers and no download."
    );
  }

  return null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MiB`;
  return `${bytes} B`;
}

/**
 * Map a raw error thrown by the WebLLM engine load into a message the user can
 * act on. `Failed to fetch` is the most common one and is almost never
 * literally a network failure — it's how the browser surfaces CORS preflight
 * issues, blocked requests, and GPU/feature mismatches that WebLLM doesn't
 * pre-check. The default branch is kept generic but actionable.
 */
function explainEngineLoadError(modelId: string, raw: string): string {
  const head = `Couldn't load the local model "${modelId}".`;
  // D3D12 / Vulkan / Metal can yank the GPU device out from under WebGPU
  // (driver TDR, driver crash, another GPU-heavy tab grabbing the device,
  // out-of-VRAM under contention). The browser surfaces this as a
  // `requestDevice()` failure with `DXGI_ERROR_DEVICE_REMOVED` (Windows) or
  // `device lost` (other platforms). Almost always transient.
  if (/device[_\s]?removed|device lost|dxgi_error|requestdevice/i.test(raw)) {
    return (
      `${head}\n\n` +
      "Your GPU was reset by its driver mid-load — usually transient. Try this in order:\n" +
      "• Send your message again. The cached engine is cleared, so it'll rebuild from scratch.\n" +
      "• Close other GPU-heavy tabs (video calls, games, 3D apps) and retry — they may be holding the device.\n" +
      "• Restart the browser to clear any stuck GPU state.\n" +
      "• On Windows, an outdated GPU driver is the most common root cause — updating it usually fixes this for good.\n" +
      "• If it keeps happening, switch to a free cloud provider (Groq or OpenRouter) under AI settings.\n\n" +
      `Underlying error: ${raw}`
    );
  }
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    const mobile = isLikelyMobile();
    if (mobile) {
      return (
        `${head}\n\n` +
        "Local AI is desktop-only in practice — mobile browsers either can't allocate the buffers WebLLM needs or can't reliably download the model files.\n\n" +
        "Open AI settings and switch to a free cloud provider — Groq and OpenRouter both have free tiers and work on mobile.\n\n" +
        `Underlying error: ${raw}`
      );
    }
    return (
      `${head}\n\n` +
      "The browser couldn't download the model files. This usually means:\n" +
      "• Your network blocked huggingface.co or raw.githubusercontent.com (try another network).\n" +
      "• Your device's GPU can't run this specific quantization — try a different model from the list, or switch to a free cloud provider (Groq, OpenRouter) under AI settings.\n" +
      "• You're offline.\n\n" +
      `Underlying error: ${raw}`
    );
  }
  if (/out of memory|oom|allocation/i.test(raw)) {
    return (
      `${head}\n\n` +
      "Your device ran out of memory loading this model. Try the SmolLM2 360M or Qwen 2.5 0.5B options, or switch to a free cloud provider (Groq, OpenRouter) under AI settings."
    );
  }
  return (
    `${head}\n\n${raw}\n\n` +
    "Make sure the model id is one of WebLLM's prebuilt ids and that your device has enough memory."
  );
}

// ── Engine singleton ────────────────────────────────────────────────────────
// One engine per page lifetime; reloading swaps models on the same instance.
let enginePromise: Promise<MLCEngine> | null = null;
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
 *
 * The lock drains both: a new caller waits for the prior one to finish before
 * touching the engine.
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

async function getEngine(
  modelId: string,
  onProgress?: (p: LocalLoadProgress) => void,
): Promise<MLCEngine> {
  // Same model already (loading or loaded) — reuse.
  if (enginePromise && currentModelId === modelId) {
    // Re-attach the progress callback so a fresh load in flight still surfaces
    // updates to the new caller's listener.
    const engine = await enginePromise;
    if (onProgress) {
      engine.setInitProgressCallback((r: InitProgressReport) => {
        onProgress({ text: r.text, progress: r.progress });
      });
    }
    return engine;
  }

  // Different model (or first load): reload weights in place on a single
  // engine instance instead of `unload() + CreateMLCEngine()`. The two-step
  // teardown/recreate path destroys the WebGPU device while in-flight mapAsync
  // operations may still be pending, surfacing later as the cryptic
  // "Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before
  // mapping was resolved" on the next completion. `reload()` is WebLLM's
  // documented swap path and reuses the device cleanly.
  const prior = enginePromise;
  currentModelId = modelId;
  enginePromise = (async () => {
    const webllm = await import("@mlc-ai/web-llm");
    const progressCb = (report: InitProgressReport) => {
      onProgress?.({ text: report.text, progress: report.progress });
    };

    if (prior) {
      try {
        const existing = await prior;
        existing.setInitProgressCallback(progressCb);
        await existing.reload(modelId);
        return existing;
      } catch {
        // Prior engine failed to load (or to reload onto the new model) — fall
        // through and create a fresh instance.
      }
    }

    return webllm.CreateMLCEngine(modelId, { initProgressCallback: progressCb });
  })();

  try {
    return await enginePromise;
  } catch (e) {
    // Reset so the next attempt can retry instead of returning the rejection.
    enginePromise = null;
    currentModelId = null;
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

  const preflight = await probeWebGpuFor(modelId);
  if (preflight) return { ok: false, error: preflight };

  // Hold the lock across getEngine + chat.completions.create so a swap or a
  // second send can't race the in-flight GPU work. See engineLock for the why.
  const release = await acquireEngineLock();
  try {
    if (signal?.aborted) return { ok: false, error: "Request cancelled." };

    let engine: MLCEngine;
    try {
      engine = await getEngine(modelId, onProgress);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: explainEngineLoadError(modelId, message) };
    }

    if (signal?.aborted) return { ok: false, error: "Request cancelled." };

    // Wire the abort signal up to the engine's interrupt API. The engine
    // resolves the in-flight promise with whatever it has so far on interrupt.
    const onAbort = () => {
      void engine.interruptGenerate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: system },
        ...turns.map((t) => ({ role: t.role, content: t.content })),
      ];
      const reply = await engine.chat.completions.create({
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
      // WebGPU buffer race inside WebLLM: a pending mapAsync read collides with
      // a buffer that was unmapped (typically by an interrupt or model swap).
      // Drop the cached engine so the next send rebuilds it from scratch
      // instead of inheriting the corrupted GPU state.
      if (/mapAsync|buffer was unmapped|buffer is unmapped/i.test(message)) {
        enginePromise = null;
        currentModelId = null;
        return {
          ok: false,
          error:
            "The local model's GPU state got out of sync (a known WebLLM bug). " +
            "Send your message again — the engine will reload itself. " +
            "If it keeps happening, switch to a free cloud provider (Groq or OpenRouter) under AI settings.",
        };
      }
      return { ok: false, error: `Local model error: ${message}` };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    release();
  }
}
