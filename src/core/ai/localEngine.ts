/**
 * Local (in-browser) AI provider — WebGPU inference via @mlc-ai/web-llm.
 *
 * The engine, the WebGPU device, and the model weights all live on the main
 * thread via `CreateMLCEngine`. This is exactly what the official WebLLM
 * get-started demo (https://webllm.mlc.ai) does, and it is the most reliable
 * path in practice:
 *
 *   • The main thread is where WebGPU is most widely exposed. Some Chrome
 *     configurations (older versions, certain integrated-GPU drivers, some
 *     enterprise policies) don't expose `navigator.gpu` to *workers* at all,
 *     so a worker-hosted engine fails on machines where the page itself runs
 *     WebGPU fine.
 *   • Hosting the engine in a worker also means a GPU hiccup inside the worker
 *     can drag down Chrome's shared GPU process, which then makes the main
 *     thread's next `requestAdapter()` return null — i.e. a worker failure can
 *     manufacture a "no compatible GPU" error on a machine that otherwise
 *     works. Running in-page avoids that cross-context cascade.
 *
 * A wedged GPU device is recovered by `engine.unload()` + a fresh
 * `CreateMLCEngine`, with a short backoff. If that still fails, the surfaced
 * message tells the user to reload the page (which fully restarts Chrome's GPU
 * process) or switch to a cloud provider.
 *
 * The @mlc-ai/web-llm package is heavy, so the import is *dynamic* — it only
 * pulls into the bundle when the user picks the local provider and sends a
 * message.
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
 * Wrap a GPUAdapter so the experimental `subgroups` feature is never requested
 * at device creation.
 *
 * WebLLM's `detectGPUDevice` opportunistically adds every advertised feature it
 * likes — including `subgroups` — to the `requestDevice()` call. None of the
 * models we ship actually require it (their model libs only list `shader-f16`),
 * but several Windows / Intel iGPU drivers fault when a D3D12 device is created
 * with subgroups enabled, taking the device down with
 * `DXGI_ERROR_DEVICE_REMOVED` before a single byte of inference runs. Stripping
 * it is pure upside here: we lose a perf optimization we weren't relying on and
 * dodge a driver crash. This also matches how older WebLLM builds — like the
 * ones some official demos still run — behaved before subgroups was added.
 */
function wrapAdapterStripSubgroups<T>(adapter: T): T {
  const a = adapter as unknown as {
    requestDevice?: (
      descriptor?: { requiredFeatures?: string[] } & Record<string, unknown>,
    ) => unknown;
    __dwbDeviceWrapped?: boolean;
  } | null;
  if (!a || typeof a.requestDevice !== "function" || a.__dwbDeviceWrapped) return adapter;

  const original = a.requestDevice.bind(a);
  try {
    a.requestDevice = function patchedRequestDevice(descriptor) {
      let desc = descriptor;
      if (
        desc &&
        Array.isArray(desc.requiredFeatures) &&
        desc.requiredFeatures.includes("subgroups")
      ) {
        desc = {
          ...desc,
          requiredFeatures: desc.requiredFeatures.filter((f) => f !== "subgroups"),
        };
      }
      return original(desc);
    };
    a.__dwbDeviceWrapped = true;
  } catch {
    // Some platforms hand back a non-extensible adapter; leave it untouched.
  }
  return adapter;
}

/**
 * Patch `navigator.gpu.requestAdapter` so that:
 *
 *   1. A null result from the default (`powerPreference: "high-performance"`)
 *      request transparently falls back to no-preference, then "low-power".
 *      WebLLM hard-codes the high-performance request and throws a generic "no
 *      compatible GPU" error on null; on some older Chromium + iGPU builds the
 *      high-performance path returns null even though a no-preference request
 *      yields the iGPU.
 *   2. Every adapter it hands back has the crash-prone `subgroups` feature
 *      stripped from device creation (see `wrapAdapterStripSubgroups`).
 *
 * WebLLM exposes no hook for either, so we wrap the call here. Idempotent — the
 * second call is a no-op because the wrapped function is tagged. No-op if
 * WebGPU isn't exposed at all.
 */
function patchRequestAdapterOnce(): void {
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
    if (first) return wrapAdapterStripSubgroups(first);
    if (options && options.powerPreference === "high-performance") {
      const { powerPreference: _ignored, ...rest } = options;
      const restKeys = Object.keys(rest).length > 0 ? rest : undefined;
      const noPref = await original(restKeys as AdapterRequestOptions | undefined);
      if (noPref) return wrapAdapterStripSubgroups(noPref);
      const lowPower = await original({ ...rest, powerPreference: "low-power" });
      if (lowPower) return wrapAdapterStripSubgroups(lowPower);
    }
    return first;
  };
  patched.__dwbPatched = true;
  gpu.requestAdapter = patched;
}

