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
 * Curated subset of WebLLM's prebuilt models, ordered from lightest GPU load to
 * heaviest. Anything in the prebuilt registry can be pasted in by hand, but the
 * dropdown stays short and decision-friendly.
 *
 * The default leads with the gentlest model on purpose. "Local" is the
 * zero-friction, no-key option, so it's the one a brand-new user (often on an
 * integrated GPU) tries first — and on weak GPUs the heavier models trip the
 * driver's ~2-second watchdog while compiling/prefilling and reset the device.
 * `SmolLM2-135M-q0f16` is the smoothest of the bunch: it's tiny *and* uses raw
 * f16 weights (`q0`, no int quantization), so its kernels skip the
 * dequantization work the `q4*` models do — far less per-op GPU load, which is
 * exactly why it runs smoothly on low-end hardware (and on chat.webllm.ai). It
 * does need the `shader-f16` extension, which desktop Chrome/Edge GPUs expose;
 * a user whose GPU lacks it gets a clear "pick another model" error.
 */
export const LOCAL_MODELS: LocalModelInfo[] = [
  {
    id: "SmolLM2-135M-Instruct-q0f16-MLC",
    label: "SmolLM2 135M — smoothest, best for low-end GPUs",
    sizeMB: 271,
  },
  {
    id: "SmolLM2-360M-Instruct-q4f32_1-MLC",
    label: "SmolLM2 360M — tiny",
    sizeMB: 290,
  },
  {
    id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    label: "Qwen 2.5 0.5B — small, fast",
    sizeMB: 314,
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
    label: "Llama 3.2 1B — more capable",
    sizeMB: 879,
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

/** The message shown when the GPU device was reset (TDR / device-removed). */
function gpuResetMessage(modelId: string, raw: string): string {
  return (
    `Couldn't run the local model "${modelId}" — the GPU device was reset by its driver ` +
    `(a TDR / "device-removed") and didn't recover, even after an automatic reload.\n\n` +
    "This is common on integrated GPUs with limited memory. What helps, in order:\n" +
    "• Close other GPU-heavy apps/tabs (videos, games, 3D, other AI tabs) to free up the GPU, then try again.\n" +
    "• Fully quit Chrome — every window, check the tray/Task Manager — then reopen, to restart the GPU process.\n" +
    "• Update your GPU driver (Intel/AMD/NVIDIA) — outdated drivers are the most common cause on Windows.\n\n" +
    "For a reliable experience on this machine, switch to a free cloud model (Groq or OpenRouter) under AI settings — it runs server-side, so no local GPU is involved.\n\n" +
    `Underlying error: ${raw}`
  );
}

/**
 * A mid-generation GPU glitch (buffers torn down during readback as the driver
 * resets the device). Shown only after the automatic self-heal reload also
 * failed (see `callLocal`), so the machine is clearly struggling — we lead with
 * freeing the GPU and, for reliability, the cloud option.
 */
function softGlitchMessage(modelId: string, raw: string): string {
  return (
    `The local model "${modelId}" hit a GPU glitch mid-reply and didn't recover, even after an ` +
    `automatic reload — the GPU driver keeps resetting the device under load.\n\n` +
    "This is common on integrated GPUs with limited memory. What helps:\n" +
    "• Send again — it's intermittent, so the next try often goes through.\n" +
    "• Close other GPU-heavy apps/tabs (videos, games, other AI tabs) to free up the GPU.\n" +
    "• Reload the page (Ctrl+Shift+R) to start the GPU process fresh.\n\n" +
    "For a reliable experience on this machine, switch to a free cloud model (Groq or OpenRouter) under AI settings — it runs server-side, so no local GPU is involved.\n\n" +
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
      "Your device ran out of memory loading this model. Try the smallest option — SmolLM2 135M (the default) — or switch to a free cloud provider (Groq, OpenRouter) under AI settings."
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
    const created = await webllm.CreateWebWorkerMLCEngine(
      w,
      modelId,
      { initProgressCallback: progressCb },
      // Shrink the KV cache to fit a memory-tight iGPU (see LOCAL_CONTEXT_WINDOW).
      { context_window_size: LOCAL_CONTEXT_WINDOW },
    );
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

/**
 * Caps that keep the local model's GPU memory footprint small. On a memory-tight
 * integrated GPU the driver resets the device ("device lost" → a mid-reply
 * `mapAsync` AbortError) when the model weights + KV cache + the page's own GPU
 * use exceed VRAM. The biggest lever we control is the KV cache, which WebLLM
 * allocates up front from the context window — so we ask for a smaller one for
 * local models, and keep input+output inside it. Cloud providers have no such
 * limit and are untouched.
 *
 *   • `LOCAL_CONTEXT_WINDOW` — overrides the model's default (4096) when the
 *     engine loads. Halving it roughly halves the KV-cache VRAM, which is what
 *     pushes a weak iGPU over its memory ceiling. 2048 comfortably holds the
 *     compact local prompt + a normal message + a few turns + the reply.
 *   • `MAX_LOCAL_TOKENS` — caps the reply so input+output stay inside the
 *     window (no context-window sliding, which is itself GPU-heavy), and means
 *     fewer per-token logit readbacks (each is a GPU `mapAsync`).
 *   • `MAX_LOCAL_HISTORY_TURNS` — only recent turns are sent; the live message
 *     already rides in the system prompt, so older turns add cost without signal.
 */
const LOCAL_CONTEXT_WINDOW = 2048;
const MAX_LOCAL_TOKENS = 768;
const MAX_LOCAL_HISTORY_TURNS = 8;

/**
 * Self-heal budget for intermittent GPU device-losses.
 *
 * On a marginal integrated GPU (e.g. AMD Vega on a memory-tight laptop) the
 * driver intermittently resets the device mid-reply — "sometimes works,
 * sometimes crashes". Because it *usually* works, reloading the model in a fresh
 * worker and trying again almost always succeeds, so we do that automatically
 * once per send (the engine is torn down on failure, so the retry spins up a
 * clean worker + device — this is safe in a way the old in-page retry storm was
 * not). `gpuFailureStreak` caps consecutive auto-heals across sends: if the GPU
 * keeps resetting (a genuinely overloaded machine), we stop retrying — rather
 * than risk Chrome's "GPU crashed too often" browser-wide guard — and surface
 * the message so the user can drop to a smaller model or a cloud provider. A
 * successful generation resets the streak.
 */
const MAX_GPU_AUTOHEAL_STREAK = 3;
let gpuFailureStreak = 0;

/** Internal: a run result that also says whether a fresh-worker retry might help. */
type LocalRunResult = AiCallResult & { gpuRetryable?: boolean };

/**
/**
 * Pause between streamed tokens. The worker generates one token per `next()`,
 * so this gap is what stops the GPU running flat-out at 100%: during the gap the
 * GPU is idle (no forward pass queued) and the page paints the partial reply. On
 * a weak shared iGPU, keeping the GPU below saturation is what avoids the driver
 * watchdog reset. ~35 ms ≈ 25 tokens/s — plenty fast for short chat replies, and
 * `setTimeout` (unlike requestAnimationFrame) keeps progressing in a backgrounded
 * tab so generation never stalls.
 */
const LOCAL_TOKEN_GAP_MS = 35;

export async function callLocal(
  settings: AiSettings,
  system: string,
  turns: AiTurn[],
  signal?: AbortSignal,
  onProgress?: (p: LocalLoadProgress) => void,
  onToken?: (textSoFar: string) => void,
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
    // One automatic self-heal: an intermittent GPU device-loss usually clears on
    // a fresh-worker reload. `runOnce` tears the engine down on failure, so the
    // retry starts clean. Bounded to one retry per send, and capped across the
    // session by `gpuFailureStreak` so a truly overloaded GPU can't spiral.
    for (let attempt = 0; ; attempt++) {
      const result = await runOnce(modelId, system, turns, signal, onProgress, onToken);
      if (result.ok) {
        gpuFailureStreak = 0;
        return result;
      }
      const canSelfHeal =
        result.gpuRetryable === true &&
        attempt < 1 &&
        gpuFailureStreak < MAX_GPU_AUTOHEAL_STREAK &&
        !signal?.aborted;
      if (!canSelfHeal) return result;
      gpuFailureStreak++;
      // The engine was already torn down in runOnce; give the driver a moment to
      // settle after the reset before reloading in a fresh worker.
      await delay(1500);
    }
  } finally {
    release();
  }
}

/**
 * Load the model (if needed) and generate one reply.
 *
 * On any failure we drop the cached engine: a load failure may leave a
 * half-initialized engine, and a generate failure on a GPU reset leaves the
 * engine's device dead. Either way the next attempt must start fresh. GPU
 * device-loss / soft errors are flagged `gpuRetryable` so the caller can do one
 * bounded self-heal (see `callLocal`); this function itself never retries.
 */
async function runOnce(
  modelId: string,
  system: string,
  turns: AiTurn[],
  signal: AbortSignal | undefined,
  onProgress: ((p: LocalLoadProgress) => void) | undefined,
  onToken: ((textSoFar: string) => void) | undefined,
): Promise<LocalRunResult> {
  if (signal?.aborted) return { ok: false, error: "Request cancelled." };

  let activeEngine: WebWorkerMLCEngine;
  try {
    activeEngine = await ensureEngine(modelId, onProgress);
  } catch (e) {
    await resetEngine();
    const message = e instanceof Error ? e.message : String(e);
    const gpuRetryable = isGpuResetError(message) || isSoftGpuError(message);
    return { ok: false, error: explainEngineLoadError(modelId, message), gpuRetryable };
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
    const recentTurns =
      turns.length > MAX_LOCAL_HISTORY_TURNS ? turns.slice(-MAX_LOCAL_HISTORY_TURNS) : turns;
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...recentTurns.map((t) => ({ role: t.role, content: t.content })),
    ];
    // Stream the reply, exactly like chat.webllm.ai. The streaming path is the
    // well-exercised one in the worker engine; the one-shot non-streaming call
    // is where this setup hit "Object has already been disposed" mid-reply.
    //
    // The worker generates tokens pull-style — one per `next()` — so the rate is
    // set by how fast we ask for the next one. We emit each partial reply
    // (`onToken`) and then pause ~35 ms (`LOCAL_TOKEN_GAP_MS`): the page paints
    // the live text and, crucially, the GPU sits idle in the gap instead of
    // running flat out at 100%. On a weak shared iGPU that breather is what keeps
    // it under the driver's watchdog and away from the device-reset edge. We
    // still return the whole text so payload parsing is unchanged.
    //
    // No `stream_options.include_usage`: we never show token counts, and that
    // final usage chunk is one more end-of-stream GPU readback we don't need.
    const stream = await activeEngine.chat.completions.create({
      messages,
      temperature: 0.4,
      max_tokens: MAX_LOCAL_TOKENS,
      stream: true,
    });

    let text = "";
    for await (const chunk of stream) {
      if (signal?.aborted) return { ok: false, error: "Request cancelled." };
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        text += delta;
        onToken?.(text);
        await delay(LOCAL_TOKEN_GAP_MS);
      }
    }
    if (signal?.aborted) return { ok: false, error: "Request cancelled." };

    if (text.length === 0) {
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
      return { ok: false, error: gpuResetMessage(modelId, message), gpuRetryable: true };
    }
    if (isSoftGpuError(message)) {
      return { ok: false, error: softGlitchMessage(modelId, message), gpuRetryable: true };
    }
    return { ok: false, error: `Local model error: ${message}` };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
