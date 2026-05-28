/**
 * Local (in-browser) AI provider — WebGPU inference via @mlc-ai/web-llm.
 *
 * Two engine modes, chosen automatically:
 *
 *   • Worker mode (default). The MLCEngine, the WebGPU device, and the
 *     model weights all live inside a dedicated worker. Buys us GPU-device
 *     isolation from main-thread React work and a hard-reset path
 *     (`worker.terminate()`) that releases stuck devices at the OS level —
 *     critical for Windows D3D12 `DXGI_ERROR_DEVICE_REMOVED` recovery.
 *     This is what chat.webllm.ai does.
 *
 *   • In-page mode (fallback). Some Chrome configurations expose WebGPU
 *     only on the main thread (older versions, some integrated-GPU
 *     drivers, certain enterprise policies). The worker's
 *     `requestAdapter()` returns null even though the main thread's would
 *     work. When we detect that, we switch the singleton to an in-page
 *     `MLCEngine` for the rest of the session.
 *
 * The @mlc-ai/web-llm package is heavy, so the import is *dynamic* — it only
 * pulls into the main bundle when the user picks the local provider and
 * sends a message.
 */

import type {
  WebWorkerMLCEngine,
  MLCEngine,
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
 * Patch `navigator.gpu.requestAdapter` so that a null result from the default
 * (`powerPreference: "high-performance"`) request transparently falls back to
 * no-preference and then "low-power". Mirrors the worker-side patch in
 * `llmWorker.ts` for the in-page engine path.
 *
 * Idempotent — the second call is a no-op because the wrapped function is
 * tagged.
 */
function patchMainThreadRequestAdapterOnce(): void {
  type AdapterRequestOptions = { powerPreference?: string } & Record<string, unknown>;
  type RequestAdapterFn = (options?: AdapterRequestOptions) => Promise<unknown>;
  const nav = navigator as unknown as {
    gpu?: { requestAdapter?: RequestAdapterFn & { __dwbPatched?: boolean } };
  };
  const gpu = nav.gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function" || gpu.requestAdapter.__dwbPatched) return;

  const original = gpu.requestAdapter.bind(gpu);
  const patched: RequestAdapterFn & { __dwbPatched?: boolean } = async function patched(
    options?: AdapterRequestOptions,
  ) {
    const first = await original(options);
    if (first) return first;
    if (options && options.powerPreference === "high-performance") {
      const { powerPreference: _ignored, ...rest } = options;
      const restKeys = Object.keys(rest).length > 0 ? rest : undefined;
      const noPref = await original(restKeys as AdapterRequestOptions | undefined);
      if (noPref) return noPref;
      const lowPower = await original({ ...rest, powerPreference: "low-power" });
      if (lowPower) return lowPower;
    }
    return first;
  };
  patched.__dwbPatched = true;
  gpu.requestAdapter = patched;
}

/**
 * Classify an engine error as a transient GPU/driver hiccup that a retry
 * with a fresh worker will likely recover from.
 */
function isTransientGpuError(message: string): boolean {
  return /device[_\s]?removed|device lost|device was lost|dxgi_error|d3d12|mapasync|buffer was unmapped|buffer is unmapped|command queue|object has (?:already )?been disposed|tensor has already been disposed/i.test(
    message,
  );
}

/**
 * "Worker has no compatible GPU." Detecting this specifically lets us drop
 * the worker engine and fall back to the in-page one for the rest of the
 * session — older Chrome versions and some iGPU drivers expose WebGPU only
 * to the main thread.
 */
function isNoAdapterError(message: string): boolean {
  return /unable to find a compatible gpu|find a compatible gpu|requestadapter.*null|no.*gpu adapter/i.test(
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

  if (isNoAdapterError(raw)) {
    return (
      `${head}\n\n` +
      "Your browser exposes WebGPU but couldn't find a usable GPU adapter — even after we retried with every power-preference setting on both the main thread and a worker.\n\n" +
      "Most common causes on a system with integrated graphics:\n" +
      "• Chrome's WebGPU is disabled for your GPU. Open chrome://flags/#enable-unsafe-webgpu, set it to Enabled, and restart Chrome.\n" +
      "• Hardware acceleration is off. Open chrome://settings/system and make sure \"Use graphics acceleration when available\" is on.\n" +
      "• Your GPU driver is outdated. Updating it (Intel/AMD/NVIDIA control panel) fixes this most of the time on Windows.\n" +
      "• Confirm the diagnosis at https://webgpureport.org/ — if it shows no adapter, the engine can't run here either.\n\n" +
      "If none of those help, switch to a free cloud provider (Groq or OpenRouter) under AI settings — they run on the server, no GPU needed."
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

// ── Engine singletons ───────────────────────────────────────────────────────
type EngineMode = "worker" | "inpage";

let mode: EngineMode = "worker";
let workerEngine: WebWorkerMLCEngine | null = null;
let worker: Worker | null = null;
let inPageEngine: MLCEngine | null = null;
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

function spawnWorker(): Worker {
  return new Worker(new URL("./llmWorker.ts", import.meta.url), {
    type: "module",
    name: "webllm-engine",
  });
}

/**
 * Tear down the cached engine + worker for the current mode. Safe to call
 * any time.
 *
 *   • Worker mode: `worker.terminate()` is the real cleanup — the OS
 *     reclaims the GPU device when the worker dies, which we can't
 *     reliably achieve from within a single page context.
 *   • In-page mode: best-effort `engine.unload()` so the in-page WebGPU
 *     resources are released before we drop the reference.
 */
function resetEngine(): void {
  if (mode === "worker") {
    const w = worker;
    workerEngine = null;
    worker = null;
    if (w) {
      try {
        w.terminate();
      } catch {
        // ignore
      }
    }
  } else {
    const e = inPageEngine;
    inPageEngine = null;
    if (e) {
      // unload is async; fire and forget — we don't await because the
      // engine state is already considered dead from our perspective.
      void e.unload().catch(() => {});
    }
  }
  currentModelId = null;
}

/** The minimal interface our retry loop needs from either engine flavor. */
interface ActiveEngine {
  chat: WebWorkerMLCEngine["chat"];
  interruptGenerate: () => void | Promise<void>;
}

async function ensureEngine(
  modelId: string,
  onProgress?: (p: LocalLoadProgress) => void,
): Promise<ActiveEngine> {
  const progressCb = (report: InitProgressReport) => {
    onProgress?.({ text: report.text, progress: report.progress });
  };

  if (mode === "worker" && workerEngine && currentModelId === modelId) {
    workerEngine.setInitProgressCallback(progressCb);
    return workerEngine;
  }
  if (mode === "inpage" && inPageEngine && currentModelId === modelId) {
    inPageEngine.setInitProgressCallback(progressCb);
    return inPageEngine;
  }

  resetEngine();

  const webllm = await import("@mlc-ai/web-llm");

  if (mode === "worker") {
    const newWorker = spawnWorker();
    worker = newWorker;
    try {
      const created = await webllm.CreateWebWorkerMLCEngine(newWorker, modelId, {
        initProgressCallback: progressCb,
      });
      workerEngine = created;
      currentModelId = modelId;
      return created;
    } catch (e) {
      workerEngine = null;
      currentModelId = null;
      worker = null;
      try {
        newWorker.terminate();
      } catch {
        // ignore
      }
      throw e;
    }
  }

  // In-page mode: apply the requestAdapter fallback to navigator.gpu before
  // the engine asks for an adapter.
  patchMainThreadRequestAdapterOnce();
  try {
    const created = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: progressCb,
    });
    inPageEngine = created;
    currentModelId = modelId;
    return created;
  } catch (e) {
    inPageEngine = null;
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
    return await runWithRetry(modelId, system, turns, signal, onProgress, 0);
  } finally {
    release();
  }
}

/**
 * Run one load+generate cycle. Three escape hatches:
 *
 *   1. Transient GPU error → terminate the worker, wait per the backoff
 *      schedule, try again with a fresh worker (or in-page engine,
 *      whichever mode we're in).
 *   2. "No GPU adapter" inside the worker → drop to in-page mode and retry
 *      once. Sticky for the rest of the session.
 *   3. Anything else → surface a user-facing message.
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

  let activeEngine: ActiveEngine;
  try {
    activeEngine = await ensureEngine(modelId, onProgress);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);

    // Worker reported "no compatible GPU" — fall back to in-page once.
    if (mode === "worker" && isNoAdapterError(message)) {
      mode = "inpage";
      resetEngine();
      return runWithRetry(modelId, system, turns, signal, onProgress, attempt);
    }

    if (attempt < TRANSIENT_RETRY_DELAYS_MS.length && isTransientGpuError(message)) {
      resetEngine();
      await delay(TRANSIENT_RETRY_DELAYS_MS[attempt]!);
      return runWithRetry(modelId, system, turns, signal, onProgress, attempt + 1);
    }
    if (isTransientGpuError(message)) {
      return { ok: false, error: gpuStuckMessage(modelId, message) };
    }
    return { ok: false, error: explainEngineLoadError(modelId, message) };
  }

  if (signal?.aborted) return { ok: false, error: "Request cancelled." };

  const onAbort = () => {
    try {
      const result = activeEngine.interruptGenerate();
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch(() => {});
      }
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

    if (mode === "worker" && isNoAdapterError(message)) {
      mode = "inpage";
      signal?.removeEventListener("abort", onAbort);
      resetEngine();
      return runWithRetry(modelId, system, turns, signal, onProgress, attempt);
    }

    if (attempt < TRANSIENT_RETRY_DELAYS_MS.length && isTransientGpuError(message)) {
      signal?.removeEventListener("abort", onAbort);
      resetEngine();
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