/**
 * Classify an engine error as a transient GPU/driver hiccup that a retry
 * with a fresh engine will likely recover from.
 */
function isTransientGpuError(message: string): boolean {
  return /device[_\s]?removed|device lost|device was lost|dxgi_error|d3d12|mapasync|buffer was unmapped|buffer is unmapped|command queue|object has (?:already )?been disposed|tensor has already been disposed/i.test(
    message,
  );
}

/**
 * "Couldn't get a GPU adapter." On a machine that genuinely has WebGPU (the
 * page exposes `navigator.gpu`), a null adapter is almost always a transient
 * GPU-process blip — the process is restarting after a crash, or is briefly
 * saturated. Worth a couple of quick retries before giving up.
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
      "The browser exposes WebGPU but didn't hand back a GPU adapter, even after a few retries. " +
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

function gpuStuckMessage(modelId: string, raw: string): string {
  return (
    `Couldn't load the local model "${modelId}" — the browser's GPU device was reset by the driver (Windows TDR / device-removed) before the model could load.\n\n` +
    "Once Chrome's GPU process is in this state, a tab reload usually isn't enough — the process is shared across the whole browser. Try, in order:\n" +
    "• Fully quit Chrome (close every window, then check the tray) and reopen it. This is what restarts the GPU process; a plain reload often doesn't.\n" +
    "• Close other GPU-heavy apps/tabs (video calls, games, 3D, other AI tabs) before retrying.\n" +
    "• Update your GPU driver (Intel/AMD/NVIDIA) — on Windows an outdated driver is the most common root cause of a device-removed loop.\n" +
    "• Sanity-check at https://webgpureport.org/ — when the GPU process is healthy it shows an adapter; if the official https://webllm.mlc.ai demo loads a model, this page will too after a clean restart.\n" +
    '• In the model list, the "Llama 3.2 1B — recommended" option is the most broadly compatible.\n' +
    "• Still looping? Switch to a free cloud provider (Groq or OpenRouter) under AI settings — no GPU needed.\n\n" +
    `Underlying error: ${raw}`
  );
}

// ── Engine singleton ─────────────────────────────────────────────────────────
let engine: MLCEngine | null = null;
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

/**
 * Tear down the cached engine. `engine.unload()` releases the WebGPU device and
 * model weights; we *await* it (capped) before letting a fresh
 * `CreateMLCEngine` create another device — two live WebGPU devices on a
 * memory-tight iGPU can themselves provoke `DXGI_ERROR_DEVICE_REMOVED`. The cap
 * keeps a hung unload from blocking recovery.
 */
async function resetEngine(): Promise<void> {
  const e = engine;
  engine = null;
  currentModelId = null;
  if (e) {
    const done = e.unload().catch(() => {});
    await Promise.race([done, delay(2000)]);
  }
}

async function ensureEngine(
  modelId: string,
  onProgress?: (p: LocalLoadProgress) => void,
): Promise<MLCEngine> {
  const progressCb = (report: InitProgressReport) => {
    onProgress?.({ text: report.text, progress: report.progress });
  };

  if (engine && currentModelId === modelId) {
    engine.setInitProgressCallback(progressCb);
    return engine;
  }

  await resetEngine();

  const webllm = await import("@mlc-ai/web-llm");

  // Apply the requestAdapter fallback to navigator.gpu before the engine asks
  // for an adapter.
  patchRequestAdapterOnce();

  try {
    const created = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: progressCb,
    });
    engine = created;
    currentModelId = modelId;
    return created;
  } catch (e) {
    engine = null;
    currentModelId = null;
    throw e;
  }
}

/**
 * Backoff schedule for retryable load failures. The first retry fires almost
 * immediately for the common "first attempt got unlucky" case; subsequent
 * delays give Windows D3D12 time to actually release a stuck device handle and
 * give Chrome's GPU process time to come back up after a crash (both are
 * asynchronous and can take 1–2 seconds to settle).
 */
const RETRY_DELAYS_MS = [400, 1500, 3000];

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
 * Run one load+generate cycle. Two escape hatches:
 *
 *   1. Transient GPU error, or a null adapter on a WebGPU-capable machine →
 *      unload, wait per the backoff schedule, try again with a fresh engine.
 *   2. Anything else → surface a user-facing message.
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

  let activeEngine: MLCEngine;
  try {
    activeEngine = await ensureEngine(modelId, onProgress);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const retryable = isTransientGpuError(message) || isNoAdapterError(message);

    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      await resetEngine();
      await delay(RETRY_DELAYS_MS[attempt]!);
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

    if (attempt < RETRY_DELAYS_MS.length && isTransientGpuError(message)) {
      signal?.removeEventListener("abort", onAbort);
      await resetEngine();
      await delay(RETRY_DELAYS_MS[attempt]!);
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
