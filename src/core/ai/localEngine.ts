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
    id: "SmolLM2-360M-Instruct-q4f16_1-MLC",
    label: "SmolLM2 360M — tiniest",
    sizeMB: 217,
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

export function isLocalModelKnown(id: string): boolean {
  return LOCAL_MODELS.some((m) => m.id === id);
}

/** Cheap synchronous check — the user-facing form uses this to warn early. */
export function isWebGpuSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

// ── Engine singleton ────────────────────────────────────────────────────────
// One engine per page lifetime; reloading swaps models on the same instance.
let enginePromise: Promise<MLCEngine> | null = null;
let currentModelId: string | null = null;

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

  // Different model: release the previous one so we don't keep two sets of
  // weights resident on the GPU.
  if (enginePromise) {
    try {
      const oldEngine = await enginePromise;
      await oldEngine.unload();
    } catch {
      // The old engine may have failed to load — ignore.
    }
  }

  currentModelId = modelId;
  enginePromise = (async () => {
    const webllm = await import("@mlc-ai/web-llm");
    return webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (report: InitProgressReport) => {
        onProgress?.({ text: report.text, progress: report.progress });
      },
    });
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
  if (!isWebGpuSupported()) {
    return {
      ok: false,
      error:
        "Your browser doesn't support WebGPU, which is required to run AI locally. " +
        "Try the latest Chrome or Edge (desktop), or Safari 17.4+. " +
        "On Firefox you may need to enable WebGPU under about:config (dom.webgpu.enabled).",
    };
  }

  const modelId = settings.model.trim() || DEFAULT_LOCAL_MODEL;

  let engine: MLCEngine;
  try {
    engine = await getEngine(modelId, onProgress);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error:
        `Couldn't load the local model "${modelId}".\n\n${message}\n\n` +
        "Make sure the model id is one of WebLLM's prebuilt ids and that your device has enough memory.",
    };
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
    return { ok: false, error: `Local model error: ${message}` };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
